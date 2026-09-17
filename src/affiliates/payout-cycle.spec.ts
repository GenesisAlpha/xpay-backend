import { nextPayoutDate, normalizeCycle, DEFAULT_PAYOUT_CYCLE } from './payout-cycle'

// O combinado: pagamento dia 30, carência 15 → o dia 30 cobre as vendas do
// dia 1 ao 15, e o que vier depois cai no ciclo seguinte.

const CYCLE = { payoutDay: 30, holdDays: 15 }
/** Liquidação da venda bem cedo, pra isolar o efeito do ciclo. */
const SETTLED_EARLY = new Date('2026-01-01T00:00:00.000Z')

const on = (iso: string) => new Date(iso)
const day = (d: Date) => d.toISOString().slice(0, 10)

describe('nextPayoutDate', () => {
    it('pays a sale from the first half in the same month', () => {
        expect(day(nextPayoutDate(on('2026-03-01T10:00:00Z'), SETTLED_EARLY, CYCLE))).toBe('2026-03-30')
        expect(day(nextPayoutDate(on('2026-03-15T10:00:00Z'), SETTLED_EARLY, CYCLE))).toBe('2026-03-30')
    })

    it('pushes a sale past the cutoff to the next cycle', () => {
        // Dia 16 + 15 de carência = dia 31, depois do pagamento do dia 30.
        expect(day(nextPayoutDate(on('2026-03-16T10:00:00Z'), SETTLED_EARLY, CYCLE))).toBe('2026-04-30')
        expect(day(nextPayoutDate(on('2026-03-31T10:00:00Z'), SETTLED_EARLY, CYCLE))).toBe('2026-04-30')
    })

    it('shortens the cycle day in a month that does not have it', () => {
        // Venda de 30/jan alcança fev; fevereiro de 2026 acaba no dia 28.
        expect(day(nextPayoutDate(on('2026-01-30T10:00:00Z'), SETTLED_EARLY, CYCLE))).toBe('2026-02-28')
    })

    it('never pays before the sale itself settles', () => {
        // Venda velha, mas liquidação longe (físico sem rastreio, por exemplo).
        const settlesLate = on('2026-06-20T00:00:00Z')
        expect(day(nextPayoutDate(on('2026-03-01T10:00:00Z'), settlesLate, CYCLE))).toBe('2026-06-30')
    })

    it('rolls into the next year when the sale lands in December', () => {
        expect(day(nextPayoutDate(on('2026-12-20T10:00:00Z'), SETTLED_EARLY, CYCLE))).toBe('2027-01-30')
    })

    it('honours a different cycle — day 10, hold 20', () => {
        const alt = { payoutDay: 10, holdDays: 20 }
        // 01/mar + 20 = 21/mar, já passou do dia 10 → 10/abr.
        expect(day(nextPayoutDate(on('2026-03-01T10:00:00Z'), SETTLED_EARLY, alt))).toBe('2026-04-10')
    })

    it('pays at midday UTC, away from the timezone edges', () => {
        expect(nextPayoutDate(on('2026-03-01T10:00:00Z'), SETTLED_EARLY, CYCLE).getUTCHours()).toBe(12)
    })
})

describe('normalizeCycle', () => {
    it('falls back to the default when the CRM sends garbage', () => {
        for (const bad of [null, undefined, {}, { payoutDay: 0 }, { payoutDay: 32 }, { payoutDay: 1.5 }]) {
            expect(normalizeCycle(bad as any).payoutDay).toBe(DEFAULT_PAYOUT_CYCLE.payoutDay)
        }
    })

    it('refuses a hold long enough to be a retention', () => {
        expect(normalizeCycle({ payoutDay: 5, holdDays: 200 }).holdDays).toBe(DEFAULT_PAYOUT_CYCLE.holdDays)
        expect(normalizeCycle({ payoutDay: 5, holdDays: -1 }).holdDays).toBe(DEFAULT_PAYOUT_CYCLE.holdDays)
    })

    it('keeps a valid cycle', () => {
        expect(normalizeCycle({ payoutDay: 10, holdDays: 20 })).toEqual({ payoutDay: 10, holdDays: 20 })
    })
})
