// A comissão sai de dentro do platform_fee, então o que importa provar é que o
// seller indicado nunca paga a mais e que a soma fecha com o fee original.
// A data de pagamento em si é do payout-cycle.spec.

const referralResult = jest.fn()
const cycleResult = jest.fn()

jest.mock('../lib/supabase.client', () => ({
    supabase: {
        // Duas tabelas com formatos de query diferentes: o vínculo filtra por
        // expires_at (.gt), o ciclo não. Um chain só não serve para as duas.
        from: (table: string) => {
            const terminal = table === 'seller_referrals' ? referralResult : cycleResult
            const chain: any = {
                select: () => chain,
                eq: () => chain,
                gt: () => chain,
                maybeSingle: () => terminal(),
            }
            return chain
        },
    },
}))

import { AffiliateCommissionService } from './affiliate-commission.service'

const SALE_AVAILABLE_AT = new Date('2026-09-19T12:00:00.000Z') // D+3 da venda
const NOW = Date.parse('2026-09-16T12:00:00.000Z')

function referral(overrides: Record<string, any> = {}) {
    return {
        data: {
            seller_id: 'sell_1',
            affiliate_seller_id: 'aff_1',
            affiliate_id: 'a1',
            affiliate_code: 'K7M2PQ4A',
            commission_rate_pct: 20,
            expires_at: '2027-09-16T00:00:00.000Z',
            ...overrides,
        },
    }
}

describe('AffiliateCommissionService.planFor', () => {
    let service: AffiliateCommissionService

    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(NOW)
        referralResult.mockReset()
        cycleResult.mockReset()
        // Sem linha de ciclo vale o padrão da plataforma.
        cycleResult.mockResolvedValue({ data: null })
        service = new AffiliateCommissionService()
    })

    afterEach(() => jest.useRealTimers())

    it('gives the affiliate its share of the platform fee', async () => {
        referralResult.mockResolvedValue(referral())

        const plan = await service.planFor('sell_1', 1000, SALE_AVAILABLE_AT)

        expect(plan).toMatchObject({ affiliateSellerId: 'aff_1', commissionCents: 200, ratePct: 20 })
    })

    it('never takes more than the fee — platform keeps the remainder', async () => {
        referralResult.mockResolvedValue(referral())

        const platformFeeCents = 999
        const plan = await service.planFor('sell_1', platformFeeCents, SALE_AVAILABLE_AT)

        expect(plan!.commissionCents + (platformFeeCents - plan!.commissionCents)).toBe(platformFeeCents)
        expect(plan!.commissionCents).toBeLessThan(platformFeeCents)
    })

    it('pays on the affiliate cycle date, not a rolling date', async () => {
        referralResult.mockResolvedValue(referral())

        const plan = await service.planFor('sell_1', 1000, SALE_AVAILABLE_AT)

        // Venda em 16/set com carência de 15 passa do dia 30 → ciclo de outubro.
        expect(plan!.availableAt.toISOString().slice(0, 10)).toBe('2026-10-30')
    })

    it('honours the cycle configured for the affiliate', async () => {
        referralResult.mockResolvedValue(referral())
        cycleResult.mockResolvedValue({ data: { payout_day: 10, hold_days: 5 } })

        const plan = await service.planFor('sell_1', 1000, SALE_AVAILABLE_AT)

        // 16/set + 5 = 21/set, já passou do dia 10 → 10/out.
        expect(plan!.availableAt.toISOString().slice(0, 10)).toBe('2026-10-10')
    })

    it('never pays before the sale itself settles', async () => {
        referralResult.mockResolvedValue(referral())

        // Venda com liberação longa (físico sem rastreio, por exemplo).
        const plan = await service.planFor('sell_1', 1000, new Date('2026-12-01T00:00:00.000Z'))

        expect(plan!.availableAt.toISOString().slice(0, 10)).toBe('2026-12-30')
    })

    it('skips a referral whose window has closed', async () => {
        // O filtro de expires_at é do banco; sem linha, não há comissão.
        referralResult.mockResolvedValue({ data: null })

        expect(await service.planFor('sell_1', 1000, SALE_AVAILABLE_AT)).toBeNull()
    })

    it('skips when the fee is too small to leave a cent', async () => {
        referralResult.mockResolvedValue(referral())

        // 20% de 4 centavos arredonda pra baixo: nada a creditar.
        expect(await service.planFor('sell_1', 4, SALE_AVAILABLE_AT)).toBeNull()
    })

    it('does not break the sale when the lookup fails', async () => {
        referralResult.mockRejectedValue(new Error('supabase down'))

        expect(await service.planFor('sell_1', 1000, SALE_AVAILABLE_AT)).toBeNull()
    })
})
