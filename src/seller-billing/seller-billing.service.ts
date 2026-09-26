import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { createHash } from 'crypto'
import { supabase } from '../lib/supabase.client'
import { WhopAccountsService, WHOP_ENV_ACCOUNT_ID } from '../orchestrator/whop/whop-accounts.service'
import {
  BILLING_METADATA_KEY,
  BillingChargeStatus,
  billingStatusFromWhopPayment,
  SavedCard,
  savedCardFromSetupIntent,
  setupIntentMatches,
  toWhopPrice,
  whopFailureMessage,
} from './seller-billing.rules'

// ============================================================================
// COBRANÇA DO SELLER — comissões da Koopfy no cartão dele, pela Whop da Koopfy
// ----------------------------------------------------------------------------
// Quem sabe QUANTO cobrar é o checkout (billing_debits, na moeda da loja). Aqui
// só existe o COMO: salvar o cartão e cobrá-lo sem o seller presente.
//
// 1. Salvar: checkout configuration em modo `setup` na company master (nada é
//    cobrado). O seller preenche o cartão na página da Whop e volta ao painel.
//    O setup intent que nasce ali traz member + payment method. Confirmamos
//    pela listagem de setup intents (não dependemos de o evento
//    setup_intent.succeeded estar assinado no painel da Whop), e o webhook,
//    quando vier, só adianta.
// 2. Cobrar: plano one_time com o valor + POST /payments com member_id e
//    payment_method_id — o mesmo caminho do upsell de um clique (plano por id,
//    que é o que o guia da Whop manda para cartão salvo).
//    A resposta não é final: quem fecha é payment.succeeded/failed ou a
//    consulta do checkout em GET /payments/{id}.
//
// Tudo carrega `koopfy_account_id: whop_main` no metadata porque o endpoint
// compartilhado de webhook escolhe o segredo por ele, e `koopfy_billing` para o
// webhook desviar o evento antes do pipeline de transações (não há transação
// nossa por trás de uma cobrança de comissão).
// ============================================================================

const SETUP_LOOKBACK_MS = 10 * 60 * 1000
const SETUP_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PLAN_TITLE = 'Koopfy · Comissões'
const PRODUCT_EXTERNAL_ID = 'koopfy_billing'

export interface BillingMethodView {
  status: 'none' | 'pending' | 'active'
  card: Omit<SavedCard, 'memberId' | 'paymentMethodId'> | null
  updatedAt: string | null
}

export interface BillingChargeView {
  chargeRef: string
  status: BillingChargeStatus
  amountMinor: number
  currency: string
  whopPaymentId: string | null
  failureMessage: string | null
}

type Master = { apiUrl: string; apiKey: string; companyId: string }

@Injectable()
export class SellerBillingService {
  private readonly log = new Logger(SellerBillingService.name)
  private static readonly planCache = new Map<string, { id: string; until: number }>()

  constructor(private readonly whopAccounts: WhopAccountsService) {}

  // ─── Conta master ─────────────────────────────────────────────────────────

  private async master(): Promise<Master> {
    const account = await this.whopAccounts.getById(WHOP_ENV_ACCOUNT_ID)
    const companyId = account?.config?.company_id
    if (!account?.apiKey || !companyId) {
      throw new ServiceUnavailableException('Whop da Koopfy não configurada (WHOP_API_KEY).')
    }
    return { apiUrl: account.api_url ?? 'https://api.whop.com', apiKey: account.apiKey, companyId: String(companyId) }
  }

