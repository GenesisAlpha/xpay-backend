const rpc = jest.fn()
const select = jest.fn()

jest.mock('../lib/supabase.client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(select('fees')),
        then: (resolve: any) => resolve(select('ledger')),
      }
      return chain
    },
  },
}))

import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common'
import { AnticipationService, mapAnticipationError } from './anticipation.service'

describe('AnticipationService', () => {
  const service = new AnticipationService()

  beforeEach(() => {
    rpc.mockReset()
    select.mockReset()
  })

  function feesRow(extra: Record<string, unknown> = {}) {
    return { data: { seller_id: 's1', processing_fee_pct: 8.9, anticipation_enabled: true, anticipation_fee_pct: 5, ...extra }, error: null }
  }

  it('quotes the pending credits with the seller fee', async () => {
    select.mockImplementation((kind: string) =>
      kind === 'fees' ? feesRow() : { data: [{ amount: 10000 }, { amount: 5000 }], error: null },
    )
    await expect(service.quote('s1')).resolves.toMatchObject({
      enabled: true, feePct: 5, entries: 2, pendingCents: 15000, feeCents: 750, netCents: 14250, net: 142.5,
    })
  })

  it('refuses when anticipation is disabled for the seller', async () => {
    select.mockImplementation((kind: string) => (kind === 'fees' ? feesRow({ anticipation_enabled: false }) : { data: [], error: null }))
    await expect(service.anticipate('s1', { expectedPendingCents: 1000 })).rejects.toBeInstanceOf(ForbiddenException)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('sends the amount the seller saw and returns the result', async () => {
    select.mockImplementation((kind: string) => (kind === 'fees' ? feesRow() : { data: [], error: null }))
    rpc.mockResolvedValue({ data: { reference: 'r1', entries: 2, pending_cents: 15000, fee_cents: 750 }, error: null })
    await expect(service.anticipate('s1', { expectedPendingCents: 15000 })).resolves.toMatchObject({
      reference: 'r1', pendingCents: 15000, feeCents: 750, netCents: 14250,
    })
    expect(rpc).toHaveBeenCalledWith('anticipate_pending_balance', { p_seller_id: 's1', p_fee_pct: 5, p_expected_cents: 15000 })
  })

  it('maps database errors to messages the seller can act on', () => {
    expect(mapAnticipationError({ message: 'pending changed' })).toBeInstanceOf(ConflictException)
    expect(mapAnticipationError({ message: 'nothing to anticipate' })).toBeInstanceOf(ConflictException)
    expect(mapAnticipationError({ code: 'PGRST202', message: 'Could not find the function' })).toBeInstanceOf(ServiceUnavailableException)
  })
})
