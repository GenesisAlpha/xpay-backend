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

import { ownWhopAccountCommissionPct, sellerMayOperate } from './whop-linked.service'

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

describe('ownWhopAccountCommissionPct', () => {
  it('conta dele cobrando: vale o percentual do CRM', async () => {
    linkedRows['s-1'] = { ...conectada, commission_pct: 4.5 }
    expect(await ownWhopAccountCommissionPct('s-1')).toBe(4.5)
  })

  it('sem percentual gravado: 3%', async () => {
    linkedRows['s-1'] = { ...conectada, commission_pct: null }
    expect(await ownWhopAccountCommissionPct('s-1')).toBe(3)
  })

  it('venda que não sai pela conta dele não tem comissão de conta própria', async () => {
    expect(await ownWhopAccountCommissionPct('s-1')).toBeNull()
    linkedRows['s-1'] = { status: 'allowed', whop_account_id: null, last_error: null, commission_pct: 3 }
    expect(await ownWhopAccountCommissionPct('s-1')).toBeNull()
  })
})
