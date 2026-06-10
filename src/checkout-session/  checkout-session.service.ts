// nexor/src/checkout/checkout.service.ts

import { Injectable, BadRequestException } from '@nestjs/common'
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '../lib/supabase.client'
import { AccountRouterService } from '../orchestrator/router/account-router.service'

// ─────────────────────────────────────────────────────────────────────────────
// HOSTED PROVIDERS — checkout tudo-em-um (iframe hospedado pelo provedor).
//
// Stripe Crypto é hosted (iframe Onramp).
// Stripe Payment Element NÃO é hosted — renderiza nativo no checkout via
// stripe-js + PaymentElement, usando flow 'client'.
// ─────────────────────────────────────────────────────────────────────────────

const HOSTED_PROVIDERS = new Set<string>(['viva', 'stripe_crypto'])

// FIXED_PROVIDERS — selecionados via seller.provider_default, não via router.
// Quando seller fixa um desses, pulamos a competição por país/risco/balanço.
//
// Stripe (Payment Element) também é fixo — quando seller escolhe Stripe,
// queremos que apareça SÓ Stripe (com todos os métodos que a conta dele tem
// habilitada na dashboard Stripe).
const FIXED_PROVIDERS = new Set<string>(['stripe_crypto', 'stripe'])

// Métodos que NÃO vão pro routing/methods — são tratados pelo
// ExpressCheckoutElement do Stripe no topo do checkout.
const STRIPE_EXPRESS_METHODS = new Set(['apple_pay', 'google_pay', 'link'])

// ─────────────────────────────────────────────────────────────────────────────
// FLOW MAP — apenas para providers granulares (não-hosted).
// ─────────────────────────────────────────────────────────────────────────────

type Flow = 'client' | 'redirect' | 'server' | 'hosted'

const GRANULAR_FLOW_MAP: Record<string, Flow> = {
  card: 'client',
  apple_pay: 'client',
  google_pay: 'client',
  pix: 'server',
  mbway: 'server',
  multibanco: 'server',
  ideal: 'redirect',
  bancontact: 'redirect',
  swish: 'redirect',
  twint: 'redirect',
  mobile_pay: 'redirect',
  eps: 'redirect',
  klarna: 'redirect',
  p24: 'redirect',
  blik: 'redirect',
}

// ─────────────────────────────────────────────────────────────────────────────
// Coerção do amount: aceita number ou string e converte pra centavos integer.
// ─────────────────────────────────────────────────────────────────────────────

function coerceAmountToCents(raw: unknown): number {
  if (raw == null) {
    throw new BadRequestException('amount is required')
  }

  const str = typeof raw === 'string'
    ? raw.trim().replace(',', '.')
    : String(raw)

  const num = Number(str)
  if (!Number.isFinite(num) || num <= 0) {
    throw new BadRequestException(`Invalid amount: ${raw}`)
  }

  if (Number.isInteger(num) && num >= 100) {
    return num
  }

  console.warn(
    `[CheckoutService] amount recebido em unidade principal (${raw}) — ` +
    `convertendo pra centavos. O caller deve enviar centavos integer.`,
  )

  return Math.round(num * 100)
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class CheckoutService {

  constructor(
    private readonly router: AccountRouterService,
  ) { }

  // ─── createSession ────────────────────────────────────────────────────────

  async createSession(dto: {
    sellerId: string
    country: string
    currency: string
    amount: number | string
    method?: string
    metadata?: any
  }) {
    const { sellerId, country, currency, method, metadata } = dto
    const amount = coerceAmountToCents(dto.amount)

    const seller = await this.getSeller(sellerId)
    if (!seller) throw new BadRequestException('Seller not found')

    // ── Caminho 1: provider FIXO (stripe_crypto, stripe, ...) ──
    if (seller.provider_default && FIXED_PROVIDERS.has(seller.provider_default)) {
      const payload = await this.buildFixedProviderSession({
        sellerId,
        provider: seller.provider_default,
        seller,
        customerCountry: country,
      })

      return this.persistAndReturn({
        sellerId, amount, currency, country, metadata, payload,
      })
    }

    // ── Caminho 2: roteamento padrão (Viva e futuros hosted competitivos) ──
    const winner = await this.resolveHostedByCountry({
      sellerId, country, currency, amount,
      riskLevel: seller.risk_level,
    })

    if (!winner) {
      throw new BadRequestException(
        method
          ? `No account available for method=${method} in ${country}`
          : `No hosted account available in ${country}`,
      )
    }

    const { account, providerName, candidates } = winner
    const isHosted = HOSTED_PROVIDERS.has(providerName)

    const payload = isHosted
      ? this.buildHostedSession(account, providerName)
      : this.buildGranularSession({
        method: method!, account, providerName, candidates,
      })

    return this.persistAndReturn({
      sellerId, amount, currency, country, metadata, payload,
    })
  }

  // ─── Build: provider fixo (Stripe Crypto, Stripe, futuros) ────────────────

  private async buildFixedProviderSession(args: {
    sellerId: string
    provider: string
    seller: any
    customerCountry: string
  }): Promise<{ methods: any[]; routing: Record<string, any> }> {
    const account = await this.router.getAccountByProvider({
      sellerId: args.sellerId,
      provider: args.provider,
      customerCountry: args.customerCountry,  // 🆕
    })

    if (!account) {
      throw new BadRequestException(
        `Seller has provider_default='${args.provider}' but no active account for it`,
      )
    }

    if (args.provider === 'stripe_crypto') {
      return this.buildStripeCryptoSession(account)
    }

    if (args.provider === 'stripe') {
      return this.buildStripeSession(account, args.seller)
    }

    throw new BadRequestException(
      `Fixed provider '${args.provider}' not implemented yet`,
    )
  }

  // ─── Build: Stripe Crypto (mantida igual) ─────────────────────────────────

  private buildStripeCryptoSession(account: any) {
    const config = account.metadata ?? {}
    const {
      publishable_key,
      wallet_address,
      network,
      currency: cryptoCurrency,
    } = config

    if (!publishable_key) {
      throw new BadRequestException(
        `Stripe Crypto account ${account.id} missing publishable_key in config`,
      )
    }
    if (!wallet_address || !network || !cryptoCurrency) {
      throw new BadRequestException(
        `Stripe Crypto account ${account.id} incomplete: ` +
        `wallet_address=${!!wallet_address} network=${!!network} ` +
        `currency=${!!cryptoCurrency}`,
      )
    }

    const methods = [{
      type: 'crypto',
      flow: 'hosted',
      provider: 'stripe_crypto',
      providerAccountId: account.id,
      publishableKey: publishable_key,
      cryptoDestination: {
        wallet: wallet_address,
        network,
        currency: cryptoCurrency,
      },
    }]

    const routing = {
      crypto: {
        provider_account_id: account.id,
        provider: 'stripe_crypto',
      },
    }

    return { methods, routing }
  }

  // ─── Build: Stripe Payment Element ────────────────────────────────────────
  //
  // Lê config JSON do provider_accounts.metadata:
  //   {
  //     "publishable_key": "pk_live_...",
  //     "secret_key":      "sk_live_..."   ← usada só no backend
  //   }
  //
  // E lê seller.payment_routing pra saber quais métodos oferecer e montar
  // o routing GRANULAR (uma entrada por método, todas apontando pra mesma
  // conta Stripe).
  //
  // O frontend (parsePaymentSettings) reconhece o método sintético "stripe"
  // e dispara expandStripeMethods que cruza payment_routing × país do cliente
  // pra gerar a lista visual granular. Aqui no backend listamos TODOS os
  // métodos possíveis no routing — frontend filtra por país.
  //
  // ⚠️ Por que routing granular?
  //
  //    O PaymentService.createPayment espera routing[method].provider_account_id
  //    pra saber qual conta usar. Pra Viva é ['hosted'], pra Stripe Crypto é
  //    ['crypto'], mas pra Stripe Payment Element, cada método (card, ideal,
  //    bancontact, mbway...) é uma cobrança separada e PRECISA de uma entrada
  //    própria no routing — mesmo que todas apontem pra a mesma conta.

  private buildStripeSession(account: any, seller: any) {
    const config = account.metadata ?? {}
    const { publishable_key } = config

    if (!publishable_key) {
      throw new BadRequestException(
        `Stripe account ${account.id} missing publishable_key in config`,
      )
    }

    const enabledMethods = this.collectStripeEnabledMethods(seller)

    if (enabledMethods.length === 0) {
      throw new BadRequestException(
        `Seller ${seller?.id} has provider_default='stripe' but no methods ` +
        `enabled in payment_routing`,
      )
    }

    // methods[]: 1 método sintético "stripe" — frontend reconhece e expande
    const methods = [{
      type: 'stripe',
      flow: 'client',
      provider: 'stripe',
      providerAccountId: account.id,
      publishableKey: publishable_key,
    }]

    console.log(methods)
    // routing: ENTRADA POR MÉTODO — todas apontam pra mesma provider_account
    const routing: Record<string, any> = {}
    for (const methodType of enabledMethods) {
      routing[methodType] = {
        provider_account_id: account.id,
        provider: 'stripe',
      }
    }

    return { methods, routing }
  }

  // ─── Helper: coleta métodos enabled no seller.payment_routing ────────────
  //
  // Combina TODAS as entradas (GLOBAL + cada país) num set único.
  // Filtra fora apple_pay/google_pay/link — esses são tratados pelo
  // ExpressCheckoutElement no frontend, não como método individual.
  //
  // Defensivo: aceita o payment_routing em vários lugares possíveis do
  // seller (raiz, metadata, config) pra não depender de schema fixo.

  private collectStripeEnabledMethods(seller: any): string[] {
    const enabledMethods =
      seller?.enabled_methods
      ?? seller?.metadata?.enabled_methods
      ?? seller?.config?.enabled_methods
      ?? null

    if (!Array.isArray(enabledMethods) || enabledMethods.length === 0) {
      console.warn(
        `[buildStripeSession] seller ${seller?.id} sem enabled_methods — ` +
        `fallback ['card']`,
      )
      return ['card']
    }

    return enabledMethods
      .filter((m: any) => typeof m === 'string')
      .filter((m: string) => !STRIPE_EXPRESS_METHODS.has(m))
  }
  // ─── Resolução hosted (Viva) por país ─────────────────────────────────────

  private async resolveHostedByCountry(ctx: {
    sellerId: string
    country: string
    currency: string
    amount: number
    riskLevel: string
  }) {
    // Stripe Crypto e Stripe não competem por país — são fixos via provider_default.
    const competitiveHosted = Array.from(HOSTED_PROVIDERS)
      .filter(p => !FIXED_PROVIDERS.has(p))

    const candidates = await this.router.getHostedCandidates({
      sellerId: ctx.sellerId,
      country: ctx.country,
      currency: ctx.currency,
      amount: ctx.amount,
      riskLevel: ctx.riskLevel,
      hostedProviders: competitiveHosted,
    })

    console.log(candidates)

    if (!candidates.length) return null

    const winner = candidates[0]
    return {
      account: winner,
      providerName: this.normalizeProviderName(winner.provider),
      candidates,
    }
  }

  // ─── Build hosted session (Viva — mantida igual) ──────────────────────────

  private buildHostedSession(account: any, providerName: string) {
    const methods = [{
      type: 'hosted',
      flow: 'hosted',
      provider: providerName,
      providerAccountId: account.id,
    }]

    const routing = {
      hosted: {
        provider_account_id: account.id,
        provider: providerName,
      },
    }

    return { methods, routing }
  }

  // ─── Build granular session (mantida igual) ───────────────────────────────

  private buildGranularSession(args: {
    method: string
    account: any
    providerName: string
    candidates: any[]
  }) {
    const { method, account, providerName, candidates } = args
    const flow = GRANULAR_FLOW_MAP[method] ?? 'server'

    const config: any = {
      type: method,
      flow,
      provider: providerName,
      providerAccountId: account.id,
    }

    if (flow === 'client') {
      if (!account?.public_key) {
        throw new Error(
          `Account ${account.id} (${providerName}) missing public_key for client flow`,
        )
      }
      config.publishableKey = account.public_key
    }

    const routing = {
      [method]: {
        provider_account_id: account.id,
        provider: providerName,
        candidates: candidates.slice(0, 3).map(c => ({ id: c.id })),
      },
    }

    return { methods: [config], routing }
  }

  // ─── Persistência da sessão (mantida igual) ───────────────────────────────

  private async persistAndReturn(args: {
    sellerId: string
    amount: number
    currency: string
    country: string
    metadata: any
    payload: { methods: any[]; routing: Record<string, any> }
  }) {
    const sessionId = `cs_${uuidv4()}`

    const { error } = await supabase.from('checkout_sessions').insert({
      id: sessionId,
      seller_id: args.sellerId,
      amount: args.amount,
      currency: args.currency,
      country: args.country,
      status: 'created',
      routing: args.payload.routing,
      metadata: args.metadata || {},
      created_at: new Date().toISOString(),
    })

    if (error) throw new Error(`Failed to persist checkout session: ${error.message}`)

    return {
      sessionId,
      amount: args.amount,
      currency: args.currency,
      country: args.country,
      methods: args.payload.methods,
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private normalizeProviderName(provider: any): string {
    if (!provider) return 'unknown'

    const raw = typeof provider === 'string'
      ? provider
      : (provider.constructor?.name ?? String(provider))

    return raw.toLowerCase().replace(/provider$/, '')
  }

  async getSeller(id: string) {
    const { data } = await supabase
      .from('seller_profiles')
      .select('*')
      .eq('id', id)
      .single()
    return data
  }
}