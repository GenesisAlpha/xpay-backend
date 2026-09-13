import { Injectable, BadRequestException } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { getSellerFees, calculateFees } from '../shared/fee.calculator'
import { StorageService } from '../lib/storage.service'
import { DocumentsDto } from './onboarding.dto'

// ─── Todos os métodos disponíveis na plataforma ───────────────────────────────
// O seller seleciona quais quer no onboarding.
// A equipe aprova/nega cada um na revisão.

export const AVAILABLE_METHODS = [
  'credit_card', 'debit_card', 'pix', 'mbway', 'multibanco',
  'paypal', 'apple_pay', 'google_pay', 'boleto', 'sepa',
  'ideal', 'bancontact', 'blik', 'twint', 'klarna',
  'afterpay', 'affirm', 'alipay', 'wechat', 'mercadopago',
  'revolut_pay', 'mobilepay', 'p24', 'eps', 'giropay',
  'spei', 'oxxo', 'pse', 'nequi', 'daviplata', 'khipu',
  'webpay', 'rapipago', 'pagofacil', 'bank_transfer',
] as const

const FEE_TABLE = {
  WHITE: { fee_percentage: 9.99,  fee_fixed_usd: 0.59, settlement_days: 3, reserve_percentage: 10.00, reserve_hold_days: 90, anticipation_fee_pct: 4.99, anticipation_days: 0 },
  GRAY:  { fee_percentage: 14.99, fee_fixed_usd: 0.59, settlement_days: 3, reserve_percentage: 10.00, reserve_hold_days: 90, anticipation_fee_pct: 4.99, anticipation_days: 0 },
} as const

@Injectable()
export class OnboardingService {

  constructor(private readonly storageService: StorageService) {}

  // =========================================
  // KYC
  // =========================================
  async saveKyc(userId: string, dto: {
    fullName: string; cpf: string; birthDate: string
    cep: string; street: string; number: string
    complement?: string; neighborhood: string; city: string; state: string
  }) {
    const cpfClean = dto.cpf.replace(/\D/g, '')
    if (cpfClean.length !== 11) throw new BadRequestException('CPF inválido.')
    if (!this.isValidCPF(cpfClean)) throw new BadRequestException('CPF inválido.')

    const { data: conflict } = await supabase
      .from('kyc_info').select('user_id').eq('cpf', cpfClean).neq('user_id', userId).maybeSingle()
    if (conflict) throw new BadRequestException('Este CPF já está cadastrado em outra conta.')

    const { error } = await supabase.from('kyc_info').upsert({
      user_id: userId, full_name: dto.fullName, cpf: cpfClean,
      birth_date: dto.birthDate, cep: dto.cep.replace(/\D/g, ''),
      street: dto.street, number: dto.number, complement: dto.complement ?? null,
      neighborhood: dto.neighborhood, city: dto.city, state: dto.state.toUpperCase(),
      review_status: 'pending', updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

    if (error) throw new BadRequestException('Erro ao salvar dados: ' + error.message)

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
    const fees = FEE_TABLE[dto.overallRiskLevel]
    await supabase.from('seller_fees').upsert({
      seller_id:            sellerProfile.id,
      risk_level:           dto.overallRiskLevel,
      fee_percentage:       fees.fee_percentage,
      fee_fixed_usd:        fees.fee_fixed_usd,
      settlement_days:      fees.settlement_days,
      reserve_percentage:   fees.reserve_percentage,
      reserve_hold_days:    fees.reserve_hold_days,
      anticipation_fee_pct: fees.anticipation_fee_pct,
      anticipation_days:    fees.anticipation_days,
      updated_at:           new Date().toISOString(),
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
    if (dto.companyType === 'BR') {
      if (!dto.contratoSocial) throw new BadRequestException('Contrato social é obrigatório.')
      if (!dto.cartaoCnpj)     throw new BadRequestException('Cartão CNPJ é obrigatório.')
    } else {
      if (!dto.einDocument)    throw new BadRequestException('Documento EIN é obrigatório.')
    }
    if (!dto.identityDocument) throw new BadRequestException('Documento de identidade é obrigatório.')
    if (!dto.proofOfResidence) throw new BadRequestException('Comprovante de residência é obrigatório.')

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
    ] = await Promise.all([
      upload('contrato_social', dto.contratoSocial),
      upload('cartao_cnpj', dto.cartaoCnpj),
      upload('ein_document', dto.einDocument),
      upload('identity_document', dto.identityDocument),
      upload('proof_of_residence', dto.proofOfResidence),
    ])

    // ─── 3. Upsert em seller_documents (onConflict user_id) ────────────────────
    const { error } = await supabase.from('seller_documents').upsert({
      user_id:                 userId,
      company_type:            dto.companyType,
      contrato_social_path:    contratoSocialPath,
      cartao_cnpj_path:        cartaoCnpjPath,
      ein_document_path:       einDocumentPath,
      identity_document_path:  identityDocumentPath,
      proof_of_residence_path: proofOfResidencePath,
      review_status:           'pending',
      submitted_at:            new Date().toISOString(),
      updated_at:              new Date().toISOString(),
    }, { onConflict: 'user_id' })

    if (error) throw new BadRequestException('Erro ao salvar documentos: ' + error.message)

    // ─── 4. Marca etapa como concluída ─────────────────────────────────────────
    await supabase.from('users').update({ documents_completed: true }).eq('id', userId)

    return {
      message:    'Documentos enviados! Nossa equipe fará a análise.',
      redirectTo: '/onboarding/pending',
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