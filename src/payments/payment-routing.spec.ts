import { SellerRoutingService } from '../orchestrator/routing/seller-routing.service'
process.env.KOOPFY_PLATFORM_WALLET_REF = process.env.KOOPFY_PLATFORM_WALLET_REF ?? 'wallet-test'

// O pagamento com o roteamento de contas: /payments/config devolve a conta da
// SESSÃO (e nada muda com o roteamento desligado), e o createPayment cobra na
// conta atribuída com a taxa de roteamento somada à comissão — ou responde 409
// antes de criar qualquer transação.

const inserts: Array<{ table: string; row: any }> = []
const sellerRow: any = {
  id: 's-1', status: 'active', risk_level: 'WHITE', enabled_methods: ['credit_card', 'apple_pay'],
  config: {}, provider_default: 'whop', provider_mid: null, country: 'BR',
}

jest.mock('../lib/supabase.client', () => ({
  supabase: {
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: table === 'seller_profiles' ? sellerRow : null, error: null }),
        single: async () => ({ data: table === 'seller_profiles' ? sellerRow : null, error: null }),
        insert: (row: any) => {
          inserts.push({ table, row })
          const created = { id: 'tx-1', ...row }
          const chain: any = {
            select: () => chain,
            single: async () => ({ data: created, error: null }),
            then: (resolve: any) => resolve({ error: null }),
          }
          return chain
        },
        update: () => ({ eq: () => ({ then: (resolve: any) => resolve({ error: null }) }) }),
      }
      return builder
    },
  },
}))
jest.mock('../orchestrator/whop/whop-linked.service', () => ({
  WhopLinkedAccountsService: class { },
  sellerMayOperate: async () => true,
}))
jest.mock('../orchestrator/seller-provider/seller-provider-accounts.service', () => ({
  SellerProviderAccountsService: class { },
  ownAccountCommissionPct: async () => 3,
  // Roteamento desligado + Whop própria: é o que o pay decidia antes.
  resolveOwnSale: async () => ({ provider: 'whop', commissionPct: 3 }),
}))

import { ConflictException } from '@nestjs/common'
import { PaymentService } from './payments.service'

const stripeAccount = { id: 'stripel_aaa', provider: 'stripe', status: 'active', config: { publishable_key: 'pk_live_aaa', linked: true } }
const whopExtra = { id: 'whopa_bbb', provider: 'whop', status: 'active', config: { company_id: 'biz_extra', linked: true } }
const whopPrincipal = { id: 'whopl_biz_main', provider: 'whop', status: 'active', config: { company_id: 'biz_main', linked: true } }

function service(routing: any) {
  const svc = Object.create(PaymentService.prototype) as any
  svc.cardCrypto = { getPublicKeyInfo: () => null }
  svc.currencyService = { convertToUSD: async (amount: number) => ({ grossUSD: amount, fxMarketRate: 1 }) }
  svc.accountRouter = {
    // getPaymentConfig lê os métodos da conta Stripe do seller; null = usa os de reserva.
    ownStripeMethods: jest.fn(async () => null),
    getOwnAccount: async (_sellerId: string, provider: string) => (provider === 'whop' ? whopPrincipal : null),
    getAccountByProvider: async () => whopPrincipal,
    resolveOwnRoute: jest.fn(async () => ({ account: whopPrincipal, provider: 'whop', degraded: false, attempted: ['whop'] })),
    resolveWithFailover: jest.fn(),
    executeWithProvider: jest.fn(async ({ providerAccountId }: any) => ({
      success: true, status: 'requires_action', provider: 'whop', accountId: providerAccountId, providerTransactionId: 'ch_1',
    })),
  }
  // linkPickOf é puro (só lê o pick): o dublê usa o de verdade.
  svc.sellerRouting = routing ? { linkPickOf: SellerRoutingService.prototype.linkPickOf, ...routing } : routing
  return svc
}

beforeEach(() => { inserts.length = 0 })

