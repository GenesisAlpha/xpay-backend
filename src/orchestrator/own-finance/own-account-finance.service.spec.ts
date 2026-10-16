// OwnAccountFinanceService sem banco e sem rede: o supabase é dublado por
// tabela, as contas vêm de dublês do roteamento e das conexões, e o "provedor"
// é um fetch falso que responde por URL.

const tables: Record<string, any[]> = {}

jest.mock('../../lib/supabase.client', () => ({
  supabase: {
    from: (table: string) => {
      const filters: Array<[string, any]> = []
      const rows = () => (tables[table] ?? []).filter(row => filters.every(([column, value]) => row[column] === value))
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: any) => { filters.push([column, value]); return builder },
        order: () => builder,
        limit: () => builder,
        single: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: any) => resolve({ data: rows(), error: null }),
        insert: (row: any) => {
          const saved = { id: `w-${(tables[table] ??= []).length + 1}`, created_at: '2026-10-01T12:00:00Z', ...row }
          tables[table].push(saved)
          return { select: () => ({ single: async () => ({ data: saved, error: null }) }), then: (resolve: any) => resolve({ error: null }) }
        },
        update: (patch: any) => ({
          eq: async (column: string, value: any) => {
            for (const r of tables[table] ?? []) if (r[column] === value) Object.assign(r, patch)
            return { error: null }
          },
        }),
      }
      return builder
    },
  },
}))
jest.mock('../../crypto/crypto.service', () => ({ CryptoService: class { } }))

import { BadRequestException, NotFoundException } from '@nestjs/common'
import { OwnAccountFinanceService } from './own-account-finance.service'

const SELLER = 's-1'
const WHOP = 'whopl_biz_AAA'
const WHOP_EXTRA = 'whopa_11111111-1111-4111-8111-111111111111'
const STRIPE = 'stripel_22222222-2222-4222-8222-222222222222'
const PAYPAL = 'paypall_33333333-3333-4333-8333-333333333333'

const VIEW_ACCOUNTS = [
  { id: WHOP, provider: 'whop', group: 'card', primary: true, label: null, accountName: 'Loja A', status: 'active', paused: false },
  { id: WHOP_EXTRA, provider: 'whop', group: 'card', primary: false, label: 'Reserva', accountName: 'Loja B', status: 'standby', paused: false },
  { id: STRIPE, provider: 'stripe', group: 'card', primary: false, label: null, accountName: 'Stripe US', mode: 'live', status: 'active', paused: false },
  { id: PAYPAL, provider: 'paypal', group: 'paypal', primary: false, label: null, accountName: 'PayPal', mode: 'live', status: 'active', paused: false },
]

const CREDENTIALS: Record<string, any> = {
  [WHOP]: { id: WHOP, provider: 'whop', apiKey: 'whop-key-a', api_url: 'https://api.whop.test', config: { company_id: 'biz_AAA', seller_id: SELLER } },
  [WHOP_EXTRA]: { id: WHOP_EXTRA, provider: 'whop', apiKey: 'whop-key-b', api_url: 'https://api.whop.test', config: { company_id: 'biz_BBB', seller_id: SELLER } },
  [STRIPE]: { id: STRIPE, provider: 'stripe', apiKey: 'sk_live_x', config: { seller_id: SELLER, mode: 'live' } },
  [PAYPAL]: { id: PAYPAL, provider: 'paypal', apiKey: 'client-id', apiSecret: 'client-secret', config: { seller_id: SELLER, mode: 'live' } },
}

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined }

function build(routes: Record<string, (call: Call) => { status?: number; json: any }>, accounts = VIEW_ACCOUNTS) {
  const calls: Call[] = []
  const routing: any = { view: async () => ({ accounts }) }
  const whopLinked: any = { getProviderAccountById: async (id: string) => CREDENTIALS[id] ?? null }
  const sellerProviders: any = { getProviderAccountById: async (id: string) => CREDENTIALS[id] ?? null }
  const svc = new OwnAccountFinanceService(routing, whopLinked, sellerProviders)
  svc.fetchImpl = async (url: string, init: any = {}) => {
    const call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body }
    calls.push(call)
    const key = Object.keys(routes).find(pattern => url.includes(pattern))
    if (!key) return { ok: false, status: 404, json: async () => ({ error: { message: `sem rota para ${url}` } }) }
    const reply = routes[key](call)
    const status = reply.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => reply.json }
  }
  svc.paypalTokenCache = { get: async () => ({ token: 'paypal-token', appId: null }), invalidate: () => undefined } as any
  return { svc, calls }
}

const WHOP_LEDGER = {
  treasury_balance: { currency: 'usd', balance: '150.00', pending_balance: '40.00', reserve_balance: '10.00', total_withdrawable_balance: '120.00' },
  balances: [{ currency: 'usd', balance: '150.00', pending_balance: '40.00', reserve_balance: '10.00' }],
}

const ROUTES = {
  '/ledger_accounts/biz_AAA': () => ({ json: WHOP_LEDGER }),
  '/ledger_accounts/biz_BBB': () => ({ status: 403, json: { error: { message: 'forbidden' } } }),
  '/payout_methods?account_id=biz_AAA': () => ({ json: { data: [{ id: 'pm_1', currency: 'usd', is_default: true, account_reference: '****1234', institution_name: 'Chase' }] } }),
  '/v1/balance': () => ({ json: { available: [{ amount: 80000, currency: 'usd' }], pending: [{ amount: 20000, currency: 'usd' }] } }),
  '/v1/account': () => ({ json: { default_currency: 'usd', settings: { payouts: { schedule: { interval: 'daily', delay_days: 2 } } } } }),
  '/v1/payouts?limit': () => ({ json: { data: [{ id: 'po_1', amount: 30000, currency: 'usd', status: 'paid', automatic: true, created: 1789900000 }] } }),
  '/v1/reporting/balances': () => ({ json: { balances: [{ currency: 'USD', primary: true, available_balance: { value: '55.00' }, withheld_balance: { value: '5.00' } }] } }),
}

