import { SlashProvider, mapSlashIntentStatus } from './slash.provider'

const config = { id: 'slash_main', apiKey: 'sk_test', api_url: 'https://api.slash.test/', config: {} }

function mockFetch(status: number, json: any) {
  const fn = jest.fn(async (_url: string, _init: any) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json),
  }))
  ;(global as any).fetch = fn
  return fn
}

describe('SlashProvider.charge', () => {
  afterEach(() => { delete (global as any).fetch })

  const ctx = {
    transactionId: 'tx-1',
    amount: 4990,
    currency: 'usd',
    sellerId: 'seller-1',
    metadata: { order_number: 'ORD-1', customer_name: 'não entra' },
    customer: { name: 'Ana' },
    providerConfig: config,
  }

  it('cria o intent e devolve o clientSecret sem aprovar nem contar como pendente', async () => {
    const fetch = mockFetch(200, {
      paymentIntent: { id: 'acq_payment_intent_1', status: 'pending', clientSecret: 'cs_1', amount: 4990, currency: 'usd' },
    })
    const res = await new SlashProvider().charge(ctx)

    expect(res).toMatchObject({
      success: true, status: 'requires_action', provider: 'slash',
      providerTransactionId: 'acq_payment_intent_1', clientSecret: 'cs_1',
    })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://api.slash.test/payments/payment-intent')
    expect(init.headers['X-API-Key']).toBe('sk_test')
    // Valor e moeda na chave: total novo = intent novo; mesmo total = mesmo intent.
    expect(init.headers['X-Idempotency-Key']).toBe('koopfy_pi_tx-1_usd_4990')
    // Corpo determinístico: nada do comprador, que muda entre chamadas.
    expect(JSON.parse(init.body)).toEqual({
      amount: 4990,
      currency: 'usd',
      metadata: {
        koopfy_transaction_id: 'tx-1',
        koopfy_account_id: 'slash_main',
        koopfy_seller_id: 'seller-1',
        koopfy_order_ref: 'ORD-1',
      },
    })
  })

  it('manda x-legal-entity quando configurado (chave de usuário)', async () => {
    const fetch = mockFetch(200, { paymentIntent: { id: 'pi', clientSecret: 'cs' } })
    await new SlashProvider().charge({ ...ctx, providerConfig: { ...config, config: { legal_entity_id: 'le_1' } } })
    expect(fetch.mock.calls[0][1].headers['x-legal-entity']).toBe('le_1')
  })

  it('recusa moeda fora de USD/EUR sem chamar a API nem culpar a conta', async () => {
    const fetch = mockFetch(200, {})
    const res = await new SlashProvider().charge({ ...ctx, currency: 'BRL' })
    expect(res).toMatchObject({ success: false, failureCode: 'CURRENCY_NOT_SUPPORTED', data: { accountLevel: false } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('erro da API vira falha com a mensagem da Slash', async () => {
    mockFetch(401, { message: 'Invalid API key', name: 'unauthorized' })
    const res = await new SlashProvider().charge(ctx)
    expect(res).toMatchObject({ success: false, failureCode: 'unauthorized', data: { accountLevel: true } })
    expect(res.failureMessage).toContain('Invalid API key')
  })

  it('sem clientSecret não há o que montar no checkout', async () => {
    mockFetch(200, { paymentIntent: { id: 'pi' } })
    const res = await new SlashProvider().charge(ctx)
    expect(res).toMatchObject({ success: false, failureCode: 'missing_client_secret' })
  })

  it('sem chave falha antes de chamar a API', async () => {
    const fetch = mockFetch(200, {})
    const res = await new SlashProvider().charge({ ...ctx, providerConfig: { ...config, apiKey: undefined } })
    expect(res.success).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('SlashProvider.listRefunds', () => {
  afterEach(() => { delete (global as any).fetch })

  it('filtra pelo intent e segue a paginação', async () => {
    const pages = [
      { items: [{ id: 'r1', amount: 100, status: 'succeeded' }], metadata: { nextCursor: 'c2' } },
      { items: [{ id: 'r2', amount: 50, status: 'failed' }], metadata: { nextCursor: null } },
    ]
    const fn = jest.fn(async (_url: string) => ({ ok: true, status: 200, text: async () => JSON.stringify(pages.shift()) }))
    ;(global as any).fetch = fn

    const list = await new SlashProvider().listRefunds(config, 'pi_1')
    expect(list?.map(r => r.id)).toEqual(['r1', 'r2'])
    expect(fn.mock.calls[0][0]).toContain('filter%3ApaymentIntentId=pi_1')
    expect(fn.mock.calls[1][0]).toContain('cursor=c2')
  })
})

describe('mapSlashIntentStatus', () => {
  it('só succeeded é pago', () => {
    expect(mapSlashIntentStatus('succeeded')).toBe('paid')
    expect(mapSlashIntentStatus('processing')).toBe('processing')
    expect(mapSlashIntentStatus('pending')).toBe('pending')
    expect(mapSlashIntentStatus('canceled')).toBe('failed')
    expect(mapSlashIntentStatus('whatever')).toBe('unknown')
  })
})

describe('failover da Slash', () => {
  // Import tardio para não misturar com os mocks de fetch acima.
  const { buildFailoverOrder } = require('../router/failover.config')

  it('seller Slash não cai em outro PSP', () => {
    expect(buildFailoverOrder({ preferred: 'slash', method: 'card' })).toEqual(['slash'])
    expect(buildFailoverOrder({ preferred: 'slash', method: 'pix' })).toEqual(['slash'])
  })

  it('os demais seguem com a cadeia', () => {
    expect(buildFailoverOrder({ preferred: 'stripe', method: 'card' }).length).toBeGreaterThan(1)
  })
})