describe('/payments/config', () => {
  it('roteamento desligado: o mesmo config de antes + routing.enabled=false', async () => {
    const resolveForConfig = jest.fn(async () => null)
    const config = await service({ resolveForConfig }).getPaymentConfig('s-1', { routingKey: 'sess-1' })
    expect(resolveForConfig).toHaveBeenCalledWith(
      's-1', 'sess-1',
      { country: null, currency: null, link: 'deny', linkProviders: ['shopify'] },
      // O cadastro já lido vai junto: a escolha por slot não relê o seller.
      { sellerMethods: ['credit_card', 'apple_pay'] },
    )
    expect(config).toEqual({
      active: true,
      provider: 'whop',
      methods: ['credit_card', 'apple_pay'],
      providerConfig: expect.objectContaining({ provider: 'whop', cardFlow: 'whop', accountId: 'biz_main' }),
      paypal: null,
      routing: { enabled: false },
    })
  })

  it('ligado: credencial pública da conta da sessão (Stripe) + PayPal da sessão', async () => {
    const paypal = { id: 'paypall_c', provider: 'paypal', apiKey: 'client-c', config: { mode: 'test' } }
    const config = await service({
      resolveForConfig: async () => ({
        card: { id: 'stripel_aaa', provider: 'stripe', account: stripeAccount },
        paypal: { id: 'paypall_c', provider: 'paypal', account: paypal },
        cardAccounts: 2,
        paypalAccounts: 1,
        routingKey: 'sess-1',
      }),
    }).getPaymentConfig('s-1', { routingKey: 'sess-1' })
    expect(config).toMatchObject({
      provider: 'stripe',
      methods: ['credit_card', 'apple_pay'],
      providerConfig: { provider: 'stripe', cardFlow: 'elements', publishableKey: 'pk_live_aaa', providerAccountId: 'stripel_aaa' },
      paypal: { clientId: 'client-c', mode: 'test', charging: true },
      routing: { enabled: true, key: 'sess-1', cardAccountId: 'stripel_aaa', cardProvider: 'stripe', paypalAccountId: 'paypall_c' },
    })
  })

  it('ligado com Whop extra: o Elements monta com o biz DELA', async () => {
    const config = await service({
      resolveForConfig: async () => ({
        card: { id: 'whopa_bbb', provider: 'whop', account: whopExtra }, paypal: null, cardAccounts: 1, paypalAccounts: 0, routingKey: 'sess-2',
      }),
    }).getPaymentConfig('s-1', { routingKey: 'sess-2' })
    expect(config.providerConfig).toMatchObject({ provider: 'whop', accountId: 'biz_extra' })
  })

  it('contas de cartão conectadas mas nenhuma elegível: sem cartão (nunca o pool da Koopfy)', async () => {
    const config = await service({
      resolveForConfig: async () => ({ card: null, paypal: null, cardAccounts: 2, paypalAccounts: 0, routingKey: null }),
    }).getPaymentConfig('s-1')
    expect(config).toMatchObject({ provider: null, methods: [], providerConfig: null, routing: { enabled: true, cardAccountId: null } })
  })
})

describe('/payments/config com métodos por conta', () => {
  it('a conta da sessão só mostra os métodos que o seller deixou ligados nela', async () => {
    const config = await service({
      resolveForConfig: async () => ({
        card: { id: 'stripel_aaa', provider: 'stripe', account: stripeAccount, config: { methods: ['card'] } },
        paypal: null, cardAccounts: 1, paypalAccounts: 0, routingKey: 'sess-1',
      }),
    }).getPaymentConfig('s-1', { routingKey: 'sess-1' })
    expect(config.methods).toEqual(['credit_card'])
  })
})

describe('/payments/config com loja Shopify (conta por link)', () => {
  it('sessão atribuída à loja: devolve o link, sem formulário nem PayPal', async () => {
    const resolveForConfig = jest.fn(async () => ({
      card: { id: 'shopifyp_s1', provider: 'shopify', account: null, linkRef: 'ck-1' },
      paypal: null, cardAccounts: 2, paypalAccounts: 0, routingKey: 'sess-9',
    }))
    const config = await service({ resolveForConfig }).getPaymentConfig('s-1', { routingKey: 'sess-9', link: 'allow' })
    expect(resolveForConfig).toHaveBeenCalledWith('s-1', 'sess-9', expect.objectContaining({ link: 'allow' }), expect.anything())
    expect(config).toMatchObject({
      provider: 'shopify_payments', methods: [], paypal: null,
      providerConfig: { provider: 'shopify_payments', cardFlow: 'link', providerAccountId: 'shopifyp_s1', linkRef: 'ck-1' },
      routing: { enabled: true, cardAccountId: 'shopifyp_s1', cardProvider: 'shopify' },
    })
  })
  it('valor de link desconhecido vira deny', async () => {
    const resolveForConfig = jest.fn(async () => null)
    await service({ resolveForConfig }).getPaymentConfig('s-1', { routingKey: 'sess-9', link: 'qualquer' })
    expect(resolveForConfig).toHaveBeenCalledWith('s-1', 'sess-9', expect.objectContaining({ link: 'deny' }), expect.anything())
  })
})

