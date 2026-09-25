// Quem pode cobrar e ativar o checkout: aprovado pela Koopfy, ou no modo conta
// externa com a conta Whop dele cobrando. O supabase é dublado com a linha de
// whop_linked_accounts de cada seller.

const linkedRows: Record<string, any> = {}

jest.mock('../../lib/supabase.client', () => ({
  supabase: {
    from: () => {
      let sellerId = ''
      const builder: any = {
        select: () => builder,
        eq: (_column: string, value: string) => { sellerId = value; return builder },
        maybeSingle: async () => ({ data: linkedRows[sellerId] ?? null, error: null }),
      }
      return builder
    },
  },
}))
jest.mock('../../crypto/crypto.service', () => ({ CryptoService: class { } }))

import { sellerMayOperate } from './whop-linked.service'

beforeEach(() => {
  for (const key of Object.keys(linkedRows)) delete linkedRows[key]
})

const conectada = { status: 'active', whop_account_id: 'biz_do_seller', last_error: null }

describe('sellerMayOperate', () => {
  it('seller aprovado opera sem olhar a conta externa', async () => {
    expect(await sellerMayOperate({ id: 's-1', status: 'active' })).toBe(true)
  })

  it('sem aprovação, opera só com a conta Whop dele cobrando', async () => {
    linkedRows['s-1'] = conectada
    expect(await sellerMayOperate({ id: 's-1', status: 'pending_review' })).toBe(true)
  })

  it('liberado mas sem conectar não opera', async () => {
    linkedRows['s-1'] = { status: 'allowed', whop_account_id: null, last_error: null }
    expect(await sellerMayOperate({ id: 's-1', status: 'pending_review' })).toBe(false)
  })

  it('chave recusada ou conexão desligada volta a travar', async () => {
    linkedRows['s-1'] = { ...conectada, status: 'invalid' }
    expect(await sellerMayOperate({ id: 's-1', status: 'pending_review' })).toBe(false)
    linkedRows['s-1'] = { ...conectada, status: 'disabled' }
    expect(await sellerMayOperate({ id: 's-1', status: 'pending_review' })).toBe(false)
  })

  it('sem modo externo, conta em análise não opera', async () => {
    expect(await sellerMayOperate({ id: 's-1', status: 'pending_review' })).toBe(false)
  })

  it('recusado e suspenso não operam nem com a conta conectada', async () => {
    linkedRows['s-1'] = conectada
    expect(await sellerMayOperate({ id: 's-1', status: 'rejected' })).toBe(false)
    expect(await sellerMayOperate({ id: 's-1', status: 'suspended' })).toBe(false)
    expect(await sellerMayOperate(null)).toBe(false)
  })
})

describe('afiliado da Koopfy na conta do seller', () => {
  const { WhopLinkedAccountsService } = jest.requireActual('./whop-linked.service')

  afterEach(() => { delete process.env.KOOPFY_WHOP_AFFILIATE })

  // Resposta de POST /api/v1/affiliates como a doc da Whop descreve: sem
  // `affiliate_code`; o código de atribuição é o username do afiliado.
  const whop = (affiliate: any) => jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith('/overrides') ? { id: 'ovr_1' } : affiliate),
  }))

  it('usa o username do afiliado como código de atribuição', async () => {
    process.env.KOOPFY_WHOP_AFFILIATE = 'lucas@koopfy.com'
    global.fetch = whop({ id: 'aff_1', status: 'active', user: { id: 'user_1', username: 'koopfy' } }) as any
    const service = new WhopLinkedAccountsService({} as any)

    const result = await (service as any).setupAffiliate('chave', 'https://api.whop.com', 'biz_1', 3)

    expect(result).toEqual({ id: 'aff_1', code: 'koopfy', overrideId: 'ovr_1' })
  })

  it('sem username falha em vez de conectar sem comissão', async () => {
    process.env.KOOPFY_WHOP_AFFILIATE = 'lucas@koopfy.com'
    global.fetch = whop({ id: 'aff_1', user: { id: 'user_1' } }) as any
    const service = new WhopLinkedAccountsService({} as any)

    await expect((service as any).setupAffiliate('chave', 'https://api.whop.com', 'biz_1', 3)).rejects.toThrow(/username/)
  })
})
