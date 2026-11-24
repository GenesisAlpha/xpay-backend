import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { randomUUID } from 'crypto'
import { supabase } from '../lib/supabase.client'
import { StorageService } from '../lib/storage.service'
import { onboardingFeeRow } from '../shared/fee.calculator'
import {
  CADASTRO_VERSAO,
  type CadastroGuardado,
  type ContaKontinoResumo,
  ErroCadastro,
  type EnvioCadastro,
  type EstadoCadastro,
  arquivosDoEnvio,
  chaveDaEmpresa,
  documentoDoEnvio,
  elegivel,
  estadoDoCadastro,
  prefixoArquivo,
  validarEnvio,
} from '../onboarding/cadastro-v2'
import { cadastroV2 } from '../orchestrator/kontino/kontino-aprovacao'
import { ErroKontino, kontinoConfigurado, linkDaContaKontino } from '../orchestrator/kontino/kontino'
import { KONTINO_BANCO_URL, estadoKontino } from '../orchestrator/kontino/kontino-seller'
import { KoopfyIntegrationService } from './koopfy-integration.service'
import { normalizeEmail, resolveAccountUserId } from './seller-accounts'

const MIME_ACEITOS = ['image/jpeg', 'image/png', 'application/pdf']
const LIMITE_ARQUIVO = 8 * 1024 * 1024

type SellerRow = {
  id: string
  user_id: string
  status: string | null
  config: Record<string, any> | null
  rejection_reason: string | null
  reviewed_at: string | null
}

export type ClienteDoSeller = { ip: string | null; userAgent: string | null }

/**
 * CADASTRO ÚNICO (ativação v2) visto pelo painel: estado, arquivos, envio e o
 * link para o seller concluir algo na Kontino. Regras em onboarding/cadastro-v2.ts;
 * a abertura da conta Kontino depois da aprovação em orchestrator/kontino/kontino-aprovacao.ts.
 */
@Injectable()
export class CadastroService {
  constructor(
    private readonly integration: KoopfyIntegrationService,
    private readonly storage: StorageService,
  ) {}

  private async sellerDoUsuario(userId: string): Promise<SellerRow | null> {
    const { data, error } = await supabase
      .from('seller_profiles')
      .select('id, user_id, status, config, rejection_reason, reviewed_at')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw new ServiceUnavailableException('Não foi possível ler a sua conta agora. Tente de novo.')
    return (data as SellerRow) ?? null
  }

  private async usuario(userId: string) {
    const { data } = await supabase.from('users').select('name, documents_completed').eq('id', userId).maybeSingle()
    return { nome: (data?.name as string) ?? null, documentosAntigos: !!data?.documents_completed }
  }

  private async eligivelPara(s: SellerRow | null, documentosAntigos: boolean): Promise<boolean> {
    const temCadastroV2 = !!cadastroV2(s?.config)
    // A consulta ao provedor externo só é necessária para conta antiga ainda não aprovada.
    let externo = false
    // Só o seller que ainda não está no cadastro único pode estar vendendo pelo provedor externo.
    if (s && !temCadastroV2 && s.status) {
      const ext: any = await this.integration.externalProviderStatus(s.id).catch(() => null)
      externo = Boolean(ext?.charging)
    }
    return elegivel({ temCadastroV2, sellerStatus: s?.status ?? null, documentosAntigosEnviados: documentosAntigos, provedorExternoCobrando: externo })
  }

  private async montar(email: string, userId: string | null): Promise<EstadoCadastro> {
    const s = userId ? await this.sellerDoUsuario(userId) : null
    const u = userId ? await this.usuario(userId) : { nome: null, documentosAntigos: false }
    const cad = cadastroV2(s?.config)
    let conta: ContaKontinoResumo = null
    // Conta Kontino de seller aprovado (cadastro único ou aprovado no fluxo antigo).
    // Pedido de conexão por e-mail: lido também antes da aprovação (o seller acompanha o titular).
    if (s && s.config?.kontino?.connection_id && (s.status === 'active' || s.config.kontino.por_email)) {
      const v = await estadoKontino(s.id)
      conta = v.account
        ? {
            status: v.account.status,
            connectionType: v.account.connectionType,
            requirements: v.account.requirements,
            verifying: v.account.verifying,
            errors: v.account.errors,
            byEmail: v.account.byEmail,
            inReview: v.account.inReview,
            emailMasked: v.account.emailMasked,
          }
        : null
    }
    return estadoDoCadastro({
      email,
      nome: u.nome,
      sellerStatus: s?.status ?? null,
      reviewedAt: s?.reviewed_at ?? null,
      rejectionReason: s?.rejection_reason ?? null,
      cadastro: cad,
      andamento: s?.config?.cadastro_kontino ?? null,
      conta,
      contaAtiva: !!s?.config?.kontino_account_id,
      configurado: kontinoConfigurado(),
      eligible: await this.eligivelPara(s, u.documentosAntigos),
      bankUrl: KONTINO_BANCO_URL,
    })
  }

