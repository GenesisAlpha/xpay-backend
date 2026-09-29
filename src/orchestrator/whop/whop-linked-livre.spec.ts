// Provedor externo liberado para todos (2026-09-28): sem registro em
// whop_linked_accounts o seller vê e conecta a conta Whop dele; o CRM só corta.
// O supabase é dublado com a linha de cada seller e guarda os upserts.

const linkedRows: Record<string, any> = {}
const upserts: any[] = []

jest.mock('../../lib/supabase.client', () => ({
  supabase: {
    from: (table: string) => {
      let sellerId = ''
      const builder: any = {
        select: () => builder,
        eq: (_column: string, value: string) => { sellerId = value; return builder },
        maybeSingle: async () => ({ data: table === 'whop_linked_accounts' ? linkedRows[sellerId] ?? null : null, error: null }),
        upsert: async (row: any) => {
          upserts.push(row)
          linkedRows[row.seller_id] = { ...(linkedRows[row.seller_id] ?? {}), ...row }
          return { error: null }
        },
        insert: async () => ({ error: null }),
      }
      return builder
    },
  },
}))
jest.mock('../../crypto/crypto.service', () => ({ CryptoService: class { } }))

import { WhopLinkedAccountsService } from './whop-linked.service'

const service = () => new WhopLinkedAccountsService({} as any)

beforeEach(() => {
  for (const key of Object.keys(linkedRows)) delete linkedRows[key]
  upserts.length = 0
})

describe('provedor externo liberado para todos', () => {
  it('sem registro, o painel vê a opção liberada', async () => {
    expect((await service().status('s-1')).allowed).toBe(true)
  })

  it('cortado no CRM, a opção some', async () => {
    linkedRows['s-1'] = { seller_id: 's-1', status: 'disabled' }
    expect((await service().status('s-1')).allowed).toBe(false)
  })

  it('cortar quem nunca teve registro grava o bloqueio', async () => {
    const view = await service().allow('s-1', false, 'gerente')
    expect(upserts).toEqual([expect.objectContaining({ seller_id: 's-1', status: 'disabled' })])
    expect(view.allowed).toBe(false)
  })

  it('cortado no CRM não conecta sozinho', async () => {
    linkedRows['s-1'] = { seller_id: 's-1', status: 'disabled' }
    await expect(service().connect('s-1', 'chave')).rejects.toThrow('desativado')
    expect(upserts).toHaveLength(0)
  })
})
