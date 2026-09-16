// Costura entre o checkout (lojas) e o pay (contas de pagamento): o fetch e o
// supabase são dublados, então o que está sob teste é só a junção.

const tables: Record<string, any[]> = {}

jest.mock('../lib/supabase.client', () => ({
  supabase: {
    from: (name: string) => {
      let rows = [...(tables[name] ?? [])]
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: unknown) => { rows = rows.filter(row => row[column] === value); return builder },
        in: (column: string, values: unknown[]) => { rows = rows.filter(row => values.includes(row[column])); return builder },
        or: (expression: string) => {
          const clauses = expression.split(',').map(clause => clause.split('.eq.'))
          rows = rows.filter(row => clauses.some(([column, value]) => String(row[column]) === value))
          return builder
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null }),
      }
      return builder
    },
  },
}))

import { ServiceUnavailableException } from '@nestjs/common'
import { CrmCheckoutService } from './crm-checkout.service'

/** Respostas do canal interno, por caminho depois de `/internal/`. */
const respostas: Record<string, unknown> = {}
const fetchMock = jest.fn(async (url: unknown, init?: any) => {
  const path = String(url).split('/internal/')[1] ?? ''
  const body = respostas[path]
  if (body === undefined) {
    return { ok: false, status: 404, text: async () => 'não encontrado' } as any
  }
  return { ok: true, status: 200, json: async () => body } as any
})

let service: CrmCheckoutService

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => { })
  process.env.CHECKOUT_INTERNAL_KEY = 'chave-interna'
  process.env.CHECKOUT_API_BASE = 'http://checkout.test'
  global.fetch = fetchMock as any
  fetchMock.mockClear()
  for (const key of Object.keys(respostas)) delete respostas[key]

  service = new CrmCheckoutService()

  tables.users = [
    { id: 'u-ana', name: 'Ana', email: 'ana@loja.com', owner_user_id: null },
    { id: 'u-ana-extra', name: 'Ana', email: 'ana+conta-1a2b@loja.com', owner_user_id: 'u-ana' },
    { id: 'u-bia', name: 'Bia', email: 'bia@loja.com', owner_user_id: null },
  ]
  tables.seller_profiles = [
    { id: 's-principal', user_id: 'u-ana', name: 'Conta Brasil', status: 'active', risk_level: 'WHITE', created_at: '2026-01-01', provider_default: 'whop' },
    { id: 's-extra', user_id: 'u-ana-extra', name: null, status: 'pending_review', risk_level: 'GRAY', created_at: '2026-06-01', provider_default: null },
    { id: 's-socio', user_id: 'u-bia', name: 'Conta da Bia', status: 'active', risk_level: 'BLACK', created_at: '2026-02-01', provider_default: 'stripe' },
  ]
  tables.wallet_balance = [
    { seller_id: 's-principal', available_balance: 150000, pending_balance: 2500, reserved_balance: 1000, withdrawing_balance: 0 },
  ]
})

afterEach(() => jest.restoreAllMocks())

describe('seller — contas de pagamento do pay', () => {
  beforeEach(() => {
    respostas['admin/sellers/user-checkout'] = {
      seller: { id: 'user-checkout', name: 'Ana', email: 'ANA@loja.com' },
      workspaces: [
        { id: 'w-1', name: 'Loja Brasil', sellerId: 's-principal' },
        { id: 'w-2', name: 'Loja da Bia', sellerId: 's-socio' },
      ],
      memberships: [{ id: 'w-9', name: 'Loja de terceiro' }],
      paymentAccounts: ['s-principal', 's-socio'],
    }
  })

  it('junta a conta principal e as contas a mais do mesmo dono, pelo e-mail', async () => {
    const detail: any = await service.seller('user-checkout')

    // O e-mail do checkout vem como o usuário digitou; a junção normaliza.
    expect(detail.paymentAccounts.map((a: any) => a.sellerId)).toEqual(['s-principal', 's-extra', 's-socio'])

    const principal = detail.paymentAccounts[0]
    expect(principal).toMatchObject({
      sellerId: 's-principal',
      name: 'Conta Brasil',
      status: 'active',
      riskLevel: 'WHITE',
      isOwnerAccount: true,
      inUse: true,
      workspaceIds: ['w-1'],
    })
    expect(principal.balance).toEqual({
      availableCents: 150000, pendingCents: 2500, reservedCents: 1000, withdrawingCents: 0,
    })

    // Conta a mais (users.owner_user_id): aparece mesmo sem loja e sem carteira.
    expect(detail.paymentAccounts[1]).toMatchObject({
      sellerId: 's-extra',
      name: 'Ana',
      isOwnerAccount: false,
      inUse: false,
      workspaceIds: [],
      balance: null,
    })

    // O resto da ficha é do checkout e passa intacto.
    expect(detail.seller.id).toBe('user-checkout')
    expect(detail.memberships).toHaveLength(1)
  })

  it('mostra a conta de fora que uma loja usa, marcada como em uso', async () => {
    const detail: any = await service.seller('user-checkout')

    expect(detail.paymentAccounts[2]).toMatchObject({
      sellerId: 's-socio',
      name: 'Conta da Bia',
      riskLevel: 'BLACK',
      isOwnerAccount: false,
      inUse: true,
      workspaceIds: ['w-2'],
    })
  })

  it('e-mail sem conta no pay devolve só as contas que as lojas usam', async () => {
    respostas['admin/sellers/user-checkout'] = {
      seller: { id: 'user-checkout', email: 'ninguem@loja.com' },
      workspaces: [{ id: 'w-2', name: 'Loja da Bia', sellerId: 's-socio' }],
      paymentAccounts: ['s-socio'],
    }

    const detail: any = await service.seller('user-checkout')
    expect(detail.paymentAccounts).toEqual([
      expect.objectContaining({ sellerId: 's-socio', isOwnerAccount: false, inUse: true }),
    ])
  })
})

