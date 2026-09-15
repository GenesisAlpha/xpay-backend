import {
  Injectable, UnauthorizedException, NotFoundException,
  BadRequestException, ForbiddenException,
  HttpException, HttpStatus, ServiceUnavailableException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { supabase } from '../lib/supabase.client'
import { StorageService } from '../lib/storage.service'
import { CryptoService } from '../crypto/crypto.service'
import { WhopAccountsService } from '../orchestrator/whop/whop-accounts.service'
import { WhopProvider } from '../orchestrator/providers/whop.provider'
import { ClipAccountsService } from '../orchestrator/clip/clip-accounts.service'
import { WebhookService } from '../webhooks/webhook.service'
import { notifySellerAccount } from '../utils/seller-mail'
import { DEFAULT_FEE_SETTINGS, getSellerFees, sellerFeesRow, type FeeSettings } from '../shared/fee.calculator'
import { FEE_FIELDS, FEE_TOGGLES, feeChanges, parseFeeSettings } from './fee-config'
import * as bcrypt from 'bcrypt'
import { LoginAttemptLimiter } from './crm-login-limiter'
import { currentCrmRequest } from './crm-request-context'

const loginLimiter = new LoginAttemptLimiter()


// Provedores que o CRM pode atribuir. Sellers antigos com outro provider seguem
// funcionando, mas não recebem mais essas opções.
const VALID_PROVIDERS = ['whop', 'stripe'] as const
const DEFAULT_PROVIDER: ProviderDefault = 'whop'
type ProviderDefault = typeof VALID_PROVIDERS[number] | null

/** Hosts de WhatsApp aceitos no grupo da operação logística. */
const WHATSAPP_HOSTS = ['chat.whatsapp.com', 'wa.me', 'api.whatsapp.com', 'web.whatsapp.com']

// ─── Canal interno com o checkout ─────────────────────────────────────────────
//
// A esteira logística (produtos, fila, carteira do parceiro) vive no banco do
// CHECKOUT. O CRM é a TELA onde o gestor decide, mas não é o dono do dado —
// guardar aqui obrigaria o painel da DSB a uma chamada cross-service por linha.
//
// Por isso: o CRM grava lá, via segredo compartilhado.

const CHECKOUT_API_BASE = process.env.CHECKOUT_API_BASE ?? 'http://127.0.0.1:3006'
const CHECKOUT_INTERNAL_KEY = process.env.CHECKOUT_INTERNAL_KEY ?? ''

// Último motivo REAL de falha, para a tela não culpar a chave quando o problema
// é outro. O helper continua devolvendo null (as telas do CRM não podem cair
// quando o checkout oscila), mas agora dá pra dizer o que aconteceu.
let lastCheckoutFailure: string | null = null

/** Mensagem de erro que aponta a causa provável, não um palpite fixo. */
function checkoutFailureMessage(acao: string): string {
  const causa = lastCheckoutFailure ?? 'motivo desconhecido'
  return `Não foi possível ${acao}: ${causa} (checkout em ${CHECKOUT_API_BASE}).`
}

async function checkoutInternal<T>(path: string, body?: any): Promise<T | null> {
  if (!CHECKOUT_INTERNAL_KEY) {
    lastCheckoutFailure = 'CHECKOUT_INTERNAL_KEY não configurada no serviço de pagamentos'
    console.error('[CrmService] CHECKOUT_INTERNAL_KEY não configurada')
    return null
  }
  try {
    const res = await fetch(`${CHECKOUT_API_BASE}/internal/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': CHECKOUT_INTERNAL_KEY,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      const corpo = await res.text()
      lastCheckoutFailure = res.status === 401 || res.status === 403
        ? `o checkout recusou a chave interna (HTTP ${res.status}) — confira CHECKOUT_INTERNAL_KEY aqui e INTERNAL_API_KEY lá`
        : `o checkout respondeu HTTP ${res.status}`
      console.error(`[CrmService] checkout ${path}: ${res.status} ${corpo}`)
      return null
    }
    lastCheckoutFailure = null
    return (await res.json()) as T
  } catch (e: any) {
    // Falha de comunicação não pode derrubar a ficha do seller no CRM.
    const msg = String(e?.message ?? e)
    lastCheckoutFailure = /timeout|abort/i.test(msg)
      ? 'o checkout não respondeu a tempo (8s)'
      : `não foi possível conectar ao checkout (${msg})`
    console.error(`[CrmService] checkout ${path}:`, msg)
    return null
  }
}

/**
 * Valida e normaliza a URL do grupo logístico.
 *
 * Vazio/nulo → null (remove o vínculo). Qualquer outra coisa precisa ser uma
 * URL https de WhatsApp: a URL vai para o dash do seller, que a abre numa aba
 * nova — deixar passar um host arbitrário aqui viraria redirect aberto.
 */
function normalizeWhatsappUrl(raw?: string | null): string | null {
  const value = (raw ?? '').trim()
  if (!value) return null

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new BadRequestException('URL do grupo inválida.')
  }

  if (parsed.protocol !== 'https:') {
    throw new BadRequestException('A URL do grupo precisa ser https.')
  }

  const host = parsed.hostname.replace(/^www\./, '')
  if (!WHATSAPP_HOSTS.includes(host)) {
    throw new BadRequestException(
      `A URL do grupo precisa ser do WhatsApp (${WHATSAPP_HOSTS.join(', ')}).`,
    )
  }

  return parsed.toString()
}

@Injectable()
export class CrmService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly storageService: StorageService,
    private readonly crypto: CryptoService,
    private readonly whopAccounts: WhopAccountsService,
    private readonly clipAccounts: ClipAccountsService,
    private readonly webhookService: WebhookService,
  ) { }

  // =========================================
  // AUTH
  // =========================================

  async login(email: string, password: string, ip: string | null = null) {
    if (!process.env.CRM_JWT_SECRET) {
      throw new ServiceUnavailableException('Login do CRM indisponível: configuração ausente.')
    }

    // Força bruta: 5 erros por e-mail ou 20 por IP em 15 min bloqueiam o login.
    const normalizedEmail = String(email ?? '').trim().toLowerCase()
    const waitMs = loginLimiter.retryAfterMs(normalizedEmail, ip)
    if (waitMs > 0) {
      throw new HttpException(
        `Muitas tentativas de login. Tente de novo em ${Math.ceil(waitMs / 60_000)} min.`,
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
    const invalid = () => {
      loginLimiter.recordFailure(normalizedEmail, ip)
      return new UnauthorizedException('Credenciais inválidas')
    }
    if (!normalizedEmail || typeof password !== 'string' || !password) throw invalid()

    const { data: manager } = await supabase
      .from('crm_managers')
      .select('*')
      .eq('email', normalizedEmail)
      .eq('is_active', true)
      .maybeSingle()

    if (!manager) throw invalid()

    const valid = await bcrypt.compare(password, manager.password_hash)
    if (!valid) throw invalid()
    loginLimiter.reset(normalizedEmail)

    // 🔥 new Date() em vez de .toISOString() para campos timestamp
    await supabase.from('crm_managers')
      .update({ last_login_at: new Date() })
      .eq('id', manager.id)

    const token = this.jwtService.sign({
      sub: manager.id,
      email: manager.email,
      role: manager.role,
      name: manager.name,
    })

    return {
      accessToken: token,
      manager: {
        id: manager.id,
        name: manager.name,
        email: manager.email,
        role: manager.role,
        avatarUrl: manager.avatar_url,
      },
    }
  }

  async getMe(managerId: string) {
    const { data } = await supabase
      .from('crm_managers')
      .select('id, name, email, role, avatar_url, last_login_at')
      .eq('id', managerId)
      .single()

    if (!data) throw new NotFoundException('Gerente não encontrado')
    return data
  }

  // =========================================
  // DASHBOARD STATS
  // =========================================

  async getDashboardStats(managerId: string, role: string) {
    const isAdmin = ['admin', 'supervisor'].includes(role)

    const { data: statusCounts } = await supabase
      .from('seller_profiles')
      .select('status')

    const counts = { pending: 0, active: 0, rejected: 0, suspended: 0 }
    for (const s of statusCounts ?? []) {
      if (s.status === 'pending_review') counts.pending++
      else if (s.status in counts) counts[s.status as keyof typeof counts]++
    }

    let myQuery = supabase
      .from('crm_assignments')
      .select('seller_id', { count: 'exact' })
      .eq('status', 'active')
    if (!isAdmin) myQuery = myQuery.eq('manager_id', managerId)
    const { count: myCount } = await myQuery

    // 🔥 Corrigido: duas queries em vez de subquery inline
    const { data: assignedRows } = await supabase
      .from('crm_assignments')
      .select('seller_id')
      .eq('status', 'active')

    const assignedIds = (assignedRows ?? []).map(r => r.seller_id)

    let unassignedQuery = supabase
      .from('seller_profiles')
      .select('id', { count: 'exact' })
      .eq('status', 'pending_review')

    if (assignedIds.length > 0) {
      unassignedQuery = unassignedQuery.not('id', 'in', `(${assignedIds.join(',')})`)
    }

    const { count: unassigned } = await unassignedQuery

    // Contadores do menu de Administração (saques e chargebacks esperando ação).
    let adminCounts: { pendingWithdrawals?: number; openChargebacks?: number } = {}
    if (isAdmin) {
      const [withdrawals, chargebacks] = await Promise.all([
        supabase.from('wallet_ledger').select('id', { count: 'exact', head: true })
          .eq('type', 'debit_payout').eq('status', 'pending'),
        supabase.from('chargebacks').select('id', { count: 'exact', head: true })
          .in('status', ['open', 'evidence_required']),
      ])
      adminCounts = {
        pendingWithdrawals: withdrawals.count ?? 0,
        openChargebacks: chargebacks.count ?? 0,
      }
    }

    return { ...counts, myAssignments: myCount ?? 0, unassigned: unassigned ?? 0, ...adminCounts }
  }

  // =========================================
  // LISTAR SELLERS
  // =========================================

  async listSellers(params: {
    managerId: string
    role: string
    status?: string
    assignedToMe?: boolean
    unassigned?: boolean
    search?: string
    page?: number
    pageSize?: number
  }) {
    const { managerId, role, status, assignedToMe, unassigned, search, page = 1, pageSize = 20 } = params
    const from = (page - 1) * pageSize
    const isAdmin = ['admin', 'supervisor'].includes(role)

    let query = supabase
      .from('v_crm_sellers')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1)

    if (status && status !== 'all') query = query.eq('status', status)
    if (assignedToMe) query = query.eq('manager_id', managerId)
    if (unassigned) query = query.is('manager_id', null)
    if (!isAdmin && !assignedToMe && !unassigned) {
      query = query.or(`manager_id.eq.${managerId},manager_id.is.null`)
    }
    if (search) {
      query = query.or(
        `name.ilike.%${search}%,email.ilike.%${search}%,instagram.ilike.%${search}%,whatsapp.ilike.%${search}%`
      )
    }

    const { data, count, error } = await query
    if (error) throw new BadRequestException(error.message)

    return {
      data: data ?? [],
      total: count ?? 0,
      page,
      totalPages: Math.ceil((count ?? 0) / pageSize),
    }
  }

  // =========================================
  // DETALHE DO SELLER
  // =========================================

  async getSellerDetail(sellerId: string) {
    const { data: seller } = await supabase
      .from('v_crm_sellers')
      .select('*')
      .eq('seller_id', sellerId)
      .single()

    if (!seller) throw new NotFoundException('Seller não encontrado')

    // 🔥 Busca user_id separado para o KYC + provider_mid + config (não vem na view)
    const { data: sp } = await supabase
      .from('seller_profiles')
      .select('user_id, provider_mid, config')
      .eq('id', sellerId)
      .single()

    const [offersRes, feesRes, notesRes, logRes, kycRes, docsRes, activationRes] = await Promise.all([
      supabase.from('offers').select('*').eq('seller_id', sellerId).order('created_at', { ascending: false }),
      supabase.from('seller_fees').select('*').eq('seller_id', sellerId).maybeSingle(),
      supabase.from('crm_notes').select('*, crm_managers(name, avatar_url)').eq('seller_id', sellerId).order('is_pinned', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('crm_action_log').select('*, crm_managers(name)').eq('seller_id', sellerId).order('created_at', { ascending: false }).limit(50),
      sp?.user_id
        ? supabase.from('kyc_info').select('*').eq('user_id', sp.user_id).maybeSingle()
        : Promise.resolve({ data: null }),
      sp?.user_id
        ? supabase.from('seller_documents').select('*').eq('user_id', sp.user_id).maybeSingle()
        : Promise.resolve({ data: null }),
      // Solicitações de ativação (CNPJ / empresa americana) deste seller.
      sp?.user_id
        ? supabase.from('seller_activation_requests').select('*').eq('user_id', sp.user_id).order('created_at', { ascending: false })
        : Promise.resolve({ data: [] }),
    ])

    return {
      seller: {
        ...seller,
        provider_mid: sp?.provider_mid ?? null,
        // merchantId da Coinflow (guardado em config) — usado no dialog do CRM.
        coinflow_merchant_id: sp?.config?.coinflow_merchant_id ?? null,
        // Store Reference da Rox Pay (guardado em config) — usado no dialog do CRM.
        rox_pay_store_reference: sp?.config?.rox_pay_store_reference ?? null,
        // Grupo de WhatsApp da operação logística deste merchant — o dash do
        // seller usa no botão "Solicitar Homologação" da tela de Produtos.
        logistics_group_url: sp?.config?.logistics_group_url ?? null,
        logistics_partner: sp?.config?.logistics_partner ?? null,
      },
      offers: offersRes.data ?? [],
      fees: feesRes.data,
      notes: notesRes.data ?? [],
      log: logRes.data ?? [],
      kyc: kycRes.data,
      documents: await this.buildDocumentsPayload(docsRes.data),
      activation_requests: (activationRes as any).data ?? [],
    }
  }

  // Monta a resposta de documentos com signed URLs (bucket privado).
  private async buildDocumentsPayload(doc: any) {
    if (!doc) return null

    const [
      contrato_social_url,
      cartao_cnpj_url,
      ein_document_url,
      identity_document_url,
      proof_of_residence_url,
      articles_of_organization_url,
      operating_agreement_url,
      identity_front_url,
      identity_back_url,
      selfie_url,
    ] = await Promise.all([
      this.storageService.getSignedDocumentUrl(doc.contrato_social_path),
      this.storageService.getSignedDocumentUrl(doc.cartao_cnpj_path),
      this.storageService.getSignedDocumentUrl(doc.ein_document_path),
      this.storageService.getSignedDocumentUrl(doc.identity_document_path),
      this.storageService.getSignedDocumentUrl(doc.proof_of_residence_path),
      this.storageService.getSignedDocumentUrl(doc.articles_of_organization_path),
      this.storageService.getSignedDocumentUrl(doc.operating_agreement_path),
      this.storageService.getSignedDocumentUrl(doc.identity_front_path),
      this.storageService.getSignedDocumentUrl(doc.identity_back_path),
      this.storageService.getSignedDocumentUrl(doc.selfie_path),
    ])

    return {
      company_type:  doc.company_type,
      review_status: doc.review_status,
      submitted_at:  doc.submitted_at,
      contrato_social_url,
      cartao_cnpj_url,
      ein_document_url,
      identity_document_url,
      proof_of_residence_url,
      // LLC — dados e documentos da verificação de empresa na Whop
      company_legal_name:      doc.company_legal_name ?? null,
      company_ein:             doc.company_ein ?? null,
      company_structure:       doc.company_structure ?? null,
      company_formation_state: doc.company_formation_state ?? null,
      company_address:         doc.company_address ?? null,
      company_website:         doc.company_website ?? null,
      identity_document_type:  doc.identity_document_type ?? null,
      articles_of_organization_url,
      operating_agreement_url,
      identity_front_url,
      identity_back_url,
      selfie_url,
    }
  }

  // =========================================
  // ASSUMIR / ATRIBUIR SELLER
  // =========================================

  async assignSeller(sellerId: string, managerId: string, notes?: string) {
    const { data: existing } = await supabase
      .from('crm_assignments')
      .select('manager_id, crm_managers(name)')
      .eq('seller_id', sellerId)
      .eq('status', 'active')
      .maybeSingle()

    if (existing) {
      const mgr = (existing as any).crm_managers?.name ?? 'outro gerente'
      throw new ForbiddenException(`Este seller já está sendo atendido por ${mgr}.`)
    }

    await supabase.from('crm_assignments').insert({
      seller_id: sellerId,
      manager_id: managerId,
      status: 'active',
      notes: notes ?? null,
      assigned_at: new Date(), // 🔥
    })

    await this.log(sellerId, managerId, 'assigned', { notes })
    return { message: 'Seller atribuído com sucesso' }
  }

  async releaseSeller(sellerId: string, managerId: string, notes?: string) {
    await supabase.from('crm_assignments')
      .update({ status: 'released', released_at: new Date() }) // 🔥
      .eq('seller_id', sellerId)
      .eq('manager_id', managerId)
      .eq('status', 'active')

    await this.log(sellerId, managerId, 'released', { notes })
    return { message: 'Seller liberado' }
  }

  async transferSeller(sellerId: string, fromManagerId: string, toManagerId: string, notes?: string) {
    await supabase.from('crm_assignments')
      .update({ status: 'transferred', released_at: new Date() }) // 🔥
      .eq('seller_id', sellerId)
      .eq('manager_id', fromManagerId)
      .eq('status', 'active')

    await supabase.from('crm_assignments').insert({
      seller_id: sellerId,
      manager_id: toManagerId,
      status: 'active',
      notes: notes ?? null,
      assigned_at: new Date(), // 🔥
    })

    await this.log(sellerId, fromManagerId, 'transferred', { to: toManagerId, notes })
    return { message: 'Seller transferido' }
  }

  // =========================================
  // APROVAR SELLER
  // =========================================

  async approveSeller(sellerId: string, managerId: string, dto: {
    riskLevel: 'WHITE' | 'GRAY' | 'BLACK'
    enabledMethods: string[]
    /** Provedor padrão do seller; sem valor, entra como Whop. */
    provider?: ProviderDefault
    /** Taxas editadas na aprovação (camelCase ou nome da coluna); o resto fica no padrão. */
    fees?: Record<string, unknown>
    /** Nome antigo de `fees`. */
    feeOverride?: Record<string, unknown>
    notes?: string
    /**
     * Grupo de WhatsApp da operação logística deste merchant. O grupo já existe
     * quando o merchant é aprovado, então capturamos a URL aqui — é o momento
     * natural. Editável depois em PATCH sellers/:id/logistics-group.
     */
    logisticsGroupUrl?: string | null
  }) {
    await this.assertAssigned(sellerId, managerId)

    const { data: seller, error: sellerError } = await supabase
      .from('seller_profiles')
      .select('user_id, status, config')
      .eq('id', sellerId)
      .single()

    if (sellerError || !seller) throw new NotFoundException('Seller não encontrado')
    if (seller.status === 'active') throw new BadRequestException('Seller já está ativo')

    // O cadastro padrão é LLC americana. Seller com CNPJ só é aprovado com a
    // solicitação de ativação por CNPJ liberada — é essa decisão que diz que
    // ele vende pela conta master.
    const { data: sellerDocs } = await supabase
      .from('seller_documents')
      .select('company_type')
      .eq('user_id', seller.user_id)
      .maybeSingle()
    if (sellerDocs?.company_type === 'BR') {
      const { data: cnpjRelease } = await supabase
        .from('seller_activation_requests')
        .select('id')
        .eq('user_id', seller.user_id)
        .eq('status', 'approved')
        .limit(1)
      if (!cnpjRelease?.length) {
        throw new BadRequestException(
          'Seller cadastrado com CNPJ sem liberação. Aprove antes a solicitação de ativação por CNPJ.',
        )
      }
    }

    const logisticsGroupUrl = normalizeWhatsappUrl(dto.logisticsGroupUrl)

    const provider = dto.provider ?? DEFAULT_PROVIDER
    if (!VALID_PROVIDERS.includes(provider as any)) {
      throw new BadRequestException(`Provider inválido. Use um de: ${VALID_PROVIDERS.join(', ')}.`)
    }
    if (!dto.enabledMethods?.length) {
      throw new BadRequestException('Selecione ao menos um método de pagamento.')
    }

    // O risco não define mais a taxa: a aprovação parte do padrão (ou do que já
    // está gravado) com o que o gerente editou no formulário.
    const currentFees = await getSellerFees(sellerId)
    const fees: FeeSettings = parseFeeSettings(dto.fees ?? dto.feeOverride, currentFees ?? DEFAULT_FEE_SETTINGS)
    const customized = Object.keys(feeChanges(DEFAULT_FEE_SETTINGS, fees)).length > 0

    // 🔥 1. Atualiza seller_profile — new Date() para timestamps
    const { error: profileError } = await supabase
      .from('seller_profiles')
      .update({
        status: 'active',
        risk_level: dto.riskLevel,
        enabled_methods: dto.enabledMethods,
        provider_default: provider,
        reviewed_at: new Date(),
        reviewed_by: managerId,
        rejection_reason: null,
        // Só toca em `config` se veio URL — aprovar sem informar o grupo não
        // apaga um valor que já estivesse lá.
        ...(logisticsGroupUrl
          ? { config: { ...(seller.config ?? {}), logistics_group_url: logisticsGroupUrl } }
          : {}),
      })
      .eq('id', sellerId)

    if (profileError) throw new BadRequestException('Erro ao atualizar perfil: ' + profileError.message)

    // 🔥 2. Upsert seller_fees
    const { error: feesError } = await supabase
      .from('seller_fees')
      .upsert({
        seller_id: sellerId,
        risk_level: dto.riskLevel,
        ...sellerFeesRow(fees),
        anticipation_days: 0,
        overridden_by: customized ? managerId : null,
        override_notes: customized ? (dto.notes ?? null) : null,
        updated_at: new Date(),
      }, { onConflict: 'seller_id' })

    if (feesError) throw new BadRequestException('Erro ao salvar taxas: ' + feesError.message)

    // 🔥 3. KYC aprovado
    await supabase
      .from('kyc_info')
      .update({ review_status: 'approved', reviewed_at: new Date() })
      .eq('user_id', seller.user_id)

    // 🔥 4. Marca onboarding completo — operação crítica com log de erro
    const { error: userError } = await supabase
      .from('users')
      .update({ onboarding_completed: true })
      .eq('id', seller.user_id)

    if (userError) {
      console.error('[CrmService.approveSeller] Erro ao marcar onboarding_completed:', userError)
      throw new BadRequestException('Erro ao finalizar aprovação: ' + userError.message)
    }

    await this.log(sellerId, managerId, 'approved', {
      riskLevel: dto.riskLevel,
      provider,
      enabledMethods: dto.enabledMethods,
      fees: sellerFeesRow(fees),
      notes: dto.notes,
      logisticsGroupUrl,
    })

    // Vendedor sabe que já pode vender: métodos, taxas e primeiros passos.
    void notifySellerAccount(sellerId, 'approved', { enabledMethods: dto.enabledMethods, fees: sellerFeesRow(fees) })

    return { message: 'Seller aprovado', fees: sellerFeesRow(fees), logisticsGroupUrl }
  }

  // =========================================
  // GRUPO DA OPERAÇÃO LOGÍSTICA
  // =========================================
  //
  // URL do grupo/conversa de WhatsApp por onde este merchant fala com a
  // operação logística. Fica em `config` (jsonb), mesmo lugar de
  // coinflow_merchant_id e rox_pay_store_reference.
  //
  // O dash do seller lê isto via /integration/koopfy/logistics-channel e usa no
  // botão "Solicitar Homologação" da tela de Produtos.

  async updateLogisticsGroup(
    sellerId: string,
    managerId: string,
    dto: { url?: string | null; notes?: string; partner?: string | null },
  ) {
    await this.assertAssigned(sellerId, managerId)

    const { data: current } = await supabase
      .from('seller_profiles')
      .select('config, email')
      .eq('id', sellerId)
      .single()

    if (!current) throw new NotFoundException('Seller não encontrado')

    const url = dto.url === undefined ? undefined : normalizeWhatsappUrl(dto.url)

    // A fonte da verdade é o CHECKOUT — é lá que a esteira consulta. O `config`
    // daqui vira só eco, para a ficha do CRM não depender de round-trip.
    const applied = await checkoutInternal<{ workspaceId: string }>('logistics/assign', {
      email: current.email,
      ...(url !== undefined ? { groupUrl: url } : {}),
      ...(dto.partner !== undefined ? { partner: dto.partner } : {}),
    })

    if (!applied) {
      throw new BadRequestException(checkoutFailureMessage('gravar a logística no checkout'))
    }

    const config = { ...(current.config ?? {}) }
    if (url !== undefined) {
      if (url) config.logistics_group_url = url
      else delete config.logistics_group_url
    }
    if (dto.partner !== undefined) {
      if (dto.partner) config.logistics_partner = dto.partner
      else delete config.logistics_partner
    }

    await supabase.from('seller_profiles').update({ config }).eq('id', sellerId)

    await this.log(sellerId, managerId, 'logistics_group_changed', {
      from: {
        url: current.config?.logistics_group_url ?? null,
        partner: current.config?.logistics_partner ?? null,
      },
      to: { url: url ?? null, partner: dto.partner ?? null },
      notes: dto.notes,
    })

    return { message: 'Logística atualizada', url, partner: dto.partner }
  }

  // =========================================
  // RADAR DE RISCO DE CHARGEBACK
  // =========================================
  //
  // Os pedidos vivem no checkout. O CRM é a tela onde o time de risco trabalha,
  // ao lado de chargebacks e disputas — uma chamada por página, não por linha.

  async listOrderRisk(params: {
    page?: number; level?: string; workspaceId?: string; search?: string; since?: string
  }) {
    const qs = new URLSearchParams()
    if (params.page) qs.set('page', String(params.page))
    if (params.level && params.level !== 'all') qs.set('level', params.level)
    if (params.workspaceId) qs.set('workspaceId', params.workspaceId)
    if (params.search) qs.set('search', params.search)
    if (params.since) qs.set('since', params.since)

    const res = await checkoutInternal<any>(`orders/risk?${qs.toString()}`)
    if (!res) {
      throw new BadRequestException(checkoutFailureMessage('consultar os pedidos'))
    }
    return res
  }

  async getOrderRisk(orderId: string) {
    const res = await checkoutInternal<any>(`orders/risk/${orderId}`)
    if (!res) throw new NotFoundException('Pedido não encontrado.')
    return res
  }

  /**
   * Dispara a notificação faltante de um pedido.
   *
   * O checkout é idempotente: se o email já saiu, devolve `skipped`. O CRM
   * repassa a resposta crua para a tela dizer a verdade ao gestor.
   */
  async notifyOrder(orderId: string, managerId: string, type: 'confirmation' | 'tracking') {
    const res = await checkoutInternal<any>(`orders/risk/${orderId}/notify`, { type })
    if (!res) throw new BadRequestException('Não foi possível acionar o envio no checkout.')

    await supabase.from('crm_action_log').insert({
      seller_id: null,
      manager_id: managerId,
      action: 'order_notification_sent',
      metadata: { orderId, type, result: res },
    })

    return res
  }

  /** Catálogo de parceiros logísticos — alimenta o seletor do CRM. */
  async listLogisticsPartners() {
    const res = await checkoutInternal<{ partners: any[] }>('logistics/partners')
    return { partners: res?.partners ?? [] }
  }

  // =========================================
  // REJEITAR SELLER
  // =========================================

  async rejectSeller(sellerId: string, managerId: string, dto: { reason: string; notes?: string }) {
    await this.assertAssigned(sellerId, managerId)

    const { data: seller } = await supabase
      .from('seller_profiles').select('user_id').eq('id', sellerId).single()
    if (!seller) throw new NotFoundException()

    await supabase.from('seller_profiles').update({
      status: 'rejected',
      rejection_reason: dto.reason,
      reviewed_at: new Date(), // 🔥
      reviewed_by: managerId,
    }).eq('id', sellerId)

    await supabase.from('kyc_info').update({
      review_status: 'rejected',
      review_notes: dto.reason,
      reviewed_at: new Date(), // 🔥
    }).eq('user_id', seller.user_id)

    await this.log(sellerId, managerId, 'rejected', { reason: dto.reason })
    return { message: 'Seller rejeitado' }
  }

  // =========================================
  // ALTERAR NÍVEL DE RISCO
  // =========================================

  async changeRiskLevel(sellerId: string, managerId: string, dto: {
    riskLevel: 'WHITE' | 'GRAY' | 'BLACK'
    reason: string
  }) {
    const { data: seller } = await supabase
      .from('seller_profiles').select('risk_level').eq('id', sellerId).single()


    const { error: riskError } = await supabase
      .from('seller_profiles')
      .update({ risk_level: dto.riskLevel })
      .eq('id', sellerId)

    if (riskError) throw new BadRequestException('Erro ao atualizar risco: ' + riskError.message)

    // Só registra o risco na tarifa: as taxas são definidas à parte, no CRM.
    await supabase.from('seller_fees').update({ risk_level: dto.riskLevel, updated_at: new Date() }).eq('seller_id', sellerId)

    await this.log(sellerId, managerId, 'risk_changed', {
      from: seller?.risk_level, to: dto.riskLevel, reason: dto.reason,
    })

    return { message: 'Nível de risco atualizado' }
  }

  // =========================================
  // OVERRIDE DE TAXAS
  // =========================================

  async overrideFees(sellerId: string, managerId: string, dto: Record<string, unknown> & { notes?: string }) {
    const notes = String(dto?.notes ?? '').trim()
    if (!notes) throw new BadRequestException('Informe o motivo da alteração das taxas.')

    const [before, { data: profile }] = await Promise.all([
      getSellerFees(sellerId),
      supabase.from('seller_profiles').select('risk_level').eq('id', sellerId).maybeSingle(),
    ])
    if (!profile) throw new NotFoundException('Seller não encontrado')

    const base: FeeSettings = before ?? DEFAULT_FEE_SETTINGS
    const after = parseFeeSettings(dto, base)
    const changes = feeChanges(base, after)

    const { error } = await supabase.from('seller_fees').upsert({
      seller_id: sellerId,
      risk_level: before?.riskLevel ?? profile.risk_level ?? 'WHITE',
      ...sellerFeesRow(after),
      overridden_by: managerId,
      override_notes: notes,
      updated_at: new Date(),
    }, { onConflict: 'seller_id' })
    if (error) throw new BadRequestException('Erro ao salvar taxas: ' + error.message)

    await this.log(sellerId, managerId, 'fee_overridden', { changes, notes })
    return { message: 'Taxas atualizadas', fees: sellerFeesRow(after) }
  }

  /** Padrões e faixas aceitas — o CRM monta o formulário de taxas com isto. */
  getFeeDefaults() {
    return {
      defaults: sellerFeesRow(DEFAULT_FEE_SETTINGS),
      fields: [
        ...FEE_FIELDS.map(({ key, column, min, max, integer, label }) => ({ key, column, min, max, integer: !!integer, boolean: false, label })),
        ...FEE_TOGGLES.map(({ key, column, label }) => ({ key, column, min: 0, max: 1, integer: true, boolean: true, label })),
      ],
    }
  }

  // =========================================
  // MÉTODOS ATIVOS
  // =========================================

  async updateEnabledMethods(sellerId: string, managerId: string, dto: {
    enabledMethods: string[]
    notes?: string
  }) {
    const { data: current } = await supabase
      .from('seller_profiles').select('enabled_methods').eq('id', sellerId).single()

    await supabase.from('seller_profiles')
      .update({ enabled_methods: dto.enabledMethods })
      .eq('id', sellerId)

    await this.log(sellerId, managerId, 'methods_updated', {
      from: current?.enabled_methods,
      to: dto.enabledMethods,
      notes: dto.notes,
    })

    return { message: 'Métodos atualizados' }
  }

  // =========================================
  // SUSPENDER / REATIVAR
  // =========================================

  async suspendSeller(sellerId: string, managerId: string, reason: string) {
    await supabase.from('seller_profiles').update({
      status: 'suspended', rejection_reason: reason,
    }).eq('id', sellerId)

    await this.log(sellerId, managerId, 'suspended', { reason })
    void notifySellerAccount(sellerId, 'suspended', { reason })
    return { message: 'Seller suspenso' }
  }

  async activateSeller(sellerId: string, managerId: string) {
    await supabase.from('seller_profiles').update({
      status: 'active', rejection_reason: null,
    }).eq('id', sellerId)

    await this.log(sellerId, managerId, 'activated', {})
    void notifySellerAccount(sellerId, 'reactivated')
    return { message: 'Seller reativado' }
  }

  // =========================================
  // OFERTAS
  // =========================================

  async approveOffer(offerId: string, sellerId: string, managerId: string, notes?: string) {
    await supabase.from('offers').update({
      status: 'approved', review_notes: notes ?? null, reviewed_at: new Date(), // 🔥
    }).eq('id', offerId)

    await this.log(sellerId, managerId, 'offer_approved', { offerId, notes })
    return { message: 'Oferta aprovada' }
  }

  async rejectOffer(offerId: string, sellerId: string, managerId: string, reason: string) {
    await supabase.from('offers').update({
      status: 'rejected', review_notes: reason, reviewed_at: new Date(), // 🔥
    }).eq('id', offerId)

    await this.log(sellerId, managerId, 'offer_rejected', { offerId, reason })
    return { message: 'Oferta rejeitada' }
  }

  // =========================================
  // NOTAS
  // =========================================

  async addNote(sellerId: string, managerId: string, content: string, isPinned = false) {
    const { data } = await supabase.from('crm_notes').insert({
      seller_id: sellerId,
      manager_id: managerId,
      content,
      is_pinned: isPinned,
      created_at: new Date(), // 🔥
      updated_at: new Date(), // 🔥
    }).select().single()

    await this.log(sellerId, managerId, 'note_added', { isPinned })
    return data
  }

  async deleteNote(noteId: string, managerId: string) {
    await supabase.from('crm_notes').delete()
      .eq('id', noteId).eq('manager_id', managerId)
    return { message: 'Nota removida' }
  }

  // =========================================
  // REGISTRAR CONTATO
  // =========================================

  async logContact(sellerId: string, managerId: string, dto: {
    type: 'whatsapp' | 'call' | 'email' | 'meeting'
    notes: string
    outcome?: 'no_answer' | 'in_progress' | 'scheduled' | 'completed'
  }): Promise<{ message: string }> {
    await this.log(sellerId, managerId, 'contact_' + dto.type, {
      notes: dto.notes, outcome: dto.outcome,
    })
    return { message: 'Contato registrado' }
  }

  // =========================================
  // GERENTES
  // =========================================

  async listManagers() {
    const { data } = await supabase
      .from('crm_managers')
      .select('id, name, email, role, is_active, last_login_at, avatar_url')
      .order('name')

    return data ?? []
  }

  async createManager(dto: { name: string; email: string; password: string; role: string }) {
    const hash = await bcrypt.hash(dto.password, 12)
    const { data, error } = await supabase.from('crm_managers').insert({
      name: dto.name,
      email: dto.email.toLowerCase(),
      password_hash: hash,
      role: dto.role,
    }).select('id, name, email, role').single()

    if (error) throw new BadRequestException('Email já cadastrado ou erro ao criar gerente')
    return data
  }

  // =========================================
  // HELPERS PRIVADOS
  // =========================================

  /** Admin e supervisor agem em qualquer seller; gerente só nos que assumiu. */
  async assertCanManage(sellerId: string, manager: { sub: string; role: string }) {
    if (manager?.role === 'admin' || manager?.role === 'supervisor') return
    await this.assertAssigned(sellerId, manager?.sub)
  }

  private async assertAssigned(sellerId: string, managerId: string) {
    const { data } = await supabase
      .from('crm_assignments')
      .select('id')
      .eq('seller_id', sellerId)
      .eq('manager_id', managerId)
      .eq('status', 'active')
      .maybeSingle()

    if (!data) {
      throw new ForbiddenException(
        'Você precisa assumir este seller antes de tomar ações sobre ele.'
      )
    }
  }

  private async log(
    sellerId: string,
    managerId: string,
    action: string,
    payload: Record<string, any>,
  ) {
    const request = currentCrmRequest()
    const { error } = await supabase.from('crm_action_log').insert({
      seller_id: sellerId,
      manager_id: managerId,
      action,
      resource_type: 'seller',
      resource_id: sellerId,
      payload,
      ip_address: request?.ip ?? null,
      user_agent: request?.userAgent ?? null,
      created_at: new Date(), // 🔥
    })
    if (error) console.error(`[CrmService.log] ação ${action} não registrada:`, error.message)
  }

  // =========================================
  // ALTERAR PROVIDER DEFAULT
  // =========================================

  async updateProviderDefault(sellerId: string, managerId: string, dto: {
    provider: ProviderDefault
    notes?: string
  }) {
    // Validação: aceita null (limpa) ou um dos valores válidos
    if (dto.provider !== null && !VALID_PROVIDERS.includes(dto.provider as any)) {
      throw new BadRequestException(
        `Provider inválido. Use um de: ${VALID_PROVIDERS.join(', ')} ou null.`
      )
    }

    const { data: current } = await supabase
      .from('seller_profiles')
      .select('provider_default')
      .eq('id', sellerId)
      .single()

    if (!current) throw new NotFoundException('Seller não encontrado')

    const { error } = await supabase
      .from('seller_profiles')
      .update({ provider_default: dto.provider })
      .eq('id', sellerId)

    if (error) throw new BadRequestException('Erro ao atualizar provider: ' + error.message)

    await this.log(sellerId, managerId, 'provider_changed', {
      from: current.provider_default ?? null,
      to: dto.provider,
      notes: dto.notes,
    })

    return { message: 'Provider atualizado', provider: dto.provider }
  }

  // =========================================
  // WHOP — pool de contas
  // -----------------------------------------
  // Diferente do Sentinel/Coinflow/Rox, a Whop NÃO tem "conta do seller": o
  // seller aponta pra `whop` e o AccountRouter escolhe a company a cada pedido
  // (déficit + tetos + saúde), fixando-a por pedido. Por isso o CRM administra o
  // POOL, não uma associação seller→conta. Setar um MID aqui seria justamente
  // desligar a divisão de volume que é o motivo da integração existir.
  // =========================================

  // Lista o pool com o volume do dia — sem segredos.
  async listWhopAccounts() {
    const { data, error } = await supabase
      .from('whop_accounts')
      .select(
        'id, label, company_id, product_id, status, weight, currency, countries, country, ' +
        'daily_cap_amount, min_ticket, max_ticket, cooldown_until, legal_name, descriptor, ' +
        'webhook_id, created_at',
      )
      .order('created_at', { ascending: false })

    if (error) throw new BadRequestException('Erro ao listar contas Whop: ' + error.message)

    // `whop_accounts` não está nos tipos gerados do Supabase — cast explícito.
    const rows = (data ?? []) as unknown as Array<Record<string, any>>
    if (rows.length === 0) return []

    // Volume de HOJE por conta — é o que diz se o split está saindo como
    // configurado. Sem isso o gestor mexe no weight às cegas.
    const day = new Date().toISOString().slice(0, 10)
    const { data: metrics } = await supabase
      .from('account_daily_metrics')
      .select('account_id, volume, paid_count')
      .in('account_id', rows.map(r => r.id))
      .eq('day', day)

    const byId = new Map((metrics ?? []).map(m => [m.account_id, m]))

    return rows.map(r => ({
      ...r,
      // Segredos nunca saem daqui — só o fato de existirem.
      has_api_key: true,
      has_webhook_secret: Boolean(r.webhook_id),
      today_volume_usd_cents: Number(byId.get(r.id)?.volume ?? 0),
      today_paid_count: Number(byId.get(r.id)?.paid_count ?? 0),
    }))
  }

  // Provisiona uma conta nova a partir da API KEY, e só dela.
  //
  // O que uma company precisa pra entrar no pool é: company_id, credencial e
  // webhook com segredo. Os três saem da própria chave:
  //   • company_id  → GET /api/v5/company (a chave já está amarrada a uma)
  //   • webhook     → POST /api/v1/webhooks com a URL /webhook/whop/<id>
  //   • segredo     → vem na resposta do webhook
  //
  // Produto NÃO é necessário: o plano inline usa `external_identifier`, que
  // deduplica — N compras viram N planos sob UM produto, criado na primeira.
  //
  // Isto existe porque cadastrar company_id e colar `ws_...` na mão, vezes N
  // titulares, é onde se erra — e webhook errado só aparece horas depois, como
  // "pagamento que não confirma".
  async provisionWhopAccount(managerId: string, dto: {
    id: string
    apiKey: string
    label?: string
    weight?: number
    dailyCapAmount?: number | null
    legalName?: string
  }) {
    if (!dto.id?.trim() || !dto.apiKey?.trim()) {
      throw new BadRequestException('id e apiKey são obrigatórios.')
    }

    const provider = new WhopProvider()

    let company: { id: string; title: string | null }
    try {
      company = await provider.discoverCompany(dto.apiKey.trim())
    } catch (e: any) {
      throw new BadRequestException(`Chave inválida ou sem permissão: ${e?.message ?? 'erro'}`)
    }

    let webhook: { webhookId: string; webhookSecret: string }
    try {
      webhook = await provider.registerWebhook({
        apiKey: dto.apiKey.trim(),
        companyId: company.id,
        accountId: dto.id.trim(),
      })
    } catch (e: any) {
      // Sem webhook a conta cobraria e nunca confirmaria — não vale gravar
      // "meio provisionada" e deixar alguém ativá-la sem perceber.
      throw new BadRequestException(`Conta não provisionada — falha ao registrar o webhook: ${e?.message ?? 'erro'}`)
    }

    await this.upsertWhopAccount(managerId, {
      id: dto.id.trim(),
      label: dto.label ?? company.title ?? undefined,
      companyId: company.id,
      apiKey: dto.apiKey.trim(),
      webhookSecret: webhook.webhookSecret,
      webhookId: webhook.webhookId,
      weight: dto.weight,
      dailyCapAmount: dto.dailyCapAmount ?? null,
      legalName: dto.legalName,
      // Entra FORA do pool. Conta nova recebendo volume no primeiro minuto é o
      // caminho mais curto pra revisão — quem ativa é uma decisão humana.
      status: 'inactive',
    })

    return {
      message: 'Conta provisionada',
      id: dto.id.trim(),
      company_id: company.id,
      company_title: company.title,
      webhook_id: webhook.webhookId,
    }
  }

  // Cria/atualiza uma conta do pool (admin). Upsert por id.
  //
  // Credenciais só são gravadas quando enviadas — assim dá pra editar peso e
  // teto sem ter que recolar a API key (e sem apagá-la por omissão).
  async upsertWhopAccount(managerId: string, dto: {
    id: string
    label?: string
    companyId: string
    productId?: string
    apiKey?: string
    webhookSecret?: string
    webhookId?: string
    apiUrl?: string
    status?: 'active' | 'inactive'
    weight?: number
    currency?: string
    countries?: string[]
    country?: string
    dailyCapAmount?: number | null
    minTicket?: number | null
    maxTicket?: number | null
    legalName?: string
    descriptor?: string
  }) {
    if (!dto.id || !dto.companyId) {
      throw new BadRequestException('id e companyId são obrigatórios.')
    }

    const { data: current } = await supabase
      .from('whop_accounts').select('id').eq('id', dto.id).maybeSingle()

    if (!current && !dto.apiKey) {
      throw new BadRequestException('apiKey é obrigatória ao criar uma conta Whop.')
    }

    const row: Record<string, any> = {
      id: dto.id,
      label: dto.label ?? null,
      company_id: dto.companyId,
      product_id: dto.productId ?? null,
      api_url: dto.apiUrl ?? null,
      status: dto.status ?? (current ? undefined : 'inactive'),
      weight: dto.weight ?? undefined,
      currency: dto.currency ?? null,
      countries: dto.countries ?? null,
      country: dto.country ?? null,
      daily_cap_amount: dto.dailyCapAmount ?? null,
      min_ticket: dto.minTicket ?? null,
      max_ticket: dto.maxTicket ?? null,
      legal_name: dto.legalName ?? null,
      descriptor: dto.descriptor ?? null,
      updated_at: new Date().toISOString(),
    }

    // Cifradas em repouso — o WhopAccountsService decifra na leitura.
    if (dto.apiKey) row.api_key = this.crypto.encrypt(dto.apiKey)
    if (dto.webhookSecret) row.webhook_secret = this.crypto.encrypt(dto.webhookSecret)
    if (dto.webhookId) row.webhook_id = dto.webhookId

    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k]

    const { error } = await supabase
      .from('whop_accounts')
      .upsert(row, { onConflict: 'id' })

    if (error) throw new BadRequestException('Erro ao salvar conta Whop: ' + error.message)

    this.whopAccounts.invalidate()

    await this.log(null as any, managerId, 'whop_account_upserted', {
      account_id: dto.id,
      created: !current,
      // Nunca logar credencial — só se veio.
      credentials_updated: Boolean(dto.apiKey || dto.webhookSecret),
    })

    return { message: 'Conta Whop salva', id: dto.id }
  }

  // Controles operacionais: é isto que precisa ser instantâneo quando uma conta
  // começa a dar problema. Por isso invalida o cache do pool na hora, em vez de
  // esperar o TTL de 30s do WhopAccountsService.
  async updateWhopAccountRouting(id: string, managerId: string, dto: {
    status?: 'active' | 'inactive'
    weight?: number
    dailyCapAmount?: number | null
    minTicket?: number | null
    maxTicket?: number | null
    cooldownUntil?: string | null
    notes?: string
  }) {
    const { data: current } = await supabase
      .from('whop_accounts')
      .select('status, weight, daily_cap_amount, min_ticket, max_ticket, cooldown_until')
      .eq('id', id).maybeSingle()

    if (!current) throw new NotFoundException('Conta Whop não encontrada')

    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    if (dto.status !== undefined) patch.status = dto.status
    if (dto.weight !== undefined) patch.weight = dto.weight
    if (dto.dailyCapAmount !== undefined) patch.daily_cap_amount = dto.dailyCapAmount
    if (dto.minTicket !== undefined) patch.min_ticket = dto.minTicket
    if (dto.maxTicket !== undefined) patch.max_ticket = dto.maxTicket
    if (dto.cooldownUntil !== undefined) patch.cooldown_until = dto.cooldownUntil

    const { error } = await supabase.from('whop_accounts').update(patch).eq('id', id)
    if (error) throw new BadRequestException('Erro ao atualizar conta Whop: ' + error.message)

    this.whopAccounts.invalidate()

    await this.log(null as any, managerId, 'whop_account_routing_changed', {
      account_id: id, from: current, to: patch, notes: dto.notes,
    })

    return { message: 'Conta Whop atualizada', id }
  }

  // =========================================
  // SENTINEL — MIDs
  // =========================================

  // Lista os MIDs do Sentinel disponíveis (sem expor segredos) p/ o CRM
  // escolher qual atribuir ao seller.
  async listSentinelMids() {
    const { data, error } = await supabase
      .from('sentinel_mids')
      .select('mid, label, api_url, status, created_at')
      .order('created_at', { ascending: false })

    if (error) throw new BadRequestException('Erro ao listar MIDs: ' + error.message)
    return data ?? []
  }

  // Registra/atualiza um MID e suas credenciais (admin). Upsert por mid.
  async upsertSentinelMid(managerId: string, dto: {
    mid: string
    label?: string
    apiKey: string
    apiSecret: string
    mbwayApiKey?: string
    apiUrl?: string
    status?: 'active' | 'inactive'
  }) {
    if (!dto.mid || !dto.apiKey || !dto.apiSecret) {
      throw new BadRequestException('mid, apiKey e apiSecret são obrigatórios.')
    }

    const { error } = await supabase
      .from('sentinel_mids')
      .upsert({
        mid: dto.mid,
        label: dto.label ?? null,
        api_key: dto.apiKey,
        api_secret: dto.apiSecret,
        mbway_api_key: dto.mbwayApiKey ?? null,
        api_url: dto.apiUrl ?? null,
        status: dto.status ?? 'active',
      }, { onConflict: 'mid' })

    if (error) throw new BadRequestException('Erro ao salvar MID: ' + error.message)

    return { message: 'MID salvo', mid: dto.mid }
  }

  // Atribui um MID do Sentinel ao seller (ou limpa com null → usa env default).
  async updateSellerMid(sellerId: string, managerId: string, dto: {
    mid: string | null
    notes?: string
  }) {
    const { data: current } = await supabase
      .from('seller_profiles')
      .select('provider_mid, provider_default, config')
      .eq('id', sellerId)
      .single()

    if (!current) throw new NotFoundException('Seller não encontrado')

    // Coinflow: o merchantId é texto livre (ex.: koopfy-sandbox) e vai no jsonb
    // `config` — NÃO no provider_mid, que tem FK pra tabela de MIDs do Sentinel.
    if (current.provider_default === 'coinflow') {
      const config = { ...(current.config ?? {}) }
      if (dto.mid) config.coinflow_merchant_id = dto.mid
      else delete config.coinflow_merchant_id

      const { error } = await supabase
        .from('seller_profiles')
        .update({ config })
        .eq('id', sellerId)

      if (error) throw new BadRequestException('Erro ao atualizar Merchant ID: ' + error.message)

      await this.log(sellerId, managerId, 'coinflow_merchant_id_changed', {
        from: current.config?.coinflow_merchant_id ?? null,
        to: dto.mid ?? null,
        notes: dto.notes,
      })

      return { message: 'Merchant ID atualizado', mid: dto.mid }
    }

    // Rox Pay: Store Reference é texto livre (ex.: STR-20260722-G9BLUAKAC0, criada
    // manualmente no painel deles) — mesmo padrão da Coinflow, vai no jsonb `config`.
    if (current.provider_default === 'rox_pay') {
      const config = { ...(current.config ?? {}) }
      if (dto.mid) config.rox_pay_store_reference = dto.mid
      else delete config.rox_pay_store_reference

      const { error } = await supabase
        .from('seller_profiles')
        .update({ config })
        .eq('id', sellerId)

      if (error) throw new BadRequestException('Erro ao atualizar Store Reference: ' + error.message)

      await this.log(sellerId, managerId, 'rox_pay_store_reference_changed', {
        from: current.config?.rox_pay_store_reference ?? null,
        to: dto.mid ?? null,
        notes: dto.notes,
      })

      return { message: 'Store Reference atualizada', mid: dto.mid }
    }

    // Sentinel: valida contra sentinel_mids e grava no provider_mid (FK).
    if (dto.mid && current.provider_default === 'setinel_gate') {
      const { data: mid } = await supabase
        .from('sentinel_mids')
        .select('mid, status')
        .eq('mid', dto.mid)
        .maybeSingle()

      if (!mid) throw new BadRequestException(`MID "${dto.mid}" não encontrado.`)
      if (mid.status !== 'active') throw new BadRequestException(`MID "${dto.mid}" está inativo.`)
    }

    const { error } = await supabase
      .from('seller_profiles')
      .update({ provider_mid: dto.mid })
      .eq('id', sellerId)

    if (error) throw new BadRequestException('Erro ao atualizar MID: ' + error.message)

    await this.log(sellerId, managerId, 'sentinel_mid_changed', {
      from: current.provider_mid ?? null,
      to: dto.mid,
      notes: dto.notes,
    })

    return { message: 'MID atualizado', mid: dto.mid }
  }


  // ══════════════════════════════════════════════════════════════════════════
  // SPEI — contas e saque
  // ──────────────────────────────────────────────────────────────────────────
  // ⚠️ O TETO DO SPEI É ESTOQUE, NÃO VAZÃO — E É POR ISSO QUE ESTA TELA EXISTE.
  // O do cartão repõe sozinho à meia-noite. O do SPEI só volta quando ALGUÉM
  // SACA: enquanto o dinheiro está parado na conta Clip, ele ocupa espaço, e
  // com a conta cheia o roteador simplesmente para de oferecer SPEI. Sem esta
  // tela, a única forma de destravar seria UPDATE na mão no banco.
  // ══════════════════════════════════════════════════════════════════════════

  async listSpeiAccounts() {
    const [{ data: capacidade }, { data: confianca }, { data: contas }] = await Promise.all([
      supabase.from('gw_capacity').select('*').eq('method', 'spei'),
      supabase.from('gw_spei_confidence').select('*'),
      supabase.from('gw_spei_accounts')
        .select('id, label, clabe, banco, beneficiario, currency, balance_cap_minor, buffer_pct, reserved_minor, occupied_minor, status'),
    ]);

    const porId = (arr: any[] | null, k = 'id') =>
      Object.fromEntries((arr ?? []).map(r => [r[k], r]));
    const cap = porId(capacidade);
    const conf = porId(confianca, 'account_id');

    const itens = await Promise.all((contas ?? []).map(async (c: any) => {
      // Últimos saques: é o histórico que mostra se a deriva é pontual ou
      // sistemática. Uma deriva positiva isolada é ruído; três seguidas são
      // pagamento fantasma recorrente, e o colchão precisa subir.
      const { data: ledger } = await supabase
        .from('gw_spei_ledger')
        .select('saldo_previsto_minor, held_aberto_minor, saldo_observado_minor, drift_minor, valor_sacado_minor, saldo_apos_minor, nota, created_by, created_at')
        .eq('account_id', c.id)
        .order('created_at', { ascending: false })
        .limit(5);

      return {
        ...c,
        // Teto COM colchão — o que o roteador de fato respeita.
        capOperacionalMinor: cap[c.id]?.cap_minor ?? null,
        emVooMinor: cap[c.id]?.em_voo_minor ?? 0,
        livreMinor: cap[c.id]?.livre_minor ?? 0,
        // Quanto do que está parado veio de leitura de imagem e nunca foi
        // conferido contra extrato. É o número que diz o quanto confiar no saldo.
        naoVerificadoMinor: conf[c.id]?.nao_verificado_minor ?? 0,
        confirmadoMinor: conf[c.id]?.confirmado_minor ?? 0,
        ultimosSaques: ledger ?? [],
      };
    }));

    return { itens };
  }

  /**
   * Registra um saque e libera o teto.
   *
   * ⚠️ EXIGE OS DOIS VALORES, E NÃO É BUROCRACIA.
   * `valorSacadoMinor` sozinho diria quanto saiu, e o contador continuaria
   * sendo uma crença acumulada — errando um pouco a cada mês até o teto virar
   * ficção. `saldoObservadoMinor` é o saldo REAL que a pessoa vê no app naquele
   * instante, e é ele que:
   *
   *   • zera a deriva acumulada (o novo occupied vem do observado, não de
   *     aritmética sobre o valor anterior);
   *   • acusa PAGAMENTO FANTASMA — dinheiro que entrou pela CLABE sem passar
   *     pelo checkout, de comprador antigo que ainda tem a conta salva;
   *   • acusa COMPROVANTE FALSO APROVADO — se a IA liberou pedido cuja
   *     transferência não existiu, falta dinheiro aqui, e é o ÚNICO lugar
   *     onde isso aparece.
   */
  async withdrawSpei(
    accountId: string,
    managerId: string,
    body: { saldo_observado_minor?: number; valor_sacado_minor?: number; nota?: string },
  ) {
    const observado = Math.round(Number(body?.saldo_observado_minor));
    const sacado = Math.round(Number(body?.valor_sacado_minor));

    if (!Number.isFinite(observado) || observado < 0) {
      throw new BadRequestException('Informe o saldo observado na conta (em centavos).');
    }
    if (!Number.isFinite(sacado) || sacado < 0) {
      throw new BadRequestException('Informe o valor sacado (em centavos).');
    }
    if (sacado > observado) {
      throw new BadRequestException('O valor sacado não pode ser maior que o saldo observado.');
    }

    const r = await this.clipAccounts.withdrawSpei({
      accountId,
      saldoObservadoMinor: observado,
      valorSacadoMinor: sacado,
      createdBy: `human:${managerId}`,
      nota: body?.nota ?? null,
    });

    return {
      driftMinor: r?.drift_minor ?? 0,
      saldoPrevistoMinor: r?.saldo_previsto_minor ?? 0,
      saldoAposMinor: r?.saldo_apos_minor ?? 0,
      occupiedMinor: r?.occupied_minor ?? 0,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SPEI — fila de comprovantes para revisão humana
  // ──────────────────────────────────────────────────────────────────────────
  // Cai aqui tudo que a análise automática não liberou: comprovante fora da
  // janela de 24h, transferência agendada, valor que não bate nos centavos,
  // leitura ruim. Não é recusa — é "não tenho certeza".
  //
  // ⚠️ APROVAR OLHANDO O PRINT NÃO É CONFERIR O DINHEIRO.
  // Um gestor lendo o comprovante tem exatamente a mesma limitação do modelo:
  // ele não vê o extrato. Por isso a aprovação tem DUAS formas distintas, e a
  // diferença fica gravada na origem da captura:
  //
  //   'human-comprovante'  → li o comprovante e achei convincente.
  //                          Continua NÃO VERIFICADO (ver gw_source_verificada).
  //   'manual-conciliado'  → abri o extrato da Clip e o dinheiro está lá.
  //                          Isto sim conta como confirmado.
  //
  // Fundir as duas num botão só faria o clique de um humano promover a
  // confiança do número sem que ninguém tenha visto dinheiro nenhum — e o
  // relatório de saldo voltaria a mentir, que é o problema que a separação
  // entre validado-por-imagem e confirmado existe para resolver.
  // ══════════════════════════════════════════════════════════════════════════

  async listSpeiProofs(args: { page?: number; status?: string } = {}) {
    const page = Math.max(1, args.page ?? 1);
    const porPagina = 25;
    const status = args.status ?? 'manual_review';

    const { data, error, count } = await supabase
      .from('transactions')
      .select('id, seller_id, amount, currency, status, provider_status, metadata, created_at', { count: 'exact' })
      .eq('provider', 'clip')
      .eq('metadata->>spei_proof_status', status)
      .order('created_at', { ascending: false })
      .range((page - 1) * porPagina, page * porPagina - 1);

    if (error) throw new BadRequestException(`Falha ao listar comprovantes: ${error.message}`);

    const itens = await Promise.all((data ?? []).map(async (tx: any) => {
      const md = tx.metadata ?? {};
      // URL assinada curta, gerada no momento da leitura. O bucket é privado e
      // o caminho é o que fica gravado — link assinado guardado morre sozinho.
      const proofUrl = await this.storageService.getSignedSpeiReceiptUrl(md.spei_proof_path, 900);

      // Histórico de decisões daquele pedido: o que a IA leu e por que não
      // liberou. É isto que o gestor precisa ver ANTES de decidir, senão ele
      // está só olhando a mesma imagem sem o trabalho já feito.
      const { data: receipts } = md.spei_reservation_id
        ? await supabase
            .from('gw_spei_receipts')
            .select('id, verdict, confidence, checks, reasons, extracted, decided_by, created_at')
            .eq('reservation_id', md.spei_reservation_id)
            .order('created_at', { ascending: false })
        : { data: [] as any[] };

      return {
        transactionId: tx.id,
        sellerId: tx.seller_id,
        amount: tx.amount,
        currency: tx.currency,
        status: tx.status,
        providerStatus: tx.provider_status,
        createdAt: tx.created_at,
        reservationId: md.spei_reservation_id ?? null,
        // Valor que o comprador DEVIA transferir, com os centavos únicos.
        chargeMinor: md.spei_charge_minor ?? null,
        proofUrl,
        proofMime: md.spei_proof_mime ?? null,
        proofUploadedAt: md.spei_proof_uploaded_at ?? null,
        analise: md.spei_proof_analysis ?? null,
        historico: receipts ?? [],
      };
    }));

    return { itens, page, total: count ?? 0 };
  }

  async decideSpeiProof(
    transactionId: string,
    managerId: string,
    body: { decision: 'approve' | 'reject'; conferido_no_extrato?: boolean; nota?: string },
  ) {
    const { data: tx, error } = await supabase
      .from('transactions')
      .select('id, status, currency, metadata')
      .eq('id', transactionId)
      .maybeSingle();

    if (error || !tx) throw new NotFoundException('Transação não encontrada.');

    const md = tx.metadata ?? {};
    const reservationId = md.spei_reservation_id;
    if (!reservationId) throw new BadRequestException('Transação sem reserva SPEI.');

    if (body.decision === 'reject') {
      await supabase.from('transactions').update({
        provider_status: 'proof_rejected',
        metadata: { ...md, spei_proof_status: 'rejected', spei_proof_decided_by: `human:${managerId}`, spei_proof_note: body.nota ?? null },
      }).eq('id', transactionId);
      // Devolve o espaço reservado agora, em vez de esperar o TTL.
      await this.clipAccounts.release(reservationId, `rejeitado por human:${managerId}`);
      return { status: 'rejected' };
    }

    // ⚠️ Só quem abriu o extrato pode marcar como conferido. O default é a
    // opção honesta: aprovado olhando o comprovante, portanto não verificado.
    const source = body.conferido_no_extrato ? 'manual-conciliado' : 'human-comprovante';

    // Idempotente: se já foi capturado (dois cliques, ou a análise automática
    // aprovou antes), capture() devolve false e nada é contado duas vezes.
    const capturou = await this.clipAccounts.capture({
      reservationId,
      amountMinor: Number(md.spei_charge_minor),
      kind: 'base',
      source,
    });

    await supabase.from('transactions').update({
      metadata: {
        ...md,
        spei_proof_status: 'approved',
        spei_proof_decided_by: `human:${managerId}`,
        spei_proof_source: source,
        spei_proof_note: body.nota ?? null,
      },
    }).eq('id', transactionId);

    // Reusa o pipeline canônico de PAID: credita carteira, KPI e postback.
    // Atualizar `status` direto aqui pularia todos esses efeitos, e o pedido
    // ficaria pago no CRM e pendente em todo o resto do sistema.
    if (tx.status === 'pending') {
      await this.webhookService.handleWebhookProvider({
        reference: transactionId, status: 'PAID', type: 'TRANSACTION',
      } as any);
    }

    return { status: 'approved', source, capturou };
  }

}