  private async whop(master: Master, path: string, init: { method?: string; body?: any; idempotencyKey?: string } = {}) {
    const res = await fetch(`${master.apiUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${master.apiKey}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    const json: any = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, json }
  }

  private baseMetadata(workspaceId: string) {
    return { koopfy_account_id: WHOP_ENV_ACCOUNT_ID, koopfy_workspace_id: workspaceId }
  }

  // ─── 1. Salvar o cartão ───────────────────────────────────────────────────

  async startSetup(args: { workspaceId: string; email?: string | null; returnUrl: string }) {
    const master = await this.master()
    const { ok, status, json } = await this.whop(master, '/api/v1/checkout_configurations', {
      method: 'POST',
      body: {
        account_id: master.companyId,
        mode: 'setup',
        redirect_url: args.returnUrl,
        metadata: { ...this.baseMetadata(args.workspaceId), [BILLING_METADATA_KEY]: 'setup' },
      },
    })
    const sessionId = typeof json?.id === 'string' ? json.id : null
    const url = typeof json?.purchase_url === 'string' ? json.purchase_url : null
    if (!ok || !sessionId || !url) {
      this.log.error(`setup ${args.workspaceId}: HTTP ${status} ${JSON.stringify(json?.error ?? json).slice(0, 400)}`)
      throw new ServiceUnavailableException(json?.error?.message ?? 'Não foi possível abrir o cadastro do cartão na Whop.')
    }

    // Cartão ativo continua valendo até o novo ser confirmado: trocar de cartão
    // não deixa a loja um instante sem meio de cobrança.
    const { data: current } = await supabase
      .from('seller_billing_methods')
      .select('status')
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()

    const now = new Date().toISOString()
    const { error } = await supabase.from('seller_billing_methods').upsert({
      workspace_id: args.workspaceId,
      seller_email: args.email ?? null,
      status: current?.status === 'active' ? 'active' : 'pending',
      setup_session_id: sessionId,
      setup_started_at: now,
      updated_at: now,
    }, { onConflict: 'workspace_id' })
    if (error) throw new Error(`seller_billing_methods: ${error.message}`)

    return { url, sessionId }
  }

  async getMethod(workspaceId: string): Promise<BillingMethodView> {
    let row = await this.loadMethod(workspaceId)
    if (row?.setup_session_id && row.setup_started_at
      && Date.now() - new Date(row.setup_started_at).getTime() < SETUP_SESSION_TTL_MS) {
      row = (await this.reconcileSetup(row).catch((err: any) => {
        this.log.warn(`reconcile ${workspaceId}: ${err?.message}`)
        return null
      })) ?? row
    }
    return this.view(row)
  }

  private async loadMethod(workspaceId: string) {
    const { data, error } = await supabase
      .from('seller_billing_methods')
      .select('*')
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error) throw new Error(`seller_billing_methods: ${error.message}`)
    return data as any
  }

  private view(row: any): BillingMethodView {
    if (!row || row.status === 'removed') return { status: 'none', card: null, updatedAt: null }
    const card = row.status === 'active'
      ? { brand: row.card_brand, last4: row.card_last4, expMonth: row.card_exp_month, expYear: row.card_exp_year }
      : null
    return { status: row.status, card, updatedAt: row.updated_at ?? null }
  }

  /** Procura o setup intent da sessão aberta; achando, o cartão vira o ativo. */
  private async reconcileSetup(row: any) {
    const master = await this.master()
    const since = new Date(new Date(row.setup_started_at).getTime() - SETUP_LOOKBACK_MS).toISOString()
    const query = new URLSearchParams({
      account_id: master.companyId,
      created_after: since,
      direction: 'desc',
      first: '50',
    })
    const { ok, status, json } = await this.whop(master, `/api/v1/setup_intents?${query.toString()}`)
    if (!ok) throw new Error(`setup_intents HTTP ${status}: ${JSON.stringify(json?.error ?? json).slice(0, 200)}`)

    const intents: any[] = Array.isArray(json?.data) ? json.data : []
    const match = intents.find(intent =>
      setupIntentMatches(intent, row.setup_session_id, row.workspace_id) && savedCardFromSetupIntent(intent))
    if (!match) return null
    return this.saveCard(row.workspace_id, savedCardFromSetupIntent(match)!)
  }

  private async saveCard(workspaceId: string, card: SavedCard) {
    const { data, error } = await supabase
      .from('seller_billing_methods')
      .update({
        status: 'active',
        whop_member_id: card.memberId,
        whop_payment_method_id: card.paymentMethodId,
        card_brand: card.brand,
        card_last4: card.last4,
        card_exp_month: card.expMonth,
        card_exp_year: card.expYear,
        setup_session_id: null,
        setup_started_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('workspace_id', workspaceId)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(`seller_billing_methods: ${error.message}`)
    this.log.log(`cartão de cobrança ativo: workspace ${workspaceId} (${card.brand ?? '?'} ${card.last4 ?? ''})`)
    return data
  }

  // ─── 2. Cobrar ────────────────────────────────────────────────────────────

  async charge(args: { workspaceId: string; amountMinor: number; currency: string; chargeRef: string }): Promise<BillingChargeView> {
    const amountMinor = Math.round(Number(args.amountMinor))
    const currency = String(args.currency || 'usd').toLowerCase()

    // Mesma referência = mesma cobrança: devolve o que já existe.
    const existing = await this.loadCharge(args.chargeRef)
    if (existing) return this.chargeView(existing)

    const method = await this.loadMethod(args.workspaceId)
    if (method?.status !== 'active' || !method.whop_member_id || !method.whop_payment_method_id) {
      throw new ConflictException({ code: 'NO_CARD', message: 'Seller sem cartão de cobrança ativo.' })
    }

    const { data: inserted, error } = await supabase
      .from('seller_billing_charges')
      .insert({ charge_ref: args.chargeRef, workspace_id: args.workspaceId, amount_minor: amountMinor, currency })
      .select('*')
      .single()
    if (error) {
      // Corrida com outro pedido da mesma referência: vale o que ganhou.
      if ((error as any).code === '23505') return this.chargeView(await this.loadCharge(args.chargeRef))
      throw new Error(`seller_billing_charges: ${error.message}`)
    }

    const master = await this.master()
    const plan = await this.ensurePlan(master, amountMinor, currency)
    if ('error' in plan) {
      return this.chargeView(await this.updateCharge(inserted.id, { status: 'failed', failure_message: plan.error }))
    }

    const { ok, status, json } = await this.whop(master, '/api/v1/payments', {
      method: 'POST',
      idempotencyKey: `koopfy_billing_${args.chargeRef}`.slice(0, 255),
      body: {
        account_id: master.companyId,
        plan_id: plan.planId,
        member_id: method.whop_member_id,
        payment_method_id: method.whop_payment_method_id,
        metadata: {
          ...this.baseMetadata(args.workspaceId),
          [BILLING_METADATA_KEY]: 'charge',
          koopfy_charge_ref: args.chargeRef,
        },
      },
    })

    if (!ok) {
      const message = json?.error?.message ?? json?.message ?? `Whop HTTP ${status}`
      this.log.error(`cobrança ${args.chargeRef}: ${message}`)
      return this.chargeView(await this.updateCharge(inserted.id, { status: 'failed', failure_message: String(message).slice(0, 500) }))
    }

    const next = billingStatusFromWhopPayment(json)
    return this.chargeView(await this.updateCharge(inserted.id, {
      status: next,
      whop_payment_id: typeof json?.id === 'string' ? json.id : null,
      failure_message: next === 'failed' ? whopFailureMessage(json) ?? 'Cobrança recusada.' : null,
    }))
  }

  /** Estado da cobrança; pendente com pagamento na Whop é consultado na hora. */
  async getCharge(chargeRef: string): Promise<BillingChargeView | null> {
    const row = await this.loadCharge(chargeRef)
    if (!row) return null
    if (row.status !== 'pending' || !row.whop_payment_id) return this.chargeView(row)

    try {
      const master = await this.master()
      const { ok, json } = await this.whop(master, `/api/v1/payments/${encodeURIComponent(row.whop_payment_id)}`)
      if (!ok) return this.chargeView(row)
      const next = billingStatusFromWhopPayment(json)
      if (next === 'pending') return this.chargeView(row)
      return this.chargeView(await this.updateCharge(row.id, {
        status: next,
        failure_message: next === 'failed' ? whopFailureMessage(json) ?? 'Cobrança recusada.' : null,
      }))
    } catch (err: any) {
      this.log.warn(`consulta ${chargeRef}: ${err?.message}`)
      return this.chargeView(row)
    }
  }

  private async loadCharge(chargeRef: string) {
    const { data, error } = await supabase
      .from('seller_billing_charges')
      .select('*')
      .eq('charge_ref', chargeRef)
      .maybeSingle()
    if (error) throw new Error(`seller_billing_charges: ${error.message}`)
    return data as any
  }

  private async updateCharge(id: string, patch: Record<string, any>) {
    const { data, error } = await supabase
      .from('seller_billing_charges')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw new Error(`seller_billing_charges: ${error.message}`)
    return data
  }

  private chargeView(row: any): BillingChargeView {
    return {
      chargeRef: row.charge_ref,
      status: row.status,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
      whopPaymentId: row.whop_payment_id ?? null,
      failureMessage: row.failure_message ?? null,
    }
  }

  /** Um plano por valor/moeda: cobranças de mesmo valor reaproveitam. */
  private async ensurePlan(master: Master, amountMinor: number, currency: string): Promise<{ planId: string } | { error: string }> {
    const price = toWhopPrice(amountMinor, currency)
    const key = [master.companyId, currency, price.toFixed(2)].join('|')
    const cached = SellerBillingService.planCache.get(key)
    if (cached && cached.until > Date.now()) return { planId: cached.id }

    const { ok, status, json } = await this.whop(master, '/api/v1/plans', {
      method: 'POST',
      idempotencyKey: `koopfy_billing_plan_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`,
      body: {
        account_id: master.companyId,
        currency,
        initial_price: price,
        plan_type: 'one_time',
        title: PLAN_TITLE,
        visibility: 'quick_link',
        product: { external_identifier: PRODUCT_EXTERNAL_ID, title: 'Koopfy' },
      },
    })
    const planId = typeof json?.id === 'string' ? json.id : null
    if (!ok || !planId) {
      const message = json?.error?.message ?? `Whop HTTP ${status}`
      this.log.error(`plano da cobrança (${currency} ${price}): ${JSON.stringify(json?.error ?? json).slice(0, 300)}`)
      return { error: `Plano da cobrança: ${message}`.slice(0, 500) }
    }
    SellerBillingService.planCache.set(key, { id: planId, until: Date.now() + 60 * 60 * 1000 })
    return { planId }
  }

  // ─── Webhook ──────────────────────────────────────────────────────────────

  /** Evento da Whop marcado como nosso (metadata koopfy_billing)? */
  static isBillingEvent(body: any): boolean {
    const data = body?.data ?? {}
    const metadata = data?.metadata ?? data?.payment?.metadata ?? {}
    return Boolean(metadata?.[BILLING_METADATA_KEY])
  }

  async handleWebhook(eventType: string, body: any) {
    const data = body?.data ?? {}
    const metadata = data?.metadata ?? data?.payment?.metadata ?? {}
    const workspaceId = String(metadata?.koopfy_workspace_id ?? '')

    if (eventType.startsWith('setup_intent.')) {
      const card = savedCardFromSetupIntent(data)
      if (!card || !workspaceId) return { ignored: true, reason: 'setup intent sem cartão' }
      const row = await this.loadMethod(workspaceId)
      if (!row?.setup_session_id || !setupIntentMatches(data, row.setup_session_id, workspaceId)) {
        return { ignored: true, reason: 'sessão de setup não é a atual' }
      }
      await this.saveCard(workspaceId, card)
      return { handled: 'seller_billing_setup' }
    }

    if (eventType === 'payment.succeeded' || eventType === 'payment.failed') {
      const chargeRef = String(metadata?.koopfy_charge_ref ?? '')
      const row = chargeRef ? await this.loadCharge(chargeRef) : null
      if (!row) return { ignored: true, reason: 'cobrança de comissão desconhecida' }
      if (row.status !== 'pending') return { alreadyProcessed: true }
      const paid = eventType === 'payment.succeeded'
      await this.updateCharge(row.id, {
        status: paid ? 'paid' : 'failed',
        whop_payment_id: row.whop_payment_id ?? data?.id ?? null,
        failure_message: paid ? null : whopFailureMessage(data) ?? 'Cobrança recusada.',
      })
      return { handled: 'seller_billing_charge' }
    }

    return { ignored: true, reason: 'evento de cobrança sem ação' }
  }
}
