// O roteador prefere a conta PRÓPRIA do seller (Stripe/PayPal/Whop dele) ao
// pool da Koopfy, e o PayPalProvider cria a order sem rede real.

jest.mock('../../lib/supabase.client', () => ({
  supabase: {
    from: () => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: any) => resolve({ data: [], error: null }),
      }
      return builder
    },
  },
}))
jest.mock('../../crypto/crypto.service', () => ({ CryptoService: class { } }))

import { AccountRouterService } from './account-router.service'
import { PaypalProvider } from '../providers/paypal.provider'

const own = (id: string, provider: string) => ({ id, provider, status: 'active', weight: 1, supported_methods: ['all'] })

function router(opts: { stripeOwn?: any; paypalOwn?: any; whopOwn?: any; stripePool?: any[] } = {}) {
  const whopAccounts: any = {
    listActive: async () => [],
    getById: async () => null,
    getSellerLinkedAccount: async () => opts.whopOwn ?? null,
    resolveSellerRouting: async () => ({ mode: 'master' }),
  }
  const stripeAccounts: any = { listActive: async () => opts.stripePool ?? [], getById: async () => null }
  const clipAccounts: any = { listActive: async () => [], getById: async () => null }
  const sellerProviders: any = {
    getChargeableAccount: async (_sellerId: string, provider: string) =>
      provider === 'stripe' ? opts.stripeOwn ?? null : opts.paypalOwn ?? null,
    getProviderAccountById: async (id: string) => (opts.paypalOwn?.id === id ? opts.paypalOwn : null),
  }
  return new AccountRouterService({} as any, whopAccounts, stripeAccounts, {} as any, clipAccounts, sellerProviders)
}

const pool = { ...own('stripe_br_01', 'stripe'), config: { publishable_key: 'pk_koopfy' } }

describe('roteador prefere a conta própria do seller', () => {
  it('Stripe própria ganha do pool da Koopfy', async () => {
    const stripeOwn = own('stripel_abc', 'stripe')
    const account = await router({ stripeOwn, stripePool: [pool] }).getAccountByProvider({ sellerId: 's-1', provider: 'stripe' })
    expect(account?.id).toBe('stripel_abc')
  })

  it('sem Stripe própria, segue o pool', async () => {
    const account = await router({ stripePool: [pool] }).getAccountByProvider({ sellerId: 's-1', provider: 'stripe' })
    expect(account?.id).toBe('stripe_br_01')
  })

  it('PayPal só existe na conta do seller: sem ela, nenhuma conta', async () => {
    const paypalOwn = own('paypall_abc', 'paypal')
    expect((await router({ paypalOwn }).getAccountByProvider({ sellerId: 's-1', provider: 'paypal' }))?.id).toBe('paypall_abc')
    expect(await router().getAccountByProvider({ sellerId: 's-1', provider: 'paypal' })).toBeNull()
  })

  it('venda de conta própria não cai no pool quando a conta some', async () => {
    const r = router({ stripePool: [pool] })
    expect(await r.resolveOwnRoute('s-1', 'stripe')).toBeNull()
    const withOwn = router({ stripeOwn: own('stripel_abc', 'stripe'), whopOwn: own('whopl_biz_1', 'whop') })
    expect(await withOwn.resolveOwnRoute('s-1', 'stripe')).toMatchObject({ provider: 'stripe', degraded: false, account: { id: 'stripel_abc' } })
    expect(await withOwn.resolveOwnRoute('s-1', 'whop')).toMatchObject({ provider: 'whop', account: { id: 'whopl_biz_1' } })
  })

  it('paypall_ resolve pela conta do seller (webhook e captura)', async () => {
    const paypalOwn = own('paypall_abc', 'paypal')
    expect((await router({ paypalOwn }).resolveAccountById('paypall_abc'))?.id).toBe('paypall_abc')
    expect(router().getProviderInstance('paypal')).toBeInstanceOf(PaypalProvider)
  })
})

describe('PaypalProvider.charge', () => {
  const fetchMock = jest.spyOn(global, 'fetch' as any)
  afterAll(() => fetchMock.mockRestore())

  it('cria a order com PayPal-Request-Id fixo e devolve o fluxo client', async () => {
    const calls: Array<{ url: string; init: any }> = []
    fetchMock.mockImplementation((async (url: string, init: any) => {
      calls.push({ url, init })
      if (url.endsWith('/v1/oauth2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 32400 }) }
      }
      return { ok: true, status: 201, json: async () => ({ id: 'ORDER-9', status: 'CREATED' }) }
    }) as any)

    const result = await new PaypalProvider().charge({
      transactionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      amount: 2500,
      currency: 'USD',
      product_name: 'Produto que não pode sair',
      metadata: { order_number: '88', store_name: 'Minha Loja' },
      providerConfig: { id: 'paypall_charge', apiKey: 'client-id', apiSecret: 'client-secret', config: { mode: 'live' } },
    })

    expect(result).toMatchObject({
      success: true,
      status: 'pending',
      provider: 'paypal',
      providerTransactionId: 'ORDER-9',
      data: { flow: 'client', paypalOrderId: 'ORDER-9', clientId: 'client-id' },
    })
    const create = calls.find(call => call.url.endsWith('/v2/checkout/orders'))!
    expect(create.url).toBe('https://api-m.paypal.com/v2/checkout/orders')
    expect(create.init.headers['PayPal-Request-Id']).toBe('koopfy_pp_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    const body = JSON.parse(create.init.body)
    expect(body.purchase_units[0]).toMatchObject({
      custom_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      invoice_id: '88',
      description: 'Minha Loja · #88',
      amount: { currency_code: 'USD', value: '25.00' },
    })
    expect(create.init.body).not.toContain('Produto que não pode sair')
  })
})
