// Conta de pagamento do seller: com a Koopfy Payments escolhida, as contas
// próprias seguem conectadas mas não cobram; sem escolha, nada muda.

let sellerConfig: Record<string, any> | null = null
const providerRows = [{ provider: 'stripe', status: 'active', secret_enc: 'x', public_key: 'pk_live_a' }]

jest.mock('../../lib/supabase.client', () => ({
  supabase: {
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        update: () => builder,
        maybeSingle: async () => ({ data: table === 'seller_profiles' ? { config: sellerConfig } : null, error: null }),
        then: (resolve: any) => resolve({ data: table === 'seller_provider_accounts' ? providerRows : [], error: null }),
      }
      return builder
    },
  },
}))
jest.mock('../../crypto/crypto.service', () => ({ CryptoService: class { } }))

import { forgetPaymentAccountMode, parsePaymentAccountMode, readPaymentAccountMode } from './payment-account-mode'
import { ownAccountsCharging, resolveOwnSale } from './seller-provider-accounts.service'
import { stripeEnabledMethodsFrom, STRIPE_REDIRECT_METHODS } from './seller-provider-accounts'

beforeEach(() => { sellerConfig = null; forgetPaymentAccountMode() })

describe('conta de pagamento do seller', () => {
  it('só aceita koopfy ou external', () => {
    expect(parsePaymentAccountMode('koopfy')).toBe('koopfy')
    expect(parsePaymentAccountMode('external')).toBe('external')
    expect(parsePaymentAccountMode('stripe')).toBeNull()
    expect(parsePaymentAccountMode(undefined)).toBeNull()
  })

  it('sem escolha, a Stripe própria segue cobrando (como antes)', async () => {
    expect(await readPaymentAccountMode('s-1')).toBeNull()
    expect((await ownAccountsCharging('s-1')).stripe).toBe(true)
    expect((await resolveOwnSale({ sellerId: 's-1', providerDefault: 'clip', method: 'card' }))?.provider).toBe('stripe')
  })

  it('com a Koopfy Payments escolhida, a conta própria não cobra e a venda segue o provedor da Koopfy', async () => {
    sellerConfig = { payment_account: 'koopfy', spei_beneficiary_name: 'Loja' }
    const state = await ownAccountsCharging('s-1')
    expect([state.whop, state.stripe, state.paypal]).toEqual([false, false, false])
    expect(await resolveOwnSale({ sellerId: 's-1', providerDefault: 'clip', method: 'card' })).toBeNull()
  })

  it('provedor externo escolhido: conta própria cobra', async () => {
    sellerConfig = { payment_account: 'external' }
    expect((await ownAccountsCharging('s-1')).stripe).toBe(true)
  })
})

describe('métodos ligados na conta Stripe', () => {
  const config = (extra: Record<string, any> = {}) => ({
    data: [
      { id: 'pmc_child', is_default: true, parent: 'pmc_platform', card: { available: true }, ideal: { available: true } },
      { id: 'pmc_own', is_default: true, parent: null, active: true, card: { available: true }, apple_pay: { available: true }, google_pay: { available: false }, ideal: { available: true }, mb_way: { available: false }, afterpay_clearpay: { available: true }, ...extra },
    ],
  })

  it('usa a configuração padrão da própria conta e só o que está disponível', () => {
    expect(stripeEnabledMethodsFrom(config())).toEqual(['credit_card', 'apple_pay', 'ideal', 'afterpay'])
  })

  it('sem configuração legível devolve null (quem chama mantém a lista anterior)', () => {
    expect(stripeEnabledMethodsFrom({ data: [] })).toBeNull()
    expect(stripeEnabledMethodsFrom(null)).toBeNull()
    expect(stripeEnabledMethodsFrom({ data: [{ is_default: true, card: { available: false } }] })).toBeNull()
  })

  it('cartão e carteiras não pedem redirecionamento; iDEAL e MB Way pedem', () => {
    expect(STRIPE_REDIRECT_METHODS.has('card')).toBe(false)
    expect(STRIPE_REDIRECT_METHODS.has('apple_pay')).toBe(false)
    expect(STRIPE_REDIRECT_METHODS.has('ideal')).toBe(true)
    expect(STRIPE_REDIRECT_METHODS.has('mbway')).toBe(true)
  })
})