describe('OwnAccountFinanceService', () => {
  beforeEach(() => { for (const key of Object.keys(tables)) delete tables[key] })

  it('visão geral: cada conta com o saldo dela, total por moeda, e a conta que falha não derruba as outras', async () => {
    const { svc } = build(ROUTES)
    const overview = await svc.overview(SELLER)

    const byId = Object.fromEntries(overview.accounts.map(account => [account.id, account]))
    expect(byId[WHOP].balance).toMatchObject({ availableCents: 15000, pendingCents: 4000, withdrawableCents: 12000 })
    expect(byId[STRIPE].balance).toMatchObject({ availableCents: 80000, pendingCents: 20000 })
    expect(byId[PAYPAL].balance).toMatchObject({ availableCents: 5500, reservedCents: 500 })
    // Chave sem permissão: a conta continua na lista, com o motivo.
    expect(byId[WHOP_EXTRA].balance).toBeNull()
    expect(byId[WHOP_EXTRA].error).toContain('permissão de saldo e saque')

    expect(overview.totals).toEqual([
      { currency: 'usd', availableCents: 100500, pendingCents: 24000, reservedCents: 1500, accounts: 3 },
    ])
    expect(byId[PAYPAL].capabilities.withdraw).toBe(false)
  })

  it('cada conta é lida com a credencial DELA', async () => {
    const { svc, calls } = build(ROUTES)
    await svc.overview(SELLER)
    const auth = (pattern: string) => calls.find(call => call.url.includes(pattern))?.headers.Authorization
    expect(auth('/ledger_accounts/biz_AAA')).toBe('Bearer whop-key-a')
    expect(auth('/ledger_accounts/biz_BBB')).toBe('Bearer whop-key-b')
    expect(auth('/v1/balance')).toBe('Bearer sk_live_x')
    expect(auth('/v1/reporting/balances')).toBe('Bearer paypal-token')
  })

  it('carteira da Stripe: saldo, agenda de repasse e histórico vindos da própria Stripe', async () => {
    const { svc } = build(ROUTES)
    const wallet = await svc.wallet(SELLER, STRIPE)
    expect(wallet.schedule).toEqual({ interval: 'daily', delayDays: 2 })
    expect(wallet.withdrawals).toEqual([expect.objectContaining({ id: 'po_1', amountCents: 30000, status: 'completed', automatic: true })])
    expect(wallet.payoutMethods).toEqual([])
    expect(wallet.capabilities.chooseDestination).toBe(false)
  })

  it('conta de outro seller (ou desconectada) responde "não encontrada", sem tocar no provedor', async () => {
    const { svc, calls } = build(ROUTES)
    await expect(svc.wallet(SELLER, 'stripel_99999999-9999-4999-8999-999999999999')).rejects.toBeInstanceOf(NotFoundException)
    expect(calls).toHaveLength(0)

    // Está na lista do seller, mas a credencial guardada é de outro: nunca sai.
    const original = CREDENTIALS[STRIPE]
    CREDENTIALS[STRIPE] = { ...original, config: { ...original.config, seller_id: 'outro' } }
    try {
      await expect(svc.wallet(SELLER, STRIPE)).rejects.toBeInstanceOf(BadRequestException)
      expect(calls).toHaveLength(0)
    } finally {
      CREDENTIALS[STRIPE] = original
    }
  })

  it('saque na Whop: registra, pede com a chave de idempotência e guarda o que a Whop devolveu', async () => {
    const { svc, calls } = build({
      ...ROUTES,
      // API v1: cotação + POST /payouts (a antiga /withdrawals responde 410).
      '/api/v1/payouts/quotes': () => ({ json: { quote_token: 'pqt_1', expires_at: '2026-10-03T00:10:00Z' } }),
      '/api/v1/payouts': call => call.method === 'POST'
        ? { json: { id: 'wdrl_1', status: 'requested', fee_amount: '1.50', markup_fee: '0', estimated_arrival: '2026-10-03T00:00:00Z' } }
        : { json: { status: 'requested' } },
    })
    const wallet = await svc.withdraw(SELLER, WHOP, { amountCents: 10000, currency: 'USD', payoutMethodId: 'pm_1' }, 'seller:u-1')

    const post = calls.find(call => call.method === 'POST' && call.url.endsWith('/api/v1/payouts'))!
    const sent = JSON.parse(post.body!)
    expect(sent).toMatchObject({ account_id: 'biz_AAA', payout_method_id: 'pm_1', amount: 100, currency: 'usd', quote_token: 'pqt_1' })
    expect(post.headers['Idempotency-Key']).toEqual(expect.any(String))
    const quote = calls.find(call => call.method === 'POST' && call.url.endsWith('/api/v1/payouts/quotes'))!
    expect(quote.headers['Idempotency-Key']).toBe(`${post.headers['Idempotency-Key']}_quote`)

    expect(tables.whop_linked_withdrawals[0]).toMatchObject({
      seller_id: SELLER, whop_account_id: 'biz_AAA', amount_cents: 10000, whop_withdrawal_id: 'wdrl_1', status: 'requested', fee_cents: 150, requested_by: 'seller:u-1',
    })
    expect(wallet.withdrawals[0]).toMatchObject({ externalId: 'wdrl_1', amountCents: 10000, feeCents: 150 })
    expect(tables.crm_action_log[0]).toMatchObject({ action: 'own_finance.withdrawal', payload: expect.objectContaining({ account_id: WHOP, actor: 'seller:u-1' }) })
  })

  it('saque acima do que o provedor libera é recusado antes de pedir', async () => {
    const { svc, calls } = build(ROUTES)
    await expect(svc.withdraw(SELLER, WHOP, { amountCents: 12001, currency: 'usd', payoutMethodId: 'pm_1' }))
      .rejects.toThrow('Valor acima do disponível para saque (120.00 USD)')
    expect(calls.some(call => call.method === 'POST')).toBe(false)
  })

  it('saque na Whop sem escolher a conta bancária é recusado', async () => {
    const { svc } = build(ROUTES)
    await expect(svc.withdraw(SELLER, WHOP, { amountCents: 1000, currency: 'usd' })).rejects.toThrow('Escolha para qual conta bancária')
  })

  it('saque na Stripe: repasse manual na menor unidade da moeda, com chave de idempotência', async () => {
    const { svc, calls } = build({
      ...ROUTES,
      '/v1/payouts': call => call.method === 'POST' ? { json: { id: 'po_new' } } : ROUTES['/v1/payouts?limit'](),
    })
    await svc.withdraw(SELLER, STRIPE, { amountCents: 50000, currency: 'usd' })
    const post = calls.find(call => call.method === 'POST' && call.url.endsWith('/v1/payouts'))!
    expect(new URLSearchParams(post.body).get('amount')).toBe('50000')
    expect(new URLSearchParams(post.body).get('currency')).toBe('usd')
    expect(post.headers['Idempotency-Key']).toEqual(expect.any(String))
  })

  it('PayPal: saldo aparece, mas o saque é no painel dele', async () => {
    const { svc, calls } = build(ROUTES)
    await expect(svc.withdraw(SELLER, PAYPAL, { amountCents: 1000, currency: 'usd' })).rejects.toThrow('painel do provedor')
    expect(calls).toHaveLength(0)
  })

  it('recusa do provedor no saque vira mensagem para o seller e o registro fica como falho', async () => {
    const { svc } = build({
      ...ROUTES,
      '/api/v1/payouts': () => ({ status: 422, json: { error: { message: 'payout account not verified' } } }),
    })
    await expect(svc.withdraw(SELLER, WHOP, { amountCents: 1000, currency: 'usd', payoutMethodId: 'pm_1' }))
      .rejects.toThrow('A Whop recusou o saque: payout account not verified')
    expect(tables.whop_linked_withdrawals[0]).toMatchObject({ status: 'failed', failure_reason: 'payout account not verified' })
  })
})
