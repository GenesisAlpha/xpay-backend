import { Injectable, BadRequestException } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { onboardingFeeRow } from '../shared/fee.calculator'
import { StorageService } from '../lib/storage.service'
import { DocumentsDto, RequirementsDto } from './onboarding.dto'
import { ActivationRequestsService } from '../activation/activation-requests.service'
import { WhopConnectService } from '../orchestrator/whop/whop-connect.service'
import { rfiRequirementsForKeys } from '../orchestrator/whop/whop-connected'

// ─── Todos os métodos disponíveis na plataforma ───────────────────────────────
// O seller seleciona quais quer no onboarding.
// A equipe aprova/nega cada um na revisão.

export const AVAILABLE_METHODS = [
  'credit_card', 'debit_card', 'pix', 'mbway', 'multibanco',
  'paypal', 'apple_pay', 'google_pay', 'boleto', 'sepa',
  'ideal', 'bancontact', 'blik', 'twint', 'klarna',
  'afterpay', 'affirm', 'alipay', 'wechat', 'mercadopago',
  'revolut_pay', 'mobilepay', 'p24', 'eps', 'giropay',
  'spei', 'transfers_ar', 'oxxo', 'pse', 'nequi', 'daviplata', 'khipu',
  'webpay', 'rapipago', 'pagofacil', 'bank_transfer',
] as const


// Formatos da verificação da Whop: documento em JPEG/PNG/PDF e selfie só
// JPEG/PNG. O storage aceita WebP, a Whop não — recusar aqui evita um seller
// aprovado que não consegue ter conta conectada.
const WHOP_DOC_MIME = ['image/jpeg', 'image/png', 'application/pdf']
const WHOP_SELFIE_MIME = ['image/jpeg', 'image/png']

@Injectable()
export class OnboardingService {

  constructor(
    private readonly storageService: StorageService,
    private readonly activationRequests: ActivationRequestsService,
    private readonly whopConnect: WhopConnectService,
  ) {}