  async estado(email: string, accountSellerId: string | null): Promise<EstadoCadastro> {
    const norm = normalizeEmail(email)
    if (!norm) throw new NotFoundException('Conta não encontrada.')
    const userId = await resolveAccountUserId(norm, accountSellerId)
    return this.montar(norm, userId)
  }

  /** Um arquivo do cadastro (documento, comprovante, selfie) no storage privado. */
  async arquivo(email: string, accountSellerId: string | null, body: { field?: unknown; name?: unknown; mime?: unknown; base64?: unknown }) {
    const mime = String(body?.mime ?? '')
    if (!MIME_ACEITOS.includes(mime)) throw new BadRequestException('Envie JPG, PNG ou PDF.')
    const base64 = String(body?.base64 ?? '').replace(/^data:[^,]+,/, '')
    if (!base64) throw new BadRequestException('Arquivo vazio.')
    const tamanho = Buffer.byteLength(base64, 'base64')
    if (tamanho > LIMITE_ARQUIVO) throw new BadRequestException('Arquivo muito grande. Máximo 8 MB.')
    const { userId } = await this.integration.sellerForConnection(email, accountSellerId)
    const id = await this.storage.uploadDocument({ userId, field: `cadastro-${randomUUID()}`, base64, mime })
    return { id, name: String(body?.name ?? '').slice(0, 200) || 'arquivo', mime, size: tamanho }
  }

  async enviar(email: string, accountSellerId: string | null, body: unknown, cliente: ClienteDoSeller): Promise<EstadoCadastro> {
    const { sellerId, userId } = await this.integration.sellerForConnection(email, accountSellerId)
    const s = await this.sellerDoUsuario(userId)
    if (!s) throw new NotFoundException('Conta não encontrada.')
    if (s.status === 'active') throw new ConflictException('Sua conta já está aprovada.')
    if (s.status === 'suspended') throw new ForbiddenException('Sua conta está suspensa. Fale com o suporte.')
    const u = await this.usuario(userId)
    if (!(await this.eligivelPara(s, u.documentosAntigos))) {
      throw new ConflictException('Seu cadastro anterior já está em análise. Aguarde a resposta da equipe.')
    }

    let envio
    try {
      envio = validarEnvio(body, userId)
    } catch (e) {
      if (e instanceof ErroCadastro) throw new BadRequestException({ message: e.message, field: e.field })
      throw e
    }
    // Arquivo que não está no storage seria descoberto só na aprovação.
    for (const a of arquivosDoEnvio(envio)) {
      if (!a.id.startsWith(prefixoArquivo(userId)) || !(await this.storage.getSignedDocumentUrl(a.id, 60))) {
        throw new BadRequestException({ message: 'Envie este arquivo de novo.', field: a.campo })
      }
    }

    // Fila de análise do CRM: mesmas tabelas do fluxo antigo (operação, ofertas, taxas, status).
    const { data: existentes } = await supabase.from('offers').select('sales_page_url').eq('seller_id', sellerId)
    const jaTem = new Set((existentes ?? []).map((o: any) => String(o.sales_page_url ?? '').trim()))
    const novas = envio.operation.offers.filter((o) => !jaTem.has(o.url))
    await this.filaDeAnalise(userId, sellerId, envio, novas)

    const agora = new Date().toISOString()
    const guardado: CadastroGuardado = {
      version: CADASTRO_VERSAO,
      submitted_at: agora,
      envio,
      aceite: {
        accepted_at: agora,
        ip_address: String(cliente.ip ?? '').slice(0, 64),
        user_agent: String(cliente.userAgent ?? '').slice(0, 1000),
      },
    }
    // Relê o config: outra escrita (ex.: conexão Kontino) pode ter entrado no meio.
    const atual = (await this.sellerDoUsuario(userId))?.config ?? s.config ?? {}
    const config: Record<string, any> = { ...atual, cadastro: guardado, cadastro_chave: chaveDaEmpresa(envio.country, documentoDoEnvio(envio)) }
    delete config.cadastro_kontino
    const { error } = await supabase.from('seller_profiles').update({ config }).eq('id', sellerId)
    if (error) {
      console.error('[cadastro] guardar:', error.message)
      throw new ServiceUnavailableException('Não foi possível enviar o cadastro agora. Tente de novo.')
    }
    return this.montar(normalizeEmail(email), userId)
  }

