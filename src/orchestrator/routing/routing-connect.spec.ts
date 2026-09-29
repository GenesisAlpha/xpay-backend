// Conexão de várias contas com o roteamento: Stripe/PayPal ADICIONAM conta
// (com apelido), a segunda Whop vira extra `whopa_…` com webhook próprio, a
// desconexão é por conta, e com o roteamento desligado continua valendo uma
// conta por provedor e a exclusão Whop × Stripe.

const tables: Record<string, any[]> = {}

function matches(row: any, filters: Array<[string, string, any]>) {
  return filters.every(([op, column, value]) => (op === 'eq' ? row[column] === value : op === 'neq' ? row[column] !== value : true))
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

import { ConflictException, NotFoundException } from '@nestjs/common'
import { SellerProviderAccountsService } from '../seller-provider/seller-provider-accounts.service'
import { WhopLinkedAccountsService } from '../whop/whop-linked.service'
import { WhopAccountsService } from '../whop/whop-accounts.service'

const crypto = {
  encrypt: (value: string) => `enc(${value})`,
  decrypt: (value: string) => value.replace(/^enc\((.*)\)$/, '$1'),
}

function stripeService() {
  const svc = new SellerProviderAccountsService(crypto as any)
  let n = 0
  svc.fetchImpl = async (url: string, init: any) => {
    let body: any = {}
    if (url.endsWith('/v1/account')) body = { id: `acct_${init.headers.Authorization.slice(-3)}` }
    else if (url.includes('/v1/webhook_endpoints?')) body = { data: [] }
    else if (url.endsWith('/v1/webhook_endpoints')) body = { id: `we_${++n}`, secret: `whsec_${n}` }
    return { ok: true, status: 200, json: async () => body }
  }
  return svc
}

const stripeRows = () => (tables.seller_provider_accounts ?? []).filter(r => r.provider === 'stripe')

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key]
  process.env.PAY_PUBLIC_URL = 'https://api.koopfy.test/pay'
})

describe('Stripe com várias contas', () => {
  it('roteamento ligado: cada conexão ADICIONA uma conta, com apelido; mesma conta reconecta na mesma linha', async () => {
    tables.seller_routing_settings = [{ seller_id: 's-1', enabled: true }]
    tables.whop_linked_accounts = [{ seller_id: 's-1', status: 'active', whop_account_id: 'biz_1', api_key: 'k' }]
    const svc = stripeService()

    // Com a Whop ativa: roteamento ligado deixa as duas conviverem.
    const a = await svc.connectStripe('s-1', { secretKey: 'sk_live_aaa', publishableKey: 'pk_live_aaa', label: 'Stripe EUA' })
    svc.forgetSeller('s-1')
    const b = await svc.connectStripe('s-1', { secretKey: 'sk_live_bbb', publishableKey: 'pk_live_bbb' })
    svc.forgetSeller('s-1')
    expect(a!.id).not.toBe(b!.id)
    expect(stripeRows().map(r => r.status)).toEqual(['active', 'active'])
    expect(tables.seller_routing_accounts).toEqual([
      expect.objectContaining({ provider_account_id: `stripel_${a!.id}`, provider: 'stripe', label: 'Stripe EUA' }),
    ])

    const again = await svc.connectStripe('s-1', { secretKey: 'sk_live_aaa', publishableKey: 'pk_live_aaa' })
    expect(again!.id).toBe(a!.id)
    expect(stripeRows()).toHaveLength(2)
  })

  it('roteamento desligado: uma conta por provedor — a outra fica guardada', async () => {
    tables.seller_provider_accounts = [{
      id: '11111111-1111-1111-1111-111111111111', seller_id: 's-1', provider: 'stripe', status: 'active', account_ref: 'acct_old', secret_enc: 'x', public_key: 'pk',
    }, {
      id: '22222222-2222-2222-2222-222222222222', seller_id: 's-1', provider: 'stripe', status: 'standby', account_ref: 'acct_bbb', secret_enc: 'x', public_key: 'pk',
    }]
    const svc = stripeService()
    // Conta que estava guardada volta para a linha dela; a atual vai para standby.
    const row = await svc.connectStripe('s-1', { secretKey: 'sk_live_bbb', publishableKey: 'pk_live_bbb' })
    expect(row!.id).toBe('22222222-2222-2222-2222-222222222222')
    expect(Object.fromEntries(stripeRows().map(r => [r.account_ref, r.status]))).toEqual({ acct_old: 'standby', acct_bbb: 'active' })
  })

  it('roteamento desligado: exclusão Whop × Stripe continua', async () => {
    tables.whop_linked_accounts = [{ seller_id: 's-1', status: 'active', whop_account_id: 'biz_1', api_key: 'k' }]
    await expect(stripeService().connectStripe('s-1', { secretKey: 'sk_live_aaa', publishableKey: 'pk_live_aaa' }))
      .rejects.toBeInstanceOf(ConflictException)
  })

  it('desconecta UMA conta; de outro seller responde "não encontrada"', async () => {
    tables.seller_provider_accounts = [
      { id: '33333333-3333-3333-3333-333333333333', seller_id: 's-1', provider: 'stripe', status: 'active', secret_enc: 'enc(sk)', webhook_id: 'we_9', public_key: 'pk' },
      { id: '44444444-4444-4444-4444-444444444444', seller_id: 's-2', provider: 'stripe', status: 'active', secret_enc: 'enc(sk)', public_key: 'pk' },
    ]
    const svc = stripeService()
    await expect(svc.disconnectById('s-1', 'stripel_44444444-4444-4444-4444-444444444444')).rejects.toBeInstanceOf(NotFoundException)
    // Prefixo errado para a linha também não resolve.
    await expect(svc.disconnectById('s-1', 'paypall_33333333-3333-3333-3333-333333333333')).rejects.toBeInstanceOf(NotFoundException)
    expect(await svc.disconnectById('s-1', 'stripel_33333333-3333-3333-3333-333333333333')).toEqual({ id: 'stripel_33333333-3333-3333-3333-333333333333', disconnected: true })
    expect(tables.seller_provider_accounts.map(r => r.status)).toEqual(['disabled', 'active'])
  })
})

describe('Whop extra (whopa_)', () => {
  const fetchMock = jest.spyOn(global, 'fetch' as any)
  afterAll(() => fetchMock.mockRestore())

  function whopApi(company: string) {
    const webhooks: any[] = []
    fetchMock.mockImplementation((async (url: string, init: any) => {
      if (url.endsWith('/api/v5/company')) return { ok: true, status: 200, json: async () => ({ id: company, title: 'Loja Extra' }) }
      if (url.endsWith('/api/v1/webhooks')) {
        webhooks.push(JSON.parse(init.body))
        return { ok: true, status: 200, json: async () => ({ id: 'hook_2', webhook_secret: 'ws_extra' }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as any)
    return webhooks
  }

  it('com o roteamento e a principal conectada, outra company vira conta extra com webhook próprio', async () => {
    tables.seller_routing_settings = [{ seller_id: 's-1', enabled: true }]
    tables.whop_linked_accounts = [{ seller_id: 's-1', status: 'active', whop_account_id: 'biz_main', api_key: 'enc(k)', commission_pct: 3 }]
    tables.seller_provider_accounts = [{ id: 'aaaaaaaa-0000-0000-0000-000000000000', seller_id: 's-1', provider: 'stripe', status: 'active', secret_enc: 'x', public_key: 'pk' }]
    const webhooks = whopApi('biz_extra')

    const providers = new SellerProviderAccountsService(crypto as any)
    const whop = new WhopLinkedAccountsService(crypto as any, providers)
    await whop.connect('s-1', 'chave-extra', 'seller:u', { label: 'Whop 2' })

    const extra = tables.seller_provider_accounts.find(r => r.provider === 'whop')
    expect(extra).toMatchObject({
      seller_id: 's-1', status: 'active', account_ref: 'biz_extra', public_key: 'biz_extra',
      secret_enc: 'enc(chave-extra)', webhook_secret_enc: 'enc(ws_extra)', display_name: 'Loja Extra',
    })
    expect(webhooks[0]).toMatchObject({ resource_id: 'biz_extra', url: `https://api.koopfy.test/pay/webhook/whop/whopa_${extra.id}` })
    // A principal fica intacta.
    expect(tables.whop_linked_accounts[0]).toMatchObject({ whop_account_id: 'biz_main', api_key: 'enc(k)' })
    expect(tables.seller_routing_accounts[0]).toMatchObject({ provider_account_id: `whopa_${extra.id}`, label: 'Whop 2', provider: 'whop' })

    // Webhook e cobrança resolvem a conta pelo id, com o segredo DELA.
    const accounts = new WhopAccountsService(crypto as any, undefined, whop, providers)
    expect(await accounts.getById(`whopa_${extra.id}`)).toMatchObject({
      id: `whopa_${extra.id}`,
      provider: 'whop',
      apiKey: 'chave-extra',
      config: { company_id: 'biz_extra', linked: true, seller_id: 's-1', webhook_secret: 'ws_extra' },
    })
  })

  it('sem roteamento, a Whop continua sendo UMA (troca a principal)', async () => {
    tables.whop_linked_accounts = [{ seller_id: 's-1', status: 'active', whop_account_id: 'biz_main', api_key: 'enc(k)', commission_pct: 3 }]
    whopApi('biz_other')
    const providers = new SellerProviderAccountsService(crypto as any)
    const whop = new WhopLinkedAccountsService(crypto as any, providers)
    await whop.connect('s-1', 'chave-nova')
    expect(tables.seller_provider_accounts).toBeUndefined()
    expect(tables.whop_linked_accounts[0]).toMatchObject({ whop_account_id: 'biz_other' })
  })
})