  // =========================================
  // KYC
  // =========================================
  async saveKyc(userId: string, dto: {
    fullName: string; cpf: string; birthDate: string
    cep: string; street: string; number: string
    complement?: string; neighborhood: string; city: string; state: string
    phone?: string
  }) {
    const cpfClean = dto.cpf.replace(/\D/g, '')
    if (cpfClean.length !== 11) throw new BadRequestException('CPF inválido.')
    if (!this.isValidCPF(cpfClean)) throw new BadRequestException('CPF inválido.')

    // Sem trava de CPF único por enquanto: a mesma pessoa pode ser responsável
    // por mais de uma empresa. A unicidade deve migrar para o CNPJ/EIN.

    const { error } = await supabase.from('kyc_info').upsert({
      user_id: userId, full_name: dto.fullName, cpf: cpfClean,
      birth_date: dto.birthDate, cep: dto.cep.replace(/\D/g, ''),
      street: dto.street, number: dto.number, complement: dto.complement ?? null,
      neighborhood: dto.neighborhood, city: dto.city, state: dto.state.toUpperCase(),
      // Só grava quando veio: um reenvio do formulário antigo (sem telefone)
      // não apaga o que a verificação da Whop precisa.
      ...(dto.phone ? { phone: dto.phone } : {}),
      review_status: 'pending', updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

    // A mensagem do 400 chega ao seller pelo checkout: detalhe do banco só no log.
    if (error) {
      console.error('[onboarding] saveKyc:', error)
      throw new BadRequestException('Não foi possível salvar seus dados agora. Tente novamente.')
    }

    await supabase.from('users').update({ kyc_completed: true }).eq('id', userId)

    return { message: 'Dados salvos com sucesso' }
  }

  // =========================================
  // OPERATION — descrição, risco e ofertas
  // =========================================
  async saveOperation(userId: string, dto: {
    description: string
    overallRiskLevel: 'WHITE' | 'GRAY'
    termsAccepted: boolean
    offers: Array<{
      name: string; salesPageUrl: string; riskLevel: 'WHITE' | 'GRAY'
    }>
  }) {
    if (!dto.termsAccepted) throw new BadRequestException('Aceite os termos para continuar.')

    const validOffers = dto.offers.filter(o => o.name?.trim() && o.salesPageUrl?.trim())
    if (validOffers.length === 0) throw new BadRequestException('Adicione pelo menos uma oferta.')

    for (const offer of validOffers) {
      try { new URL(offer.salesPageUrl) } catch {
        throw new BadRequestException(`URL inválida: ${offer.salesPageUrl}`)
      }
    }


    // ─── 1. Resolve seller_id ──────────────────────────────────────────────────
    const { data: sellerProfile } = await supabase
      .from('seller_profiles').select('id').eq('user_id', userId).single()
    if (!sellerProfile) throw new BadRequestException('Perfil não encontrado.')

    // ─── 2. Salva operation_config ─────────────────────────────────────────────
    await supabase.from('operation_config').upsert({
      user_id: userId, description: dto.description,
      overall_risk_level: dto.overallRiskLevel,
      terms_accepted: true, terms_accepted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

    // ─── 3. Salva os métodos solicitados no seller_profile ─────────────────────
    //    enabled_methods   = [] (vazio até a equipe aprovar)
    await supabase.from('seller_profiles').update({
      enabled_methods:   [],                    // definido pela equipe na aprovação
      risk_level:        dto.overallRiskLevel,
      status:            'pending_review',      // 🔥 aguarda aprovação da equipe
    }).eq('id', sellerProfile.id)

    // ─── 4. Insere ofertas vinculadas ao seller ────────────────────────────────
    await supabase.from('offers').insert(
      validOffers.map(o => ({
        user_id:        userId,
        seller_id:      sellerProfile.id,
        name:           o.name.trim(),
        sales_page_url: o.salesPageUrl.trim(),
        risk_level:     o.riskLevel,
        status:         'pending_review',
        created_at:     new Date().toISOString(),
      }))
    )

    // ─── 5. Provisiona seller_fees (tarifas por risco) ─────────────────────────
    // Tarifa padrão; o CRM confirma ou ajusta na aprovação.
    // Seller novo nasce com a taxa de checkout do plano gratuito (origem
    // 'plan'); quem já tinha linha mantém a taxa e a origem que tinha.
    const { data: existingFees } = await supabase
      .from('seller_fees')
      .select('checkout_fee_pct, checkout_fee_source, checkout_fee_updated_at')
      .eq('seller_id', sellerProfile.id)
      .maybeSingle()
    await supabase.from('seller_fees').upsert({
      seller_id:         sellerProfile.id,
      risk_level:        dto.overallRiskLevel,
      ...onboardingFeeRow(existingFees),
      anticipation_days: 0,
      updated_at:        new Date().toISOString(),
    }, { onConflict: 'seller_id' })

    // ─── 6. Marca onboarding como "submetido" ──────────────────────────────────
    //    NÃO marca onboarding_completed = true ainda
    //    Isso só acontece quando a equipe aprovar via admin
    await supabase.from('users').update({
      operation_setup_completed: true,
      onboarding_completed:      false,  // 🔥 false até aprovação
    }).eq('id', userId)

    return {
      message:    'Cadastro enviado! Nossa equipe analisará em até 48h úteis.',
      redirectTo: '/onboarding/pending',  // 🔥 página de aguardando aprovação
    }
  }

  // =========================================
  // DOCUMENTOS
  // =========================================
  async saveDocuments(userId: string, dto: DocumentsDto) {
    // ─── 1. Valida obrigatórios por tipo de empresa ────────────────────────────
    // LLC americana é o padrão (conta conectada na Whop). CNPJ só com a
    // ativação liberada no CRM: vende pela conta master, e a Whop não verifica
    // empresa brasileira.
    if (dto.companyType === 'BR') {
      if (!(await this.activationRequests.isCnpjAllowed(userId))) {
        throw new BadRequestException(
          'O cadastro com CNPJ precisa de liberação da nossa equipe. Solicite a ativação por CNPJ nesta etapa.',
        )
      }
      if (!dto.contratoSocial)   throw new BadRequestException('Contrato social é obrigatório.')
      if (!dto.cartaoCnpj)       throw new BadRequestException('Cartão CNPJ é obrigatório.')
      if (!dto.identityDocument) throw new BadRequestException('Documento de identidade é obrigatório.')
    } else {
      if (!dto.companyLegalName?.trim())  throw new BadRequestException('Razão social da LLC é obrigatória.')
      if (!dto.companyEin)                throw new BadRequestException('EIN é obrigatório.')
      if (!dto.companyStructure)          throw new BadRequestException('Informe se a LLC tem um ou mais sócios.')
      if (!dto.companyFormationState)     throw new BadRequestException('Estado de abertura da LLC é obrigatório.')
      if (!dto.companyAddressLine1?.trim() || !dto.companyCity?.trim() || !dto.companyState || !dto.companyPostalCode) {
        throw new BadRequestException('Endereço da LLC nos EUA é obrigatório.')
      }
      if (!dto.einDocument)               throw new BadRequestException('Carta do EIN é obrigatória.')
      if (!dto.articlesOfOrganization)    throw new BadRequestException('Articles of Organization é obrigatório.')
      if (!dto.identityDocumentType || !dto.identityFront) {
        throw new BadRequestException('Frente do documento de identidade é obrigatória.')
      }
      if (dto.identityDocumentType !== 'PASSPORT' && !dto.identityBack) {
        throw new BadRequestException('Verso do documento de identidade é obrigatório.')
      }
      if (!dto.selfie)                    throw new BadRequestException('Selfie é obrigatória.')
    }
    if (!dto.proofOfResidence) throw new BadRequestException('Comprovante de residência é obrigatório.')

    if (dto.identityFront && !WHOP_DOC_MIME.includes(dto.identityFront.mime)) {
      throw new BadRequestException('Frente do documento deve ser JPEG, PNG ou PDF.')
    }
    if (dto.identityBack && !WHOP_DOC_MIME.includes(dto.identityBack.mime)) {
      throw new BadRequestException('Verso do documento deve ser JPEG, PNG ou PDF.')
    }
    if (dto.selfie && !WHOP_SELFIE_MIME.includes(dto.selfie.mime)) {
      throw new BadRequestException('Selfie deve ser JPEG ou PNG.')
    }

    // ─── 2. Upload de cada arquivo presente → retorna o path ───────────────────
    const upload = (field: string, file?: { base64: string; mime: string }) =>
      file
        ? this.storageService.uploadDocument({ userId, field, base64: file.base64, mime: file.mime })
        : Promise.resolve(null)

    const [
      contratoSocialPath,
      cartaoCnpjPath,
      einDocumentPath,
      identityDocumentPath,
      proofOfResidencePath,
      identityFrontPath,
      identityBackPath,
      selfiePath,
      articlesPath,
      operatingAgreementPath,
    ] = await Promise.all([
      upload('contrato_social', dto.contratoSocial),
      upload('cartao_cnpj', dto.cartaoCnpj),
      upload('ein_document', dto.einDocument),
      upload('identity_document', dto.identityDocument),
      upload('proof_of_residence', dto.proofOfResidence),
      upload('identity_front', dto.identityFront),
      upload('identity_back', dto.identityBack),
      upload('selfie', dto.selfie),
      upload('articles_of_organization', dto.articlesOfOrganization),
      upload('operating_agreement', dto.operatingAgreement),
    ])

    const einDigits = (dto.companyEin ?? '').replace(/\D/g, '')

    // ─── 3. Upsert em seller_documents (onConflict user_id) ────────────────────
    const { error } = await supabase.from('seller_documents').upsert({
      user_id:                 userId,
      company_type:            dto.companyType,
      contrato_social_path:    contratoSocialPath,
      cartao_cnpj_path:        cartaoCnpjPath,
      ein_document_path:       einDocumentPath,
      identity_document_path:  identityDocumentPath,
      proof_of_residence_path: proofOfResidencePath,
      ...(dto.companyType === 'US' ? {
        company_legal_name:            dto.companyLegalName!.trim(),
        company_ein:                   `${einDigits.slice(0, 2)}-${einDigits.slice(2)}`,
        company_structure:             dto.companyStructure,
        company_formation_state:       dto.companyFormationState,
        company_address: {
          line1:       dto.companyAddressLine1!.trim(),
          line2:       dto.companyAddressLine2?.trim() || null,
          city:        dto.companyCity!.trim(),
          state:       dto.companyState,
          postal_code: dto.companyPostalCode,
          country:     'US',
        },
        company_website:               dto.companyWebsite?.trim() || null,
        articles_of_organization_path: articlesPath,
        operating_agreement_path:      operatingAgreementPath,
      } : {}),
      // Campos da Whop só entram quando vieram: reenviar pelo formulário
      // antigo não apaga documento e selfie já enviados.
      ...(dto.identityDocumentType ? { identity_document_type: dto.identityDocumentType } : {}),
      ...(identityFrontPath ? { identity_front_path: identityFrontPath } : {}),
      ...(identityBackPath ? { identity_back_path: identityBackPath } : {}),
      ...(selfiePath ? { selfie_path: selfiePath } : {}),
      review_status:           'pending',
      submitted_at:            new Date().toISOString(),
      updated_at:              new Date().toISOString(),
    }, { onConflict: 'user_id' })

    if (error) {
      console.error('[onboarding] saveDocuments:', error)
      throw new BadRequestException('Não foi possível salvar os documentos agora. Tente novamente.')
    }

    // ─── 4. Marca etapa como concluída ─────────────────────────────────────────
    await supabase.from('users').update({ documents_completed: true }).eq('id', userId)

    return {
      message:    'Documentos enviados! Nossa equipe fará a análise.',
      redirectTo: '/onboarding/pending',
    }
  }

  // =========================================
  // PENDÊNCIAS (painel do seller)
  // =========================================
  // Corrige só o que falta — cadastro da LLC ou pedido da Whop — sem refazer
  // a etapa inteira. Depois de gravar, reenvia à Whop os pedidos ligados aos
  // campos que mudaram (inclusive os que ela recusou antes).
  async submitRequirements(userId: string, dto: RequirementsDto) {
    if (dto.identityFront && !WHOP_DOC_MIME.includes(dto.identityFront.mime)) {
      throw new BadRequestException('Frente do documento deve ser JPEG, PNG ou PDF.')
    }
    if (dto.identityBack && !WHOP_DOC_MIME.includes(dto.identityBack.mime)) {
      throw new BadRequestException('Verso do documento deve ser JPEG, PNG ou PDF.')
    }
    if (dto.selfie && !WHOP_SELFIE_MIME.includes(dto.selfie.mime)) {
      throw new BadRequestException('Selfie deve ser JPEG ou PNG.')
    }

    // Conta ativa aprovada antes do cadastro da LLC pode não ter a linha de
    // documentos (ou não ter o tipo de empresa): o que ela envia aqui é da LLC.
    const { data: current } = await supabase
      .from('seller_documents')
      .select('company_address, company_type')
      .eq('user_id', userId)
      .maybeSingle()
    // Conta com CNPJ vende pela master e não tem conta conectada. Ela só entra
    // aqui quando o seller pede para passar o cadastro para LLC.
    const switchingToLlc = current?.company_type === 'BR' && dto.switchToLlc === true
    if (current?.company_type === 'BR' && !switchingToLlc) {
      throw new BadRequestException('Contas com CNPJ vendem pela Koopfy e não precisam de conta conectada.')
    }

    const upload = (field: string, file?: { base64: string; mime: string }) =>
      file
        ? this.storageService.uploadDocument({ userId, field, base64: file.base64, mime: file.mime })
        : Promise.resolve(null)

    const [einDocumentPath, articlesPath, operatingAgreementPath, identityFrontPath, identityBackPath, selfiePath] =
      await Promise.all([
        upload('ein_document', dto.einDocument),
        upload('articles_of_organization', dto.articlesOfOrganization),
        upload('operating_agreement', dto.operatingAgreement),
        upload('identity_front', dto.identityFront),
        upload('identity_back', dto.identityBack),
        upload('selfie', dto.selfie),
      ])

    // `touched`: chaves das pendências corrigidas — decidem o que reenviar à Whop.
    const touched: string[] = []
    const patch: Record<string, any> = {}
    const set = (key: string, column: string, value: unknown) => {
      if (value === undefined || value === null || value === '') return
      patch[column] = value
      touched.push(key)
    }

    set('company_legal_name', 'company_legal_name', dto.companyLegalName?.trim())
    if (dto.companyEin) {
      const digits = dto.companyEin.replace(/\D/g, '')
      set('company_ein', 'company_ein', `${digits.slice(0, 2)}-${digits.slice(2)}`)
    }
    set('company_structure', 'company_structure', dto.companyStructure)
    set('company_formation_state', 'company_formation_state', dto.companyFormationState)
    if (dto.companyAddressLine1 || dto.companyCity || dto.companyState || dto.companyPostalCode) {
      // Endereço vem por partes: o que não veio fica como estava.
      const previous = current?.company_address ?? {}
      set('company_address', 'company_address', {
        line1: dto.companyAddressLine1?.trim() || previous.line1 || null,
        line2: dto.companyAddressLine2 !== undefined ? (dto.companyAddressLine2.trim() || null) : (previous.line2 ?? null),
        city: dto.companyCity?.trim() || previous.city || null,
        state: dto.companyState || previous.state || null,
        postal_code: dto.companyPostalCode || previous.postal_code || null,
        country: 'US',
      })
    }
    set('company_website', 'company_website', dto.companyWebsite?.trim())
    set('ein_document', 'ein_document_path', einDocumentPath)
    set('articles_of_organization', 'articles_of_organization_path', articlesPath)
    set('operating_agreement', 'operating_agreement_path', operatingAgreementPath)
    set('identity_document_type', 'identity_document_type', dto.identityDocumentType)
    set('identity_front', 'identity_front_path', identityFrontPath)
    set('identity_back', 'identity_back_path', identityBackPath)
    set('selfie', 'selfie_path', selfiePath)

    const now = new Date().toISOString()

    if (Object.keys(patch).length > 0 || switchingToLlc) {
      // Sem linha, sem tipo de empresa ou trocando de CNPJ: o cadastro vira LLC.
      const { error } = current
        ? await supabase
            .from('seller_documents')
            .update({
              ...patch,
              ...(current.company_type && !switchingToLlc ? {} : { company_type: 'US' }),
              updated_at: now,
            })
            .eq('user_id', userId)
        : await supabase
            .from('seller_documents')
            .insert({ user_id: userId, company_type: 'US', ...patch, updated_at: now })
      if (error) {
        console.error('[onboarding] submitRequirements documents:', error)
        throw new BadRequestException('Não foi possível salvar as pendências agora. Tente novamente.')
      }
    }

    if (dto.phone) {
      const { error } = await supabase.from('kyc_info').update({ phone: dto.phone, updated_at: now }).eq('user_id', userId)
      if (error) {
        console.error('[onboarding] submitRequirements phone:', error)
        throw new BadRequestException('Não foi possível salvar o telefone agora. Tente novamente.')
      }
      touched.push('phone')
    }
    touched.push(...(dto.refresh ?? []))

    if (touched.length === 0 && !dto.rfi?.length && !switchingToLlc) {
      throw new BadRequestException('Preencha ao menos uma pendência antes de enviar.')
    }

    // Só LLC com verificação da Whop em andamento tem pedido para reenviar.
    const { data: seller } = await supabase.from('seller_profiles').select('id').eq('user_id', userId).maybeSingle()
    const row = seller ? await this.whopConnect.getRow(seller.id).catch(() => null) : null

    if (seller && row?.verification_id) {
      if (dto.rfi?.length) await this.whopConnect.submitDirectRfiAnswers(seller.id, dto.rfi)
      try {
        await this.whopConnect.answerRequestedInformation(seller.id, { retryRequirements: rfiRequirementsForKeys(touched) })
      } catch (err: any) {
        // O dado já está salvo; o reenvio roda de novo na próxima sincronização.
        console.error('[onboarding] submitRequirements reenvio à Whop:', err?.message)
      }
    }

    return {
      message: switchingToLlc
        ? 'Cadastro alterado para empresa americana (LLC). Envie os dados e documentos que faltam.'
        : 'Pendências enviadas. Avisaremos se faltar mais alguma coisa.',
    }
  }

  // =========================================
  // VALIDAÇÃO DE CPF
  // =========================================
  private isValidCPF(cpf: string): boolean {
    if (/^(\d)\1{10}$/.test(cpf)) return false
    const calc = (mod: number) => {
      const sum = cpf.slice(0, mod - 1).split('')
        .reduce((acc, d, i) => acc + parseInt(d) * (mod - i), 0)
      const rem = (sum * 10) % 11
      return rem >= 10 ? 0 : rem
    }
    return calc(10) === parseInt(cpf[9]) && calc(11) === parseInt(cpf[10])
  }
}
