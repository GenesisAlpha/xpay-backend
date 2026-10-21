// Contas Stripe/PayPal próprias do seller, sem rede e sem banco: o supabase é
// dublado por tabela e o fetch registra cada chamada que iria à Stripe/PayPal.

const tables: Record<string, any[]> = {}
const writes: Array<{ table: string; op: string; row: any }> = []

function matches(row: any, filters: Array<[string, string, any]>) {
  return filters.every(([op, column, value]) => (op === 'eq' ? row[column] === value : row[column] !== value))
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
        insert: async (row: any) => { writes.push({ table, op: 'insert', row }); return { error: null } },
        upsert: async (row: any) => {
          writes.push({ table, op: 'upsert', row })
          tables[table] = [...(tables[table] ?? []).filter(r => !(r.seller_id === row.seller_id && (r.provider ?? null) === (row.provider ?? null))), row]
          return { error: null }
        },
        update: (patch: any) => {
          writes.push({ table, op: 'update', row: patch })
          const upd: any = {
            eq: (column: string, value: any) => {
              for (const r of tables[table] ?? []) if (r[column] === value) Object.assign(r, patch)
              return Promise.resolve({ error: null })
            },
          }
          return upd
        },
      }
      return builder
    },
  },
}))
jest.mock('../../crypto/crypto.service', () => ({ CryptoService: class { } }))

import { ConflictException } from '@nestjs/common'
import { PaypalTokenCache } from '../paypal/paypal-api'
import { WhopLinkedAccountsService, sellerMayOperate } from '../whop/whop-linked.service'
import {
  SellerProviderAccountsService,
  ownAccountCommissionPct,
  resolveOwnSale,
  sellerChargesOnLinkAccount,
} from './seller-provider-accounts.service'

const crypto = {
  encrypt: (value: string) => `enc(${value})`,
  decrypt: (value: string) => value.replace(/^enc\((.*)\)$/, '$1'),
}

type Call = { url: string; init: any }

function service(responder: (call: Call) => any = () => ({})) {
  const calls: Call[] = []
  const svc = new SellerProviderAccountsService(crypto as any)
  svc.fetchImpl = async (url: string, init: any) => {
    const call = { url, init }
    calls.push(call)
    const body = responder(call)
    const status = body?.__status ?? 200
    return { ok: status < 300, status, json: async () => body }
  }
  svc.paypalTokenCache = new PaypalTokenCache(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'tok', expires_in: 32400, app_id: 'APP-1' }),
  }) as any)
  return { svc, calls }
}

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key]
  writes.length = 0
  process.env.PAY_PUBLIC_URL = 'https://api.koopfy.test/pay'
})

describe('Whop × Stripe mutuamente exclusivas', () => {
  it('Stripe não conecta com a Whop dele ativa — e nem chega a chamar a Stripe', async () => {
    tables.whop_linked_accounts = [{ seller_id: 's-1', status: 'active', whop_account_id: 'biz_1', api_key: 'k' }]
    const { svc, calls } = service()
    await expect(svc.connectStripe('s-1', { secretKey: 'sk_live_abc', publishableKey: 'pk_live_abc' }))
      .rejects.toThrow(ConflictException)
    expect(calls).toHaveLength(0)
  })

  it('PayPal conecta mesmo com a Whop ativa', async () => {
    tables.whop_linked_accounts = [{ seller_id: 's-1', status: 'active', whop_account_id: 'biz_1', api_key: 'k' }]
    const { svc } = service(({ url, init }) => {
      if (url.endsWith('/v1/notifications/webhooks') && init.method === 'GET') return { webhooks: [] }
      if (url.endsWith('/v1/notifications/webhooks')) return { id: 'WH-1' }
      return {}
    })
    const row = await svc.connectPaypal('s-1', {
      clientId: 'AaBbCcDdEeFfGgHhIiJjKkLl',
      clientSecret: 'EeFfGgHhIiJjKkLlMmNnOoPp',
      mode: 'test',
    })
    expect(row).toMatchObject({ provider: 'paypal', status: 'active', mode: 'test', webhook_id: 'WH-1', account_ref: 'APP-1' })
    expect(row?.secret_enc).toBe('enc(EeFfGgHhIiJjKkLlMmNnOoPp)')
  })

  it('Whop não conecta com a Stripe dele ativa', async () => {
    tables.seller_provider_accounts = [{ seller_id: 's-1', provider: 'stripe', status: 'active', secret_enc: 'enc(sk)' }]
    tables.whop_linked_accounts = [{ seller_id: 's-1', status: 'allowed' }]
    const whop = new WhopLinkedAccountsService(crypto as any)
    await expect(whop.connect('s-1', 'chave-whop')).rejects.toThrow(/Desconecte a Stripe/)
  })

  it('modo cortado no CRM não conecta Stripe nem PayPal', async () => {
    tables.whop_linked_accounts = [{ seller_id: 's-1', status: 'disabled' }]
    const { svc } = service()
    await expect(svc.connectStripe('s-1', { secretKey: 'sk_live_abc', publishableKey: 'pk_live_abc' })).rejects.toThrow('desativado')
  })
})

describe('connectStripe', () => {
  it('valida a chave, cria o webhook na conta dele e guarda tudo cifrado', async () => {
    const { svc, calls } = service(({ url, init }) => {
      if (url.endsWith('/v1/account')) return { id: 'acct_123', settings: { dashboard: { display_name: 'Loja do Seller' } } }
      if (url.includes('/v1/webhook_endpoints?')) return { data: [] }
      if (url.endsWith('/v1/webhook_endpoints') && init.method === 'POST') return { id: 'we_1', secret: 'whsec_1' }
      return {}
    })
    const row = await svc.connectStripe('s-1', { secretKey: 'sk_test_abc', publishableKey: 'pk_test_abc' })

    expect(row).toMatchObject({
      provider: 'stripe',
      status: 'active',
      mode: 'test',
      account_ref: 'acct_123',
      display_name: 'Loja do Seller',
      public_key: 'pk_test_abc',
      secret_enc: 'enc(sk_test_abc)',
      webhook_id: 'we_1',
      webhook_secret_enc: 'enc(whsec_1)',
    })

    const create = calls.find(call => call.init.method === 'POST')!
    const form = new URLSearchParams(create.init.body)
    expect(form.get('url')).toBe(`https://api.koopfy.test/pay/webhook/stripe/stripel_${row!.id}`)
    expect(form.getAll('enabled_events[]')).toEqual([
      'payment_intent.succeeded',
      'payment_intent.payment_failed',
      'payment_intent.canceled',
      'charge.refunded',
      'charge.dispute.created',
      'charge.dispute.closed',
    ])
    expect(create.init.headers.Authorization).toBe('Bearer sk_test_abc')
  })

  it('recusa conta Stripe que é da Koopfy', async () => {
    tables.stripe_accounts = [{ id: 'stripe_br_01', stripe_account_id: 'acct_koopfy' }]
    const { svc } = service(({ url }) => (url.endsWith('/v1/account') ? { id: 'acct_koopfy' } : {}))
    await expect(svc.connectStripe('s-1', { secretKey: 'sk_live_abc', publishableKey: 'pk_live_abc' }))
      .rejects.toThrow('pertence à Koopfy')
  })

  it('chave recusada pela Stripe vira mensagem para o seller', async () => {
    const { svc } = service(() => ({ __status: 401, error: { message: 'Invalid API Key' } }))
    await expect(svc.connectStripe('s-1', { secretKey: 'sk_live_abc', publishableKey: 'pk_live_abc' }))
      .rejects.toThrow('A Stripe recusou esta chave')
  })
})

describe('roteador: conta do seller', () => {
  it('stripel_ vira conta stripe `linked` com o par pk/sk e o whsec dele', async () => {
    tables.seller_provider_accounts = [{
      id: '11111111-2222-3333-4444-555555555555', seller_id: 's-1', provider: 'stripe', status: 'active', mode: 'live',
      public_key: 'pk_live_x', secret_enc: 'enc(sk_live_x)', webhook_secret_enc: 'enc(whsec_x)', account_ref: 'acct_1',
    }]
    const { svc } = service()
    const account = await svc.getProviderAccountById('stripel_11111111-2222-3333-4444-555555555555')
    expect(account).toMatchObject({
      id: 'stripel_11111111-2222-3333-4444-555555555555',
      provider: 'stripe',
      status: 'active',
      apiKey: 'sk_live_x',
      config: { publishable_key: 'pk_live_x', webhook_secret: 'whsec_x', linked: true, seller_id: 's-1' },
    })
    // Prefixo de PayPal numa linha Stripe não resolve.
    expect(await svc.getProviderAccountById('paypall_11111111-2222-3333-4444-555555555555')).toBeNull()
  })
})

describe('verifyPaypalWebhook', () => {
  it('manda o evento e o webhook_id DESTA conta ao PayPal e só aceita SUCCESS', async () => {
    const { svc, calls } = service(() => ({ verification_status: 'SUCCESS' }))
    const account: any = {
      id: 'paypall_1',
      provider: 'paypal',
      apiKey: 'client-id',
      apiSecret: 'client-secret',
      config: { webhook_id: 'WH-DA-CONTA', mode: 'test' },
    }
    const event = { id: 'WH-EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1' } }
    const ok = await svc.verifyPaypalWebhook(account, {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
      'paypal-transmission-id': 'tid',
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': '2026-09-28T12:00:00Z',
    }, event)

    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(calls[0].init.body)).toEqual({
      auth_algo: 'SHA256withRSA',
      cert_url: 'https://api.sandbox.paypal.com/cert',
      transmission_id: 'tid',
      transmission_sig: 'sig',
      transmission_time: '2026-09-28T12:00:00Z',
      webhook_id: 'WH-DA-CONTA',
      webhook_event: event,
    })
  })

  it('FAILURE (evento de outra conta ou forjado) não passa', async () => {
    const { svc } = service(() => ({ verification_status: 'FAILURE' }))
    const account: any = { id: 'paypall_1', apiKey: 'c', apiSecret: 's', config: { webhook_id: 'WH', mode: 'live' } }
    expect(await svc.verifyPaypalWebhook(account, {}, {})).toBe(false)
  })
})