describe('/payments/config com routing.slots', () => {
  const paypal = { id: 'paypall_c', provider: 'paypal', apiKey: 'client-c', config: { mode: 'test' } }
  const whopPix = { id: 'whopa_pix', provider: 'whop', status: 'active', config: { company_id: 'biz_pix', linked: true } }
  const entry = (id: string, provider: string, account: any, methods: string[], extra: Record<string, any> = {}) =>
    ({ id, provider, account, methods, config: { methods: null }, ...extra })

  it('cada slot sai com a conta, os métodos do slot e a credencial do provedor dela; campos antigos pelo cartão', async () => {
    const card = entry('stripel_aaa', 'stripe', stripeAccount, ['credit_card', 'apple_pay', 'google_pay'])
    const slots = new Map<string, any>([
      ['card', card],
      ['paypal', entry('paypall_c', 'paypal', paypal, ['paypal'])],
      ['pix', entry('whopa_pix', 'whop', whopPix, ['credit_card', 'pix'])],
    ])
    const config: any = await service({
      resolveForConfig: async () => ({ card, paypal: slots.get('paypal'), cardAccounts: 2, paypalAccounts: 1, routingKey: 'sess-1', slots }),
    }).getPaymentConfig('s-1', { routingKey: 'sess-1' })
    // Campos antigos: iguais aos de antes (slot do cartão).
    expect(config).toMatchObject({
      provider: 'stripe',
      providerConfig: { provider: 'stripe', publishableKey: 'pk_live_aaa' },
      paypal: { clientId: 'client-c' },
      routing: { cardAccountId: 'stripel_aaa', cardProvider: 'stripe', paypalAccountId: 'paypall_c' },
    })
    expect(config.routing.slots).toEqual([
      { slot: 'card', accountId: 'stripel_aaa', provider: 'stripe', methods: ['credit_card', 'apple_pay', 'google_pay'], providerConfig: expect.objectContaining({ provider: 'stripe', publishableKey: 'pk_live_aaa', providerAccountId: 'stripel_aaa' }) },
      { slot: 'paypal', accountId: 'paypall_c', provider: 'paypal', methods: ['paypal'], providerConfig: { clientId: 'client-c', mode: 'test', charging: true } },
      { slot: 'pix', accountId: 'whopa_pix', provider: 'whop', methods: ['pix'], providerConfig: expect.objectContaining({ provider: 'whop', accountId: 'biz_pix' }) },
    ])
  })

  it('cartão numa Digistore24: link no cartão e os outros slots continuam', async () => {
    const card = entry('digistp_d1', 'digistore24', null, ['digistore_checkout'], { linkRef: 'dg-1' })
    const slots = new Map<string, any>([['card', card], ['paypal', entry('paypall_c', 'paypal', paypal, ['paypal'])]])
    const resolveForConfig = jest.fn(async () => ({ card, paypal: slots.get('paypal'), cardAccounts: 1, paypalAccounts: 1, routingKey: 'sess-2', slots }))
    const config: any = await service({ resolveForConfig }).getPaymentConfig('s-1', { routingKey: 'sess-2', link: 'allow', linkProviders: 'shopify,digistore24,lixo' })
    expect(resolveForConfig).toHaveBeenCalledWith('s-1', 'sess-2', expect.objectContaining({ link: 'allow', linkProviders: ['shopify', 'digistore24'] }), expect.anything())
    expect(config).toMatchObject({
      provider: 'digistore24', methods: [], paypal: null,
      providerConfig: { provider: 'digistore24', cardFlow: 'link', providerAccountId: 'digistp_d1', linkRef: 'dg-1' },
      routing: { cardAccountId: 'digistp_d1', cardProvider: 'digistore24', paypalAccountId: 'paypall_c' },
    })
    expect(config.routing.slots.map((s: any) => [s.slot, s.provider])).toEqual([['card', 'digistore24'], ['paypal', 'paypal']])
    expect(config.routing.slots[0].providerConfig).toEqual({ provider: 'digistore24', cardFlow: 'link', providerAccountId: 'digistp_d1', linkRef: 'dg-1' })
  })

  it('pick sem slots (serviço antigo nos testes): slots saem do cartão e do PayPal', async () => {
    const config: any = await service({
      resolveForConfig: async () => ({
        card: entry('whopa_bbb', 'whop', whopExtra, ['credit_card']), paypal: null, cardAccounts: 1, paypalAccounts: 0, routingKey: 'sess-3',
      }),
    }).getPaymentConfig('s-1', { routingKey: 'sess-3' })
    expect(config.routing.slots).toEqual([expect.objectContaining({ slot: 'card', accountId: 'whopa_bbb', provider: 'whop', methods: ['credit_card'] })])
  })
})

describe('createPayment', () => {
  const dto = () => ({
    sellerId: 's-1',
    amount: 10000,
    currency: 'USD',
    method: 'card',
    customer: { name: 'Ana', email: 'ana@example.com' },
    metadata: { order_number: '42', routing_key: 'sess-1' },
    postback_url: 'https://checkout.test/postback',
  })

  it('roteamento desligado: mesma conta e mesma comissão de antes (routing_fee_pct 0)', async () => {
    const svc = service({ resolveForSale: jest.fn(async () => null) })
    const res = await svc.createPayment(dto())
    expect(svc.accountRouter.resolveOwnRoute).toHaveBeenCalledWith('s-1', 'whop')
    expect(res.own_account).toEqual({ provider: 'whop', commission_pct: 3, routing_fee_pct: 0, commission_usd_cents: 300 })
    expect(res.routing).toBeUndefined()
  })

  it('ligado: cobra na conta da sessão com comissão + taxa de roteamento', async () => {
    const resolveForSale = jest.fn(async () => ({
      kind: 'account', entry: { id: 'whopa_bbb', account: whopExtra }, provider: 'whop', feePct: 0.8, reason: 'session',
    }))
    const svc = service({ resolveForSale })
    const res = await svc.createPayment(dto())

    expect(resolveForSale).toHaveBeenCalledWith('s-1', expect.objectContaining({
      method: 'card', routingKey: 'sess-1', orderRef: '42', ctx: { country: null, currency: 'USD', amountUsdCents: 10000 },
    }))
    expect(svc.accountRouter.resolveOwnRoute).not.toHaveBeenCalled()
    expect(svc.accountRouter.executeWithProvider).toHaveBeenCalledWith(expect.objectContaining({ providerAccountId: 'whopa_bbb' }))
    // 100 USD × (3% + 0,8%) = 3,80 USD.
    expect(res.own_account).toEqual({ provider: 'whop', commission_pct: 3, routing_fee_pct: 0.8, commission_usd_cents: 380 })
    expect(res.routing).toEqual({ enabled: true, account_id: 'whopa_bbb', provider: 'whop' })
    const tx = inserts.find(i => i.table === 'transactions')!.row
    expect(tx.metadata.own_account).toMatchObject({ routing_fee_pct: 0.8, commission_usd_cents: 380 })
  })

  it('409 ROUTING_REASSIGNED sai ANTES de criar a transação', async () => {
    const svc = service({
      resolveForSale: async () => { throw new ConflictException({ error: 'ROUTING_REASSIGNED', message: 'x' }) },
    })
    const err = await svc.createPayment(dto()).catch((e: any) => e)
    expect(err).toBeInstanceOf(ConflictException)
    expect(err.getResponse()).toMatchObject({ error: 'ROUTING_REASSIGNED' })
    expect(inserts.filter(i => i.table === 'transactions')).toHaveLength(0)
    expect(svc.accountRouter.executeWithProvider).not.toHaveBeenCalled()
  })
})
