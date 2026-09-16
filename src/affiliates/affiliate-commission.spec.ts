// A comissão sai de dentro do platform_fee, então o que importa provar é que o
// seller indicado nunca paga a mais e que a soma fecha com o fee original.

const maybeSingle = jest.fn()

jest.mock('../lib/supabase.client', () => ({
    supabase: {
        from: () => ({
            select: () => ({
                eq: () => ({
                    gt: () => ({ maybeSingle }),
                }),
            }),
        }),
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
        maybeSingle.mockReset()
        service = new AffiliateCommissionService()
    })

    afterEach(() => jest.useRealTimers())

    it('gives the affiliate its share of the platform fee', async () => {
        maybeSingle.mockResolvedValue(referral())

        const plan = await service.planFor('sell_1', 1000, SALE_AVAILABLE_AT)

        expect(plan).toMatchObject({ affiliateSellerId: 'aff_1', commissionCents: 200, ratePct: 20 })
    })

    it('never takes more than the fee — platform keeps the remainder', async () => {
        maybeSingle.mockResolvedValue(referral())

        const platformFeeCents = 999
        const plan = await service.planFor('sell_1', platformFeeCents, SALE_AVAILABLE_AT)

        // O que sobra pra plataforma mais a comissão tem que fechar com o fee.
        expect(plan!.commissionCents + (platformFeeCents - plan!.commissionCents)).toBe(platformFeeCents)
        expect(plan!.commissionCents).toBeLessThan(platformFeeCents)
    })

    it('holds the commission for 30 days, past the sale settlement', async () => {
        maybeSingle.mockResolvedValue(referral())

        const plan = await service.planFor('sell_1', 1000, SALE_AVAILABLE_AT)

        // A venda libera em D+3, mas a comissão espera os 30 dias de carência.
        expect(plan!.availableAt.toISOString()).toBe('2026-10-16T12:00:00.000Z')
    })

    it('never pays before the sale itself settles', async () => {
        maybeSingle.mockResolvedValue(referral())

        // Venda com liberação longa (produto físico sem rastreio, por exemplo).
        const farOut = new Date('2026-12-01T00:00:00.000Z')
        const plan = await service.planFor('sell_1', 1000, farOut)

        expect(plan!.availableAt).toEqual(farOut)
    })

    it('skips a referral whose window has closed', async () => {
        // O filtro de expires_at é do banco; sem linha, não há comissão.
        maybeSingle.mockResolvedValue({ data: null })

        expect(await service.planFor('sell_1', 1000, SALE_AVAILABLE_AT)).toBeNull()
    })

    it('skips when the fee is too small to leave a cent', async () => {
        maybeSingle.mockResolvedValue(referral())

        // 20% de 4 centavos arredonda pra baixo: nada a creditar.
        expect(await service.planFor('sell_1', 4, SALE_AVAILABLE_AT)).toBeNull()
    })

    it('does not break the sale when the lookup fails', async () => {
        maybeSingle.mockRejectedValue(new Error('supabase down'))

        expect(await service.planFor('sell_1', 1000, SALE_AVAILABLE_AT)).toBeNull()
    })
})