describe('comissão e venda em conta própria', () => {
  it('comissão: percentual do CRM em qualquer status, senão 3%', async () => {
    expect(await ownAccountCommissionPct('s-1')).toBe(3)
    tables.whop_linked_accounts = [{ seller_id: 's-1', status: 'allowed', commission_pct: 5 }]
    expect(await ownAccountCommissionPct('s-1')).toBe(5)
  })

  it('venda de cartão com Stripe própria sai por ela, com a comissão do seller', async () => {
    tables.seller_provider_accounts = [
      { seller_id: 's-1', provider: 'stripe', status: 'active', secret_enc: 'x', public_key: 'pk' },
      { seller_id: 's-1', provider: 'paypal', status: 'active', secret_enc: 'x', public_key: 'cid' },
    ]
    expect(await resolveOwnSale({ sellerId: 's-1', providerDefault: 'whop', method: 'card' }))
      .toEqual({ provider: 'stripe', commissionPct: 3 })
    expect(await resolveOwnSale({ sellerId: 's-1', providerDefault: 'whop', method: 'paypal' }))
      .toEqual({ provider: 'paypal', commissionPct: 3 })
  })

  it('seller em análise opera com qualquer conta própria cobrando', async () => {
    expect(await sellerMayOperate({ id: 's-1', status: 'pending_review' })).toBe(false)
    tables.seller_provider_accounts = [{ seller_id: 's-1', provider: 'paypal', status: 'active', secret_enc: 'x', public_key: 'cid' }]
    expect(await sellerMayOperate({ id: 's-1', status: 'pending_review' })).toBe(true)
  })

  it('seller em análise opera com a loja Shopify / Digistore24 ativa no roteamento', async () => {
    expect(await sellerMayOperate({ id: 's-link', status: 'pending_review' })).toBe(false)
    tables.seller_link_accounts = [{ seller_id: 's-link', provider: 'shopify', status: 'disabled' }]
    expect(await sellerMayOperate({ id: 's-link', status: 'pending_review' })).toBe(false)
    tables.seller_link_accounts = [{ seller_id: 's-link', provider: 'shopify', status: 'active' }]
    expect(await sellerMayOperate({ id: 's-link', status: 'pending_review' })).toBe(true)
    expect(await sellerChargesOnLinkAccount('s-link')).toBe(true)
    tables.seller_link_accounts = [{ seller_id: 's-link', provider: 'digistore24', status: 'active' }]
    expect(await sellerMayOperate({ id: 's-link', status: 'pending_review' })).toBe(true)
    // Recusado e suspenso continuam travados, como nas outras contas próprias.
    expect(await sellerMayOperate({ id: 's-link', status: 'rejected' })).toBe(false)
    expect(await sellerMayOperate({ id: 's-link', status: 'suspended' })).toBe(false)
    // A loja não vira provedor de venda do pay: resolveOwnSale segue sem conta própria.
    expect(await resolveOwnSale({ sellerId: 's-link', providerDefault: null, method: 'card' })).toBeNull()
  })

  it('loja por link não conta com a Koopfy Payments escolhida', async () => {
    tables.seller_profiles = [{ id: 's-link-k', config: { payment_account: 'koopfy' } }]
    tables.seller_link_accounts = [{ seller_id: 's-link-k', provider: 'shopify', status: 'active' }]
    expect(await sellerMayOperate({ id: 's-link-k', status: 'pending_review' })).toBe(false)
    expect(await sellerChargesOnLinkAccount('s-link-k')).toBe(false)
  })

  it('CRM define a comissão mesmo sem conta Whop conectada', async () => {
    const whop = new WhopLinkedAccountsService(crypto as any)
    const view: any = await whop.setCommission('s-1', 4, 'gerente')
    expect(writes.find(w => w.table === 'whop_linked_accounts' && w.op === 'upsert')?.row)
      .toMatchObject({ seller_id: 's-1', status: 'allowed', commission_pct: 4 })
    expect(view.commissionPct).toBe(4)
    expect(view.connected).toBe(false)
    expect(await ownAccountCommissionPct('s-1')).toBe(4)
  })
})
