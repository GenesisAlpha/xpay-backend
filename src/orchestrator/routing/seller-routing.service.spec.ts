// SellerRoutingService sem banco e sem rede: o supabase é dublado por tabela
// (com upsert pela chave de conflito) e as contas vêm de dublês dos serviços
// de conexão. Cobre: roteamento desligado = nada muda, atribuição por sessão
// (reuso, 409 ROUTING_REASSIGNED), ligar/desligar, breaker e CRM.

const tables: Record<string, any[]> = {}

function matches(row: any, filters: Array<[string, string, any]>) {
  return filters.every(([op, column, value]) => {
    if (op === 'eq') return row[column] === value
    if (op === 'neq') return row[column] !== value
    if (op === 'in') return (value as any[]).includes(row[column])
    if (op === 'prefix') return (value as string[]).some(prefix => String(row[column]).startsWith(prefix))
    return true
  })
}

jest.mock('../../lib/supabase.client', () => ({
  supabase: {
    from: (table: string) => {
      const filters: Array<[string, string, any]> = []
      const rows = () => (tables[table] ?? []).filter(row => matches(row, filters))
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: any) => { filters.push(['eq', column, value]); return builder },
        neq: (column: string, value: any) => { filters.push(['neq', column, value]); return builder },
        in: (column: string, value: any[]) => { filters.push(['in', column, value]); return builder },
        gte: () => builder,
        // Histórico: `or('action.like.routing.%,…')` filtra pelos prefixos.
        or: (expr: string) => {
          const prefixes = expr.split(',').map(part => part.replace(/^action\.like\./, '').replace(/%$/, ''))
          filters.push(['prefix', 'action', prefixes])
          return builder
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: any) => resolve({ data: rows(), error: null }),
        insert: async (row: any) => { (tables[table] ??= []).push(row); return { error: null } },
        upsert: async (row: any, opts: { onConflict: string }) => {
          const keys = opts.onConflict.split(',')
          const list = (tables[table] ??= [])
          const found = list.find(r => keys.every(k => r[k] === row[k]))
          if (found) Object.assign(found, row)
          else list.push({ ...row })
          return { error: null }
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

import { BadRequestException, ConflictException } from '@nestjs/common'
import { SellerRoutingService } from './seller-routing.service'
import { AccountRouterService } from '../router/account-router.service'
import { ownAccountIdOfRow } from '../seller-provider/seller-provider-accounts'

const SELLER = 's-1'

function providerRow(id: string, provider: 'stripe' | 'paypal' | 'whop', extra: Record<string, any> = {}) {
  return {
    id,
    seller_id: SELLER,
    provider,
    status: 'active',
    mode: 'live',
    account_ref: `ref_${id}`,
    display_name: `Conta ${id}`,
    public_key: provider === 'paypal' ? `client_${id}` : `pk_${id}`,
    secret_enc: 'secret',
    created_at: `2026-09-2${id.length}T00:00:00Z`,
    ...extra,
  }
}

function build(opts: { principal?: any; breakerOpen?: (id: string) => boolean } = {}) {
  const sellerProviders: any = {
    listRows: async () => (tables.seller_provider_accounts ?? []).filter(r => r.seller_id === SELLER),
    accountFromRow: (row: any) => ({
      id: ownAccountIdOfRow(row),
      provider: row.provider,
      status: row.status === 'active' ? 'active' : 'inactive',
      config: { publishable_key: row.public_key, seller_id: row.seller_id, linked: true },
      apiKey: 'sk',
    }),
    setRowsStatus: async (_sellerId: string, ids: string[], status: string) => {
      for (const row of tables.seller_provider_accounts ?? []) if (ids.includes(row.id)) row.status = status
    },
  }
  const whopLinked: any = {
    getRow: async () => opts.principal ?? null,
    getProviderAccountForSeller: async () => (opts.principal
      ? { id: `whopl_${opts.principal.whop_account_id}`, provider: 'whop', status: 'active', config: { company_id: opts.principal.whop_account_id, seller_id: SELLER } }
      : null),
  }
  const router: any = {
    accountBreakerOpen: (id: string) => opts.breakerOpen?.(id) ?? false,
    getDailyMetrics: async () => new Map(),
    resolveStickyAccountAnyProvider: async () => null,
    resolveAccountById: async (id: string) => ({ id, config: { seller_id: SELLER } }),
  }
  const svc = new SellerRoutingService(router, whopLinked, sellerProviders)
  svc.now = () => Date.parse('2026-09-28T12:00:00Z')
  return svc
}

function enableRouting(extra: Record<string, any> = {}) {
  tables.seller_routing_settings = [{ seller_id: SELLER, enabled: true, fee_accepted_at: '2026-09-28T00:00:00Z', card_strategy: 'priority_cap', paypal_strategy: 'orders_split', ...extra }]
}

function routingConfig(id: string, fields: Record<string, any>) {
  ;(tables.seller_routing_accounts ??= []).push({ provider_account_id: id, seller_id: SELLER, provider: 'stripe', ...fields })
}

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key]
  delete process.env.ROUTING_FEE_PCT_DEFAULT
})

describe('roteamento desligado', () => {
  it('config e venda seguem o caminho de sempre (null), sem gravar nada', async () => {
    tables.seller_provider_accounts = [providerRow('aaa', 'stripe'), providerRow('bbb', 'stripe')]
    const svc = build()
    expect(await svc.resolveForConfig(SELLER, 'sess-1')).toBeNull()
    expect(await svc.resolveForSale(SELLER, { method: 'card', routingKey: 'sess-1' })).toBeNull()
    expect(await svc.feeForSale(SELLER)).toBe(0)
    expect(tables.routing_assignments).toBeUndefined()
  })
})

describe('atribuição por sessão', () => {
  beforeEach(() => {
    enableRouting()
    tables.seller_provider_accounts = [
      providerRow('aaa', 'stripe'),
      providerRow('bbbb', 'whop'),
      providerRow('ccccc', 'paypal'),
    ]
    routingConfig('stripel_aaa', { priority: 1 })
    routingConfig('whopa_bbbb', { priority: 2, provider: 'whop' })
  })

  it('config escolhe cartão e PayPal da sessão e grava a atribuição', async () => {
    const pick = await build().resolveForConfig(SELLER, 'sess-1')
    expect(pick).toMatchObject({ card: { id: 'stripel_aaa', provider: 'stripe' }, paypal: { id: 'paypall_ccccc' }, cardAccounts: 2, paypalAccounts: 1 })
    expect(tables.routing_assignments).toEqual([
      expect.objectContaining({ routing_key: 'sess-1', seller_id: SELLER, card_account_id: 'stripel_aaa', paypal_account_id: 'paypall_ccccc' }),
    ])
  })

  it('reaproveita a conta da sessão enquanto ela for elegível, mesmo que a estratégia hoje escolhesse outra', async () => {
    const svc = build()
    await svc.resolveForConfig(SELLER, 'sess-1')
    // A Whop passa a ter prioridade: sessão nova iria para ela, a antiga não muda.
    tables.seller_routing_accounts.find(r => r.provider_account_id === 'whopa_bbbb').priority = 0
    expect((await svc.resolveForConfig(SELLER, 'sess-1'))?.card?.id).toBe('stripel_aaa')
    expect((await svc.resolveForConfig(SELLER, 'sess-2'))?.card?.id).toBe('whopa_bbbb')

    const sale = await svc.resolveForSale(SELLER, { method: 'card', routingKey: 'sess-1', ctx: { country: 'BR', amountUsdCents: 1000 } })
    expect(sale).toMatchObject({ kind: 'account', provider: 'stripe', feePct: 0.8, reason: 'session', entry: { id: 'stripel_aaa' } })
    const paypal = await svc.resolveForSale(SELLER, { method: 'paypal', routingKey: 'sess-1' })
    expect(paypal).toMatchObject({ kind: 'account', provider: 'paypal', entry: { id: 'paypall_ccccc' } })
  })

  it('conta da sessão pausada: 409 ROUTING_REASSIGNED e a sessão já aponta para a nova', async () => {
    const svc = build()
    await svc.resolveForConfig(SELLER, 'sess-1')
    tables.seller_routing_accounts.find(r => r.provider_account_id === 'stripel_aaa').paused_at = '2026-09-28T11:00:00Z'
    tables.seller_routing_accounts.find(r => r.provider_account_id === 'stripel_aaa').pause_reason = 'manual'

    const err = await svc.resolveForSale(SELLER, { method: 'card', routingKey: 'sess-1' }).catch(e => e)
    expect(err).toBeInstanceOf(ConflictException)
    expect(err.getStatus()).toBe(409)
    expect(err.getResponse()).toMatchObject({ error: 'ROUTING_REASSIGNED' })
    // Mesmo com outra conta Whop elegível, não troca em silêncio: o formulário
    // do navegador foi montado com a pk da Stripe dela.
    expect(tables.routing_assignments[0]).toMatchObject({ card_account_id: 'whopa_bbbb', paypal_account_id: 'paypall_ccccc' })
    // A recarga das formas de pagamento já vem com a nova conta.
    expect((await svc.resolveForConfig(SELLER, 'sess-1'))?.card?.id).toBe('whopa_bbbb')
  })

  it('conta que o navegador declarou (sem sessão gravada) segue a mesma regra', async () => {
    const svc = build()
    tables.seller_provider_accounts[0].status = 'standby' // saiu do ar
    const err = await svc.resolveForSale(SELLER, { method: 'card', providerAccountId: 'stripel_aaa' }).catch(e => e)
    expect(err).toBeInstanceOf(ConflictException)
  })

  it('filtro de país na venda: a conta da sessão não atende → 409', async () => {
    const svc = build()
    await svc.resolveForConfig(SELLER, 'sess-1')
    tables.seller_routing_accounts.find(r => r.provider_account_id === 'stripel_aaa').countries = ['US']
    await expect(svc.resolveForSale(SELLER, { method: 'card', routingKey: 'sess-1', ctx: { country: 'BR' } }))
      .rejects.toBeInstanceOf(ConflictException)
  })

  it('retry com a mesma chave de idempotência volta para a conta da tentativa', async () => {
    tables.transactions = [{ seller_id: SELLER, idempotency_key: 'idem-1', provider_account_id: 'whopa_bbbb' }]
    const sale = await build().resolveForSale(SELLER, { method: 'card', routingKey: 'sess-9', idempotencyKey: 'idem-1' })
    expect(sale).toMatchObject({ kind: 'account', reason: 'idempotency', entry: { id: 'whopa_bbbb' } })
  })

  it('sem sessão: escolhe pela estratégia; nenhuma elegível → erro claro (sem pool da Koopfy)', async () => {
    const svc = build()
    expect(await svc.resolveForSale(SELLER, { method: 'card' })).toMatchObject({ kind: 'account', reason: 'strategy', entry: { id: 'stripel_aaa' } })
    for (const row of tables.seller_provider_accounts) row.status = 'invalid'
    await expect(svc.resolveForSale(SELLER, { method: 'card' })).rejects.toBeInstanceOf(BadRequestException)
  })

  it('grupo sem nenhuma conta conectada segue o fluxo de antes', async () => {
    tables.seller_provider_accounts = [providerRow('aaa', 'stripe')]
    expect(await build().resolveForSale(SELLER, { method: 'paypal' })).toEqual({ kind: 'legacy' })
  })

  it('breaker aberto (erros técnicos) tira a conta da escolha', async () => {
    const svc = build({ breakerOpen: id => id === 'stripel_aaa' })
    expect((await svc.resolveForConfig(SELLER, 'sess-3'))?.card?.id).toBe('whopa_bbbb')
  })

  it('disputa acima do limite (com amostra) tira a conta e grava a pausa', async () => {
    tables.transactions = [
      ...Array.from({ length: 20 }, (_, i) => ({ seller_id: SELLER, provider_account_id: 'stripel_aaa', status: 'approved', amount_usd_gross_cents: 1000, id: `t${i}` })),
      { seller_id: SELLER, provider_account_id: 'stripel_aaa', status: 'chargeback', amount_usd_gross_cents: 1000 },
    ]
    const svc = build()
    expect((await svc.resolveForConfig(SELLER, 'sess-4'))?.card?.id).toBe('whopa_bbbb')
    await new Promise(resolve => setImmediate(resolve))
    expect(tables.seller_routing_accounts.find(r => r.provider_account_id === 'stripel_aaa')).toMatchObject({ pause_reason: 'disputes' })
    const view: any = await svc.view(SELLER)
    const stripe = view.accounts.find((a: any) => a.id === 'stripel_aaa')
    expect(stripe).toMatchObject({ paused: true, pauseReason: 'disputes' })
    expect(stripe.stats.disputeRate).toBeCloseTo(1 / 21)
    expect(stripe.stats.approvalRate).toBe(1)
  })

  it('Whop principal entra no grupo do cartão', async () => {
    tables.seller_provider_accounts = []
    const svc = build({ principal: { whop_account_id: 'biz_main', api_key: 'k', status: 'active', company_title: 'Loja', seller_id: SELLER } })
    const pick = await svc.resolveForConfig(SELLER, 'sess-5')
    expect(pick?.card).toMatchObject({ id: 'whopl_biz_main', provider: 'whop', primary: true })
    expect(pick?.paypal).toBeNull()
  })
})

describe('ligar e desligar', () => {
  it('ligar pela primeira vez exige o aceite da taxa', async () => {
    const svc = build()
    const err = await svc.update(SELLER, { enabled: true }, 'seller:u').catch(e => e)
    expect(err).toBeInstanceOf(BadRequestException)
    expect(err.getResponse()).toMatchObject({ error: 'ROUTING_FEE_ACCEPTANCE_REQUIRED' })
    expect(tables.seller_routing_settings).toBeUndefined()

    const view: any = await svc.update(SELLER, { enabled: true, acceptFee: true, cardStrategy: 'score' }, 'seller:u')
    expect(view).toMatchObject({ enabled: true, feePct: 0.8, routingFeePct: null, cardStrategy: 'score', enabledAt: '2026-09-28T12:00:00.000Z', feeAcceptedAt: '2026-09-28T12:00:00.000Z' })
  })

  it('estratégia inválida é recusada', async () => {
    await expect(build().update(SELLER, { cardStrategy: 'aleatorio' }, null)).rejects.toBeInstanceOf(BadRequestException)
  })

  it('desligar deixa a de maior prioridade de cada provedor; religar devolve as guardadas', async () => {
    enableRouting()
    tables.seller_provider_accounts = [
      providerRow('s1', 'stripe'),
      providerRow('s22', 'stripe'),
      providerRow('w333', 'whop'),
      providerRow('p4444', 'paypal'),
      providerRow('p55555', 'paypal'),
    ]
    routingConfig('stripel_s22', { priority: 1 })
    routingConfig('paypall_p55555', { priority: 1, provider: 'paypal' })
    const svc = build()
    await svc.update(SELLER, { enabled: false }, 'seller:u')
    const status = Object.fromEntries(tables.seller_provider_accounts.map(r => [r.id, r.status]))
    expect(status).toEqual({ s1: 'standby', s22: 'active', w333: 'standby', p4444: 'standby', p55555: 'active' })

    await svc.update(SELLER, { enabled: true }, 'seller:u')
    expect(tables.seller_provider_accounts.every(r => r.status === 'active')).toBe(true)
  })
})

describe('breaker ligado de verdade no router', () => {
  function realRouter(result: any) {
    const whopAccounts: any = { getById: async (id: string) => ({ id, provider: 'whop', status: 'active', config: { seller_id: SELLER } }) }
    const r = new AccountRouterService({} as any, whopAccounts, {} as any, {} as any, {} as any)
    ;(r as any).getProviderInstance = () => ({ charge: async () => result })
    return r
  }

  it('três recusas de cartão na Whop própria NÃO abrem o breaker', async () => {
    const r = realRouter({ success: false, failureCode: 'insufficient_funds', data: { decline_code: 'insufficient_funds' } })
    const opened = jest.fn()
    r.onOwnAccountBreakerOpen = opened
    for (let i = 0; i < 3; i++) await r.executeWithProvider({ providerAccountId: 'whopa_x', dto: {}, transactionId: `t${i}` })
    expect(r.accountBreakerOpen('whopa_x')).toBe(false)
    expect(opened).not.toHaveBeenCalled()
  })

  it('três erros técnicos seguidos abrem e avisam o roteamento', async () => {
    const r = realRouter({ success: false, failureMessage: 'Whop HTTP 503', data: {} })
    const opened = jest.fn()
    r.onOwnAccountBreakerOpen = opened
    for (let i = 0; i < 3; i++) await r.executeWithProvider({ providerAccountId: 'whopa_x', dto: {}, transactionId: `t${i}` })
    expect(r.accountBreakerOpen('whopa_x')).toBe(true)
    expect(opened).toHaveBeenCalledWith('whopa_x')
  })

  it('a pausa por erros é gravada (sem passar por cima da pausa manual)', async () => {
    enableRouting()
    const svc = build()
    await svc.recordBreakerPause('stripel_aaa')
    expect(tables.seller_routing_accounts[0]).toMatchObject({ provider_account_id: 'stripel_aaa', pause_reason: 'errors', provider: 'stripe' })

    tables.seller_routing_accounts[0].pause_reason = 'manual'
    await svc.recordBreakerPause('stripel_aaa')
    expect(tables.seller_routing_accounts[0].pause_reason).toBe('manual')
  })
})

describe('CRM', () => {
  it('taxa e limite de disputa (null volta ao padrão), e só desliga', async () => {
    enableRouting()
    const svc = build()
    let view: any = await svc.crmUpdate(SELLER, { routingFeePct: 1.2, disputePausePct: '0,5' }, 'gerente')
    expect(view).toMatchObject({ feePct: 1.2, routingFeePct: 1.2, disputePausePct: 0.5, disputePausePctEffective: 0.5, enabled: true })
    expect(await svc.feeForSale(SELLER)).toBe(1.2)

    view = await svc.crmUpdate(SELLER, { routingFeePct: null, disputePausePct: null }, 'gerente')
    expect(view).toMatchObject({ feePct: 0.8, routingFeePct: null, disputePausePct: null, disputePausePctEffective: 0.75 })

    await expect(svc.crmUpdate(SELLER, { enabled: true }, 'gerente')).rejects.toBeInstanceOf(BadRequestException)
    await expect(svc.crmUpdate(SELLER, { routingFeePct: 50 }, 'gerente')).rejects.toBeInstanceOf(BadRequestException)
    view = await svc.crmUpdate(SELLER, { enabled: false }, 'gerente')
    expect(view.enabled).toBe(false)
  })

  it('padrão da taxa vem do env', async () => {
    process.env.ROUTING_FEE_PCT_DEFAULT = '1.5'
    expect((await build().settings(SELLER)).feePct).toBe(1.5)
  })
})

describe('histórico e aviso de pausa', () => {
  beforeEach(() => { for (const key of Object.keys(tables)) delete tables[key] })

  it('o que o seller muda fica no histórico, com quem fez — e só os campos que ele pode ver', async () => {
    tables.seller_provider_accounts = [providerRow('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'stripe')]
    const svc = build()
    await svc.update(SELLER, { enabled: true, acceptFee: true, cardStrategy: 'score' }, 'seller:u-1')
    const stripeId = 'stripel_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await svc.updateAccount(SELLER, stripeId, { weight: 70, label: 'Principal' }, 'seller:u-1')
    // Linha de outra área do CRM e de outro seller: não aparecem.
    tables.crm_action_log.push({ seller_id: SELLER, action: 'seller.approved', payload: {}, created_at: '2026-09-01T00:00:00Z' })
    tables.crm_action_log.push({ seller_id: 'outro', action: 'routing.settings_changed', payload: {}, created_at: '2026-09-01T00:00:00Z' })

    const { events } = await svc.history(SELLER)
    expect(events.map(event => event.action).sort()).toEqual(['routing.account_changed', 'routing.settings_changed'])
    const changed = events.find(event => event.action === 'routing.account_changed')!
    expect(changed).toMatchObject({ actor: 'seller', accountId: stripeId, accountName: 'Principal', details: { weight: 70, label: 'Principal' } })
    // O ator vai no payload: manager_id é só do gestor do CRM.
    expect(tables.crm_action_log[0]).toMatchObject({ manager_id: null, payload: expect.objectContaining({ actor: 'seller:u-1' }) })
    expect(JSON.stringify(events)).not.toContain('u-1')
  })

  it('conta pausada por disputas: entra no histórico e o seller é avisado UMA vez, sabendo quantas contas sobraram', async () => {
    tables.seller_provider_accounts = [
      providerRow('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'stripe'),
      providerRow('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'stripe'),
    ]
    enableRouting()
    const risky = 'stripel_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    tables.transactions = [
      ...Array.from({ length: 30 }, () => ({ seller_id: SELLER, provider_account_id: risky, status: 'approved', amount_usd_gross_cents: 5000 })),
      { seller_id: SELLER, provider_account_id: risky, status: 'chargeback', amount_usd_gross_cents: 5000, stripe_dispute: { id: 'dp_1' } },
    ]
    const svc = build()
    const notices: any[] = []
    svc.notifyPause = async (sellerId, info) => { notices.push({ sellerId, ...info }) }

    await svc.resolveForConfig(SELLER, 'sess-1')
    await svc.resolveForConfig(SELLER, 'sess-2')
    await new Promise(resolve => setImmediate(resolve))

    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ sellerId: SELLER, provider: 'stripe', disputes: 1, remaining: 1 })
    const logged = tables.crm_action_log.filter(row => row.action === 'routing.account_auto_paused')
    expect(logged).toHaveLength(1)
    expect(logged[0].payload).toMatchObject({ account_id: risky, reason: 'disputes', actor: 'system' })
    expect((await svc.history(SELLER)).events[0]).toMatchObject({ action: 'routing.account_auto_paused', actor: 'system', accountId: risky })
  })
})

describe('tetos do dia e aquecimento', () => {
  beforeEach(() => {
    enableRouting()
    tables.seller_provider_accounts = [providerRow('aaa', 'stripe'), providerRow('bbbb', 'whop')]
    // Stripe nova aquecendo desde hoje (3 vendas no 1º dia), em primeiro na cascata.
    routingConfig('stripel_aaa', {
      priority: 1,
      warmup_started_at: '2026-09-28T10:00:00Z',
      warmup_days: 7,
      warmup_start_orders: 3,
      warmup_growth_pct: 50,
      warmup_max_ticket_usd_cents: 10000,
    })
    routingConfig('whopa_bbbb', { priority: 2, provider: 'whop' })
  })

  const approved = (n: number, id = 'stripel_aaa') =>
    Array.from({ length: n }, (_, i) => ({ seller_id: SELLER, provider_account_id: id, status: 'approved', amount_usd_gross_cents: 2000, id: `${id}-${i}` }))

  it('conta as vendas aprovadas do dia nas transações e, no limite do aquecimento, passa para a próxima', async () => {
    tables.transactions = approved(2)
    const svc = build()
    expect((await svc.resolveForConfig(SELLER, 'sess-1'))?.card?.id).toBe('stripel_aaa')

    tables.transactions = approved(3)
    const router: any = (svc as any).router
    svc.onModuleInit()
    router.onOwnAccountPaid('stripel_aaa') // venda aprovada: esquece o dia em cache
    expect((await svc.resolveForConfig(SELLER, 'sess-2'))?.card?.id).toBe('whopa_bbbb')

    const view: any = await svc.view(SELLER)
    const stripe = view.accounts.find((a: any) => a.id === 'stripel_aaa')
    expect(stripe).toMatchObject({
      capReached: true,
      todayLimitOrders: 3,
      todayLimitUsdCents: null,
      warmup: { active: true, day: 1, days: 7, startOrders: 3, growthPct: 50, maxTicketUsdCents: 10000 },
      stats: { todayOrders: 3, todayUsdCents: 6000 },
    })
  })

  it('ticket acima do máximo do aquecimento: a sessão vai para outra conta (409)', async () => {
    const svc = build()
    await svc.resolveForConfig(SELLER, 'sess-1')
    const err = await svc.resolveForSale(SELLER, { method: 'card', routingKey: 'sess-1', ctx: { amountUsdCents: 15000 } }).catch(e => e)
    expect(err).toBeInstanceOf(ConflictException)
    expect(tables.routing_assignments[0]).toMatchObject({ card_account_id: 'whopa_bbbb' })
  })

  it('nenhuma outra conta aceita a venda: erro claro em vez de 409 em loop', async () => {
    tables.seller_routing_accounts.find(r => r.provider_account_id === 'whopa_bbbb').max_ticket_usd_cents = 5000
    const svc = build()
    await svc.resolveForConfig(SELLER, 'sess-1')
    const err = await svc.resolveForSale(SELLER, { method: 'card', routingKey: 'sess-1', ctx: { amountUsdCents: 15000 } }).catch(e => e)
    expect(err).toBeInstanceOf(BadRequestException)
    expect(err.getResponse()).toMatchObject({ error: 'ROUTING_NO_ACCOUNT' })
  })

  it('ligar pelo painel grava a curva e registra no histórico', async () => {
    const svc = build()
    await svc.updateAccount(SELLER, 'whopa_bbbb', { warmup: { days: 10, startUsdCents: 20000, growthPct: 25 } }, 'seller:u')
    expect(tables.seller_routing_accounts.find(r => r.provider_account_id === 'whopa_bbbb')).toMatchObject({
      warmup_started_at: '2026-09-28T12:00:00.000Z',
      warmup_days: 10,
      warmup_start_usd_cents: 20000,
      warmup_growth_pct: 25,
    })
    const history: any = await svc.history(SELLER)
    expect(history.events[0]).toMatchObject({ action: 'routing.account_changed', details: { warmup_days: 10, warmup_start_usd_cents: 20000 } })
  })
})

describe('contas por link (lojas Shopify)', () => {
  const shop = (id: string, extra: Record<string, any> = {}) => ({
    id, seller_id: SELLER, provider: 'shopify', external_ref: `ck-${id}`, display_name: `Loja ${id}`,
    shop_domain: `${id}.myshopify.com`, currencies: ['USD'], status: 'active', created_at: '2026-09-20T00:00:00Z', ...extra,
  })

  beforeEach(() => {
    enableRouting({ card_strategy: 'orders_split' })
    tables.seller_provider_accounts = [providerRow('aaa', 'stripe')]
    tables.seller_link_accounts = [shop('s1'), shop('s2', { status: 'disabled' })]
    routingConfig('stripel_aaa', { priority: 2 })
    routingConfig('shopifyp_s1', { priority: 1, provider: 'shopify' })
  })

  it('checkout antigo (sem link) nunca recebe loja Shopify', async () => {
    const pick = await build().resolveForConfig(SELLER, 'sess-1')
    expect(pick?.card?.id).toBe('stripel_aaa')
    expect(pick?.cardAccounts).toBe(1)
  })

  it("'only' escolhe só entre as lojas ativas e devolve a referência do backend", async () => {
    const svc = build()
    const pick = await svc.resolveForConfig(SELLER, 'sess-1', { link: 'only' })
    expect(pick?.card).toMatchObject({ id: 'shopifyp_s1', provider: 'shopify', linkRef: 'ck-s1' })
    expect(svc.linkPickOf(pick)).toEqual({ accountId: 'shopifyp_s1', provider: 'shopify', linkRef: 'ck-s1' })
  })

  it("'allow' mistura loja Shopify e Stripe pela estratégia (vendas do dia contam para a loja)", async () => {
    tables.routing_link_sales = [{ provider_account_id: 'shopifyp_s1', seller_id: SELLER, sale_ref: 'o1', status: 'approved', amount_usd_gross_cents: 5000, disputed: false }]
    const pick = await build().resolveForConfig(SELLER, 'sess-1', { link: 'allow' })
    // A loja já tem 1 venda hoje e a Stripe 0: a divisão por pedidos manda para a Stripe.
    expect(pick?.card?.id).toBe('stripel_aaa')
    expect(pick?.cardAccounts).toBe(2)
  })

  it('aquecimento da loja: teto do dia cheio tira a loja do sorteio', async () => {
    tables.seller_routing_accounts.find(r => r.provider_account_id === 'shopifyp_s1').warmup_started_at = '2026-09-28T03:00:00Z'
    Object.assign(tables.seller_routing_accounts.find(r => r.provider_account_id === 'shopifyp_s1'), { warmup_days: 7, warmup_start_orders: 1 })
    tables.routing_link_sales = [{ provider_account_id: 'shopifyp_s1', seller_id: SELLER, sale_ref: 'o1', status: 'approved', amount_usd_gross_cents: 5000, disputed: false }]
    const pick = await build().resolveForConfig(SELLER, 'sess-1', { link: 'only' })
    expect(pick?.card).toBeNull()
    const view = await build().view(SELLER)
    expect(view.accounts.find((a: any) => a.id === 'shopifyp_s1')).toMatchObject({ link: true, stage: 'warming', capReached: true, shopDomain: 's1.myshopify.com' })
  })

  it('venda pelo formulário nunca cai numa loja Shopify, mesmo com a sessão atribuída a ela', async () => {
    const svc = build()
    await svc.resolveForConfig(SELLER, 'sess-1', { link: 'only' })
    await expect(svc.resolveForSale(SELLER, { method: 'card', routingKey: 'sess-1' })).rejects.toBeInstanceOf(ConflictException)
    const sale = await svc.resolveForSale(SELLER, { method: 'card', routingKey: 'sess-1' })
    expect(sale).toMatchObject({ kind: 'account', provider: 'stripe' })
  })

  it('registra a venda informada pelo backend e ela entra na estatística', async () => {
    const svc = build()
    await svc.recordLinkSale(SELLER, { provider: 'shopify', externalRef: 'ck-s1', saleRef: 'ord-9', status: 'chargeback', amountUsdGrossCents: 4700, disputed: true })
    expect(tables.routing_link_sales).toEqual([expect.objectContaining({ provider_account_id: 'shopifyp_s1', sale_ref: 'ord-9', status: 'chargeback', disputed: true })])
    const view = await svc.view(SELLER)
    expect(view.accounts.find((a: any) => a.id === 'shopifyp_s1')?.stats).toMatchObject({ approved7d: 1, disputes7d: 1 })
    await expect(svc.recordLinkSale(SELLER, { provider: 'shopify', externalRef: 'ck-s2-x', saleRef: 'o', status: 'approved', amountUsdGrossCents: 1 })).rejects.toThrow('não encontrada')
  })
})
