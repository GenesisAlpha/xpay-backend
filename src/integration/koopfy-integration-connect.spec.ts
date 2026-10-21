// Conectar uma conta própria (Whop, Stripe, PayPal) é escolher o provedor
// externo: depois da conexão dar certo, seller_profiles.config.payment_account
// vira 'external' (ver payment-account-mode.ts). Conexão que falha não mexe na
// escolha, e falha ao gravar a escolha não derruba a conexão.

const tables: Record<string, any[]> = {}
let failProfileUpdate = false

jest.mock('../lib/supabase.client', () => ({
  supabase: {
    from: (table: string) => {
      const filters: Array<[string, any]> = []
      const rows = () => (tables[table] ?? []).filter(row => filters.every(([column, value]) => row[column] === value))
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: any) => { filters.push([column, value]); return builder },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: any) => resolve({ data: rows(), error: null }),
        insert: async (row: any) => { (tables[table] ??= []).push(row); return { error: null } },
        update: (patch: any) => ({
          eq: async (column: string, value: any) => {
            if (table === 'seller_profiles' && failProfileUpdate) return { error: { message: 'banco fora' } }
            for (const r of tables[table] ?? []) if (r[column] === value) Object.assign(r, patch)
            return { error: null }
          },
        }),
      }
      return builder
    },
  },
}))
jest.mock('./seller-accounts', () => ({
  ...jest.requireActual('./seller-accounts'),
  resolveAccountUserId: async () => 'u-1',
}))
jest.mock('../lib/storage.service', () => ({ StorageService: class { } }))
jest.mock('../dashboard/services/services', () => ({ WalletService: class { } }))
jest.mock('../crypto/crypto.service', () => ({ CryptoService: class { } }))
jest.mock('uuid', () => ({ v4: () => 'uuid' }))

import { KoopfyIntegrationService } from './koopfy-integration.service'
import { forgetPaymentAccountMode } from '../orchestrator/seller-provider/payment-account-mode'

const SELLER = 's-1'
const STRIPE = { secretKey: 'sk_live_abcdefghij', publishableKey: 'pk_live_abcdefghij' }

function build(opts: { connectFails?: boolean; routingEnabled?: boolean } = {}) {
  const calls: string[] = []
  const fail = async () => { throw new Error('chave recusada') }
  const sellerProviders: any = {
    connectStripe: opts.connectFails ? fail : async () => { calls.push('stripe') },
    connectPaypal: opts.connectFails ? fail : async () => { calls.push('paypal') },
    connectedCounts: async () => ({ whop: 0, stripe: 1, paypal: 0 }),
    rows: async () => ({ stripe: null, paypal: null }),
  }
  const whopLinked: any = {
    connect: opts.connectFails ? fail : async () => { calls.push('whop') },
    status: async () => null,
    publicView: () => null,
  }
  const sellerRouting: any = {
    settings: async () => ({ enabled: Boolean(opts.routingEnabled), feePct: 0.8, feeAcceptedAt: null }),
    loadPool: async () => [],
    update: async (_id: string, patch: any) => { calls.push(`routing:${patch.enabled}`) },
  }
  const ownDomains: any = { registerPlatformHostsEverywhere: async () => undefined }
  const svc = new KoopfyIntegrationService(
    {} as any, {} as any, {} as any, {} as any,
    whopLinked, sellerProviders, sellerRouting, {} as any, ownDomains, {} as any,
  )
  return { svc, calls }
}

const choice = () => tables.seller_profiles?.find(row => row.id === SELLER)?.config?.payment_account
const flush = () => new Promise(resolve => setImmediate(resolve))

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key]
  failProfileUpdate = false
  forgetPaymentAccountMode()
  tables.seller_profiles = [{ id: SELLER, user_id: 'u-1', config: { payment_account: 'koopfy', keep: true } }]
})

describe('conectar conta própria escolhe o provedor externo', () => {
  it('Stripe conectada: Koopfy Payments vira external, o resto da config fica', async () => {
    const { svc, calls } = build()
    await svc.connectOwnProvider('a@b.com', null, 'stripe', STRIPE)
    expect(calls).toEqual(['stripe'])
    expect(tables.seller_profiles[0].config).toEqual({ payment_account: 'external', keep: true })
    await flush()
    expect(tables.crm_action_log).toEqual([expect.objectContaining({
      action: 'seller_provider.payment_account',
      payload: expect.objectContaining({ actor: 'seller:u-1', mode: 'external', previous: 'koopfy', source: 'stripe' }),
    })])
  })

  it('PayPal e Whop (inclusive extra, com o roteamento ligado) também', async () => {
    const paypal = build()
    await paypal.svc.connectOwnProvider('a@b.com', null, 'paypal', { clientId: 'A'.repeat(24), clientSecret: 'B'.repeat(24), mode: 'live' })
    expect(choice()).toBe('external')

    tables.seller_profiles[0].config = {}
    forgetPaymentAccountMode()
    const whop = build({ routingEnabled: true })
    await whop.svc.connectExternalProvider('a@b.com', null, 'whop_key', 'Extra')
    expect(whop.calls).toEqual(['whop'])
    expect(choice()).toBe('external')
  })

  it('conexão que falha não mexe na escolha (e desliga o roteamento ligado só para ela)', async () => {
    const { svc, calls } = build({ connectFails: true })
    await expect(svc.connectOwnProvider('a@b.com', null, 'stripe', { ...STRIPE, multiAccount: true, acceptFee: true })).rejects.toThrow('chave recusada')
    expect(calls).toEqual(['routing:true', 'routing:false'])
    expect(choice()).toBe('koopfy')
    await expect(build({ connectFails: true }).svc.connectExternalProvider('a@b.com', null, 'whop_key')).rejects.toThrow('chave recusada')
    expect(choice()).toBe('koopfy')
  })

  it('falha ao gravar a escolha não derruba a conexão', async () => {
    failProfileUpdate = true
    const { svc, calls } = build()
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(svc.connectOwnProvider('a@b.com', null, 'stripe', STRIPE)).resolves.toBeDefined()
    expect(calls).toEqual(['stripe'])
    expect(choice()).toBe('koopfy')
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })
})

describe('conta de pagamento conta as lojas por link', () => {
  it('Shopify/Digistore24 registradas contam como provedor externo disponível', async () => {
    tables.seller_profiles[0] = { id: SELLER, user_id: 'u-1', status: 'active', provider_default: 'clip', config: {} }
    tables.seller_link_accounts = [
      { id: 'l1', seller_id: SELLER, provider: 'shopify', status: 'active' },
      { id: 'l2', seller_id: SELLER, provider: 'digistore24', status: 'disabled' },
    ]
    const { svc } = build()
    ;(svc as any).sellerProviders.connectedCounts = async () => ({ whop: 0, stripe: 0, paypal: 0 })
    const view: any = await svc.paymentAccountView({ seller: { id: SELLER, status: 'active' }, userId: 'u-1' } as any)
    expect(view.external).toEqual({ available: true, accounts: { whop: 0, stripe: 0, paypal: 0, shopify: 1, digistore24: 0 } })
    expect(view).toMatchObject({ mode: 'external', chosen: false })
  })
})