describe('store — de quem é a conta da loja', () => {
  it('junta o perfil da conta que a loja usa', async () => {
    respostas['admin/workspaces/w-2'] = {
      workspace: { id: 'w-2', name: 'Loja da Bia' },
      paymentAccount: { sellerId: 's-socio', gateways: [{ gatewayKey: 'koopfy', status: 'active' }] },
    }

    const detail: any = await service.store('w-2')
    expect(detail.paymentAccount.account).toEqual({
      sellerId: 's-socio',
      name: 'Conta da Bia',
      status: 'active',
      riskLevel: 'BLACK',
      providerDefault: 'stripe',
    })
    // Não reescreve o que o checkout mandou.
    expect(detail.paymentAccount.gateways).toHaveLength(1)
    expect(detail.workspace.name).toBe('Loja da Bia')
  })

  it('loja sem conta vinculada volta como veio do checkout', async () => {
    respostas['admin/workspaces/w-3'] = {
      workspace: { id: 'w-3' },
      paymentAccount: { sellerId: null, gateways: [] },
    }

    const detail: any = await service.store('w-3')
    expect(detail.paymentAccount.account).toBeUndefined()
  })
})

describe('listagens', () => {
  it('repassam os filtros e não consultam o pay', async () => {
    respostas['admin/sellers?search=ana&page=2'] = { page: 2, pageSize: 20, total: 1, data: [] }

    await expect(service.listSellers({ search: 'ana', page: '2', pageSize: undefined }))
      .resolves.toEqual({ page: 2, pageSize: 20, total: 1, data: [] })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, any]
    expect(url).toBe('http://checkout.test/internal/admin/sellers?search=ana&page=2')
    expect(init.method).toBe('GET')
    expect(init.headers['x-internal-key']).toBe('chave-interna')
  })

  it('lojas usam o caminho de workspaces do checkout', async () => {
    respostas['admin/workspaces?status=active'] = { page: 1, pageSize: 20, total: 0, counters: {}, data: [] }

    await expect(service.listStores({ status: 'active' })).resolves.toMatchObject({ total: 0 })
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://checkout.test/internal/admin/workspaces?status=active')
  })
})

describe('trocar a conta de pagamento da loja', () => {
  const ctx = { managerId: 'gerente-1' }

  beforeEach(() => {
    respostas['admin/workspaces/w-1'] = {
      workspace: { id: 'w-1', name: 'Loja Brasil' },
      owner: { id: 'user-checkout', name: 'Ana', email: 'ANA@loja.com' },
      paymentAccount: { sellerId: 's-principal', gateways: [] },
    }
  })

  it('aceita a conta a mais do mesmo dono', async () => {
    respostas['admin/workspaces/w-1/payment-account'] = {
      workspaceId: 'w-1', previousSellerId: 's-principal', sellerId: 's-extra', unlinked: false,
    }

    const result = await service.setStoreAccount('w-1', 's-extra', ctx)

    expect(result).toMatchObject({ sellerId: 's-extra', previousSellerId: 's-principal', storeName: 'Loja Brasil' })
    const [url, init] = fetchMock.mock.calls.at(-1) as any
    expect(String(url)).toBe('http://checkout.test/internal/admin/workspaces/w-1/payment-account')
    expect(JSON.parse(init.body)).toEqual({ sellerId: 's-extra', managerId: 'gerente-1' })
  })

  it('recusa conta de outro dono, que é para onde o dinheiro iria parar', async () => {
    const erro: any = await service.setStoreAccount('w-1', 's-socio', ctx).catch(e => e)

    expect(erro.status).toBe(400)
    expect(erro.message).toContain('não é do dono da loja')
    // Nada foi escrito no checkout: só a leitura da loja aconteceu.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('desvincular não precisa de conta e avisa o checkout', async () => {
    respostas['admin/workspaces/w-1/payment-account'] = {
      workspaceId: 'w-1', previousSellerId: 's-principal', sellerId: null, unlinked: true,
    }

    const result = await service.setStoreAccount('w-1', null, ctx)

    expect(result).toMatchObject({ unlinked: true, sellerId: null, accountName: null })
  })
})

describe('reenviar pedido para a Shopify', () => {
  it('repassa a loja do pedido para o checkout', async () => {
    respostas['admin/orders/o-1/shopify'] = { shopifyOrderId: '123' }

    await expect(service.resendOrderToShopify('o-1', 'w-1')).resolves.toMatchObject({ shopifyOrderId: '123' })
    const [, init] = fetchMock.mock.calls.at(-1) as any
    expect(JSON.parse(init.body)).toEqual({ workspaceId: 'w-1' })
  })

  it('sem a loja nem chama o checkout', async () => {
    const erro: any = await service.resendOrderToShopify('o-1', '').catch(e => e)

    expect(erro.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('checkout fora do ar', () => {
  it('vira 503 dizendo a ação e a causa', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:3006'))

    const erro: any = await service.seller('user-checkout').catch(e => e)
    expect(erro).toBeInstanceOf(ServiceUnavailableException)
    expect(erro.message).toContain('carregar o seller no checkout')
    expect(erro.message).toContain('ECONNREFUSED')
    expect(erro.message).toContain('http://checkout.test')
  })

  it('sem chave interna nem chega a chamar o checkout', async () => {
    delete process.env.CHECKOUT_INTERNAL_KEY

    const erro: any = await service.overview().catch(e => e)
    expect(erro).toBeInstanceOf(ServiceUnavailableException)
    expect(erro.message).toContain('CHECKOUT_INTERNAL_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
