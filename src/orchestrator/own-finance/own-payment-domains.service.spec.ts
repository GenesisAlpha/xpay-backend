// OwnPaymentDomainsService sem banco e sem rede: as contas vêm de um dublê do
// financeiro e o "provedor" é um fetch falso que responde por URL.

const logged: any[] = []

jest.mock('../../lib/supabase.client', () => ({
  supabase: { from: () => ({ insert: async (row: any) => { logged.push(row); return { error: null } } }) },
}))
jest.mock('./own-account-finance.service', () => ({ OwnAccountFinanceService: class { } }))

import { BadRequestException } from '@nestjs/common'
import { OwnPaymentDomainsService } from './own-payment-domains.service'

const SELLER = 's-1'
const ACCOUNTS: any[] = [
  { id: 'whopl_biz_1', provider: 'whop', group: 'card', primary: true, label: 'Whop principal', accountName: 'Acme', status: 'active', paused: false },
  { id: 'stripel_1', provider: 'stripe', group: 'card', primary: false, label: null, accountName: 'Acme US', mode: 'live', status: 'active', paused: false },
  { id: 'stripel_2', provider: 'stripe', group: 'card', primary: false, label: 'Recusada', accountName: null, status: 'attention', paused: false },
  { id: 'paypall_1', provider: 'paypal', group: 'paypal', primary: false, label: null, accountName: 'PP', status: 'active', paused: false },
]

type Call = { method: string; url: string; body: string | undefined; headers: Record<string, string> }

function setup(respond: (call: Call) => { status?: number; json: any }) {
  const calls: Call[] = []
  const finance: any = {
    accounts: jest.fn(async () => ACCOUNTS),
    resolveAccount: jest.fn(async (_seller: string, id: string) => {
      const account = ACCOUNTS.find(item => item.id === id)
      if (!account) throw new BadRequestException('Conta não encontrada ou desconectada.')
      return { account, credentials: { apiKey: `key-${id}`, config: { seller_id: SELLER } } }
    }),
  }
  const service = new OwnPaymentDomainsService(finance)
  service.fetchImpl = async (url, init) => {
    const call = { method: init?.method ?? 'GET', url, body: init?.body, headers: init?.headers ?? {} }
    calls.push(call)
    const { status = 200, json } = respond(call)
    return { ok: status < 400, status, json: async () => json }
  }
  return { service, calls, finance }
}

beforeEach(() => { logged.length = 0; delete process.env.CHECKOUT_PUBLIC_URL; delete process.env.CHECKOUT_EXTRA_HOSTS })