  /**
   * Fila de análise do CRM: grava o que o fluxo antigo gravava (operação,
   * ofertas, taxas padrão, status "em análise"), para o CRM aprovar como hoje.
   */
  private async filaDeAnalise(userId: string, sellerId: string, envio: EnvioCadastro, novas: Array<{ name: string; url: string }>) {
    const agora = new Date().toISOString()
    const falhou = (onde: string, e: { message?: string } | null) => {
      if (!e) return
      console.error(`[cadastro] ${onde}:`, e.message)
      throw new ServiceUnavailableException('Não foi possível enviar o cadastro agora. Tente de novo.')
    }
    falhou('operation_config', (await supabase.from('operation_config').upsert({
      user_id: userId,
      description: `${envio.operation.description}\n\nCategoria: ${envio.operation.category} · Canais: ${envio.operation.channels.join(', ')}`,
      overall_risk_level: 'WHITE',
      terms_accepted: true,
      terms_accepted_at: agora,
      updated_at: agora,
    }, { onConflict: 'user_id' })).error)
    falhou('seller_profiles', (await supabase.from('seller_profiles').update({
      enabled_methods: [],
      risk_level: 'WHITE',
      status: 'pending_review',
    }).eq('id', sellerId)).error)
    if (novas.length) {
      falhou('offers', (await supabase.from('offers').insert(novas.map((o) => ({
        user_id: userId,
        seller_id: sellerId,
        name: o.name,
        sales_page_url: o.url,
        risk_level: 'WHITE',
        status: 'pending_review',
        created_at: agora,
      })))).error)
    }
    const { data: taxas } = await supabase
      .from('seller_fees')
      .select('checkout_fee_pct, checkout_fee_source, checkout_fee_updated_at')
      .eq('seller_id', sellerId)
      .maybeSingle()
    falhou('seller_fees', (await supabase.from('seller_fees').upsert({
      seller_id: sellerId,
      risk_level: 'WHITE',
      ...onboardingFeeRow(taxas),
      anticipation_days: 0,
      updated_at: agora,
    }, { onConflict: 'seller_id' })).error)
    falhou('users', (await supabase.from('users').update({
      kyc_completed: true,
      operation_setup_completed: true,
      documents_completed: true,
      onboarding_completed: false,
    }).eq('id', userId)).error)
  }

  /** Link para o seller autorizar a conexão, aceitar os termos ou responder à Kontino. */
  async linkKontino(email: string, accountSellerId: string | null, body: { returnUrl?: unknown }) {
    const norm = normalizeEmail(email)
    const userId = norm ? await resolveAccountUserId(norm, accountSellerId) : null
    const s = userId ? await this.sellerDoUsuario(userId) : null
    const conexao: string | undefined = s?.config?.kontino?.connection_id
    if (!s || !conexao) throw new ConflictException('Sua conta Kontino ainda está sendo aberta. Tente de novo em instantes.')
    const retorno = typeof body?.returnUrl === 'string' && /^https:\/\//.test(body.returnUrl) ? body.returnUrl : null
    try {
      const link = await linkDaContaKontino(conexao, retorno)
      return { url: link.url, expiresAt: link.expires_at }
    } catch (e) {
      if (e instanceof ErroKontino && e.status >= 400 && e.status < 500) throw new ConflictException(e.message)
      throw new ServiceUnavailableException('A Kontino não respondeu agora. Tente de novo em instantes.')
    }
  }
}