describe('OwnPaymentDomainsService', () => {
  it('Stripe: cria o domínio, pede a validação e devolve a situação de cada carteira', async () => {
    const { service, calls } = setup(call => {
      if (call.method === 'GET') return { json: { data: [] } }
      if (call.url.endsWith('/validate')) return { json: { id: 'pmd_1', domain_name: 'loja.com', enabled: true, apple_pay: { status: 'inactive', status_details: { error_message: 'Arquivo não encontrado.' } }, google_pay: { status: 'active' } } }
      return { json: { id: 'pmd_1', domain_name: 'loja.com', enabled: true, apple_pay: { status: 'inactive' }, google_pay: { status: 'active' } } }
    })
    const result = await service.register(SELLER, 'stripel_1', 'https://Loja.com/', 'seller:u-1')
    expect(result.registered).toEqual({ id: 'pmd_1', hostname: 'loja.com', applePay: 'pending', googlePay: 'active', message: 'Arquivo não encontrado.' })
    const create = calls.find(call => call.method === 'POST' && call.url.endsWith('/v1/payment_method_domains'))!
    expect(create.body).toBe('domain_name=loja.com')
    expect(create.headers.Authorization).toBe('Bearer key-stripel_1')
    expect(calls.some(call => call.url.endsWith('/v1/payment_method_domains/pmd_1/validate'))).toBe(true)
    expect(result.file?.url).toContain('stripe.com/files/apple-pay')
    expect(logged[0]).toMatchObject({ action: 'own_finance.domain_registered', payload: { account_id: 'stripel_1', hostname: 'loja.com', actor: 'seller:u-1' } })
  })

  it('Stripe: domínio já registrado e ativo não é criado nem validado de novo', async () => {
    const active = { id: 'pmd_9', domain_name: 'loja.com', enabled: true, apple_pay: { status: 'active' }, google_pay: { status: 'active' } }
    const { service, calls } = setup(() => ({ json: { data: [active] } }))
    const result = await service.register(SELLER, 'stripel_1', 'loja.com')
    expect(result.registered).toMatchObject({ applePay: 'active', googlePay: 'active' })
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('Whop: registra com a chave dele e pede a verificação', async () => {
    let created = false
    const { service, calls } = setup(call => {
      if (call.method === 'GET') return { json: { data: created ? [{ id: 'pmdm_1', hostname: 'loja.com', status: 'verified' }] : [] } }
      if (call.url.endsWith('/verify')) return { json: { id: 'pmdm_1', hostname: 'loja.com', status: 'verified' } }
      created = true
      return { json: { id: 'pmdm_1', hostname: 'loja.com', status: 'pending' } }
    })
    const result = await service.register(SELLER, 'whopl_biz_1', 'loja.com')
    expect(result.registered).toEqual({ id: 'pmdm_1', hostname: 'loja.com', applePay: 'active', googlePay: 'not_required', message: null })
    const create = calls.find(call => call.method === 'POST' && call.url.endsWith('/api/v1/payment_method_domains'))!
    expect(JSON.parse(create.body!)).toEqual({ hostname: 'loja.com' })
    expect(create.headers.Authorization).toBe('Bearer key-whopl_biz_1')
    expect(result.file?.url).toContain('whop.com/.well-known')
  })

  it('Whop: arquivo ausente fica pendente com o motivo que a Whop deu', async () => {
    const { service } = setup(call => {
      if (call.method === 'GET') return { json: { data: [{ id: 'pmdm_1', hostname: 'loja.com', status: 'pending' }] } }
      return { status: 400, json: { error: { message: 'Association file not found.' } } }
    })
    const result = await service.register(SELLER, 'whopl_biz_1', 'loja.com')
    expect(result.registered).toMatchObject({ applePay: 'pending', message: 'Association file not found.' })
  })

  it('PayPal não registra domínio e a lista diz que não se aplica', async () => {
    const { service, calls } = setup(() => ({ json: {} }))
    await expect(service.register(SELLER, 'paypall_1', 'loja.com')).rejects.toThrow('PayPal')
    expect(await service.list(SELLER, 'paypall_1')).toMatchObject({ supported: false, file: null, domains: [] })
    expect(calls).toHaveLength(0)
  })

  it('domínio inválido volta como erro do pedido, sem chamar o provedor', async () => {
    const { service, calls } = setup(() => ({ json: {} }))
    await expect(service.register(SELLER, 'stripel_1', 'loja')).rejects.toBeInstanceOf(BadRequestException)
    expect(calls).toHaveLength(0)
  })

  it('chave restrita sem permissão explica o que liberar', async () => {
    const { service } = setup(() => ({ status: 403, json: { error: { message: 'permission' } } }))
    await expect(service.register(SELLER, 'stripel_1', 'loja.com')).rejects.toThrow('Payment Method Domains')
  })

  it('conta recém-conectada recebe o checkout da Koopfy, e uma falha não derruba nada', async () => {
    process.env.CHECKOUT_PUBLIC_URL = 'https://checkout.koopfy.com'
    const { service, calls } = setup(call => call.method === 'GET'
      ? { json: { data: [] } }
      : { json: { id: 'pmd_1', domain_name: 'checkout.koopfy.com', enabled: true, apple_pay: { status: 'inactive' }, google_pay: { status: 'active' } } })
    await service.registerPlatformHostsEverywhere(SELLER)
    const created = calls.filter(call => call.method === 'POST' && /payment_method_domains$/.test(call.url))
    // Whop e Stripe ativas; a Stripe com a chave recusada e o PayPal ficam de fora.
    expect(created.map(call => call.headers.Authorization)).toEqual(['Bearer key-whopl_biz_1', 'Bearer key-stripel_1'])

    const broken = setup(() => { throw new Error('rede fora') })
    await expect(broken.service.registerPlatformHostsEverywhere(SELLER)).resolves.toBeUndefined()
  })

  it('checkout incorporado: o domínio vai para todas as contas de cartão, cada uma responde por si', async () => {
    const { service } = setup(call => {
      if (call.url.includes('api.stripe.com')) return { status: 403, json: {} }
      if (call.method === 'GET') return { json: { data: [{ id: 'pmdm_1', hostname: 'loja.com', status: 'verified' }] } }
      return { json: {} }
    })
    const result = await service.registerEverywhere(SELLER, 'loja.com')
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ accountId: 'whopl_biz_1', name: 'Whop principal', domain: { applePay: 'active' }, error: null })
    expect(result[1]).toMatchObject({ accountId: 'stripel_1', name: 'Acme US', domain: null })
    expect(result[1].error).toContain('Payment Method Domains')
  })
})
