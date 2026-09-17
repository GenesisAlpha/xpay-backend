// A ativação envolve dois bancos: o código nasce no checkout e o espelho fica
// aqui. O que precisa estar certo é a ordem — nada gravado aqui quando o
// checkout falha — e que o link devolvido é o que o checkout gerou.

const checkoutInternal = jest.fn()
const writes: Array<{ table: string; op: string; payload?: any }> = []
const tableData: Record<string, any> = {}

jest.mock('../crm/checkout-internal', () => ({
    checkoutInternal: (...args: any[]) => checkoutInternal(...args),
    checkoutFailureMessage: (acao: string) => `Não foi possível ${acao}: checkout fora`,
}))

jest.mock('../lib/supabase.client', () => ({
    supabase: {
        from: (table: string) => {
            const chain: any = {
                select: () => chain,
                eq: () => chain,
                in: () => chain,
                gt: () => chain,
                order: () => chain,
                limit: () => chain,
                maybeSingle: async () => ({ data: tableData[table] ?? null }),
                upsert: async (payload: any) => { writes.push({ table, op: 'upsert', payload }); return { error: null } },
                update: (payload: any) => { writes.push({ table, op: 'update', payload }); return chain },
                insert: (payload: any) => { writes.push({ table, op: 'insert', payload }); return Promise.resolve({ error: null }) },
                then: (resolve: any) => resolve({ data: [], error: null }),
            }
            return chain
        },
    },
}))

import { AffiliateCrmService } from './affiliate-crm.service'

const ctx = { managerId: 'mgr_1' }

describe('AffiliateCrmService', () => {
    let service: AffiliateCrmService

    beforeEach(() => {
        checkoutInternal.mockReset()
        writes.length = 0
        tableData.seller_profiles = { id: 'sell_1', user_id: 'u_1', name: 'Loja do Marcos' }
        tableData.users = { email: 'marcos@loja.com' }
        service = new AffiliateCrmService()
    })

    it('activates in the checkout and mirrors the link it generated', async () => {
        checkoutInternal.mockResolvedValue({
            affiliate: { sellerId: 'sell_1', id: 'a1', code: 'K7M2PQ4A', status: 'active', commissionRatePct: 20, link: 'https://koopfy.com/?ref=K7M2PQ4A' },
        })

        const result = await service.activate(ctx, 'sell_1')

        expect(checkoutInternal).toHaveBeenCalledWith('affiliates/activate', expect.objectContaining({
            sellerId: 'sell_1', email: 'marcos@loja.com',
        }))
        expect(result.link).toBe('https://koopfy.com/?ref=K7M2PQ4A')
        const mirror = writes.find(w => w.table === 'affiliate_accounts' && w.op === 'upsert')
        expect(mirror?.payload).toMatchObject({ seller_id: 'sell_1', code: 'K7M2PQ4A', status: 'active', activated_by: 'mgr_1' })
    })

    it('writes nothing here when the checkout is down', async () => {
        checkoutInternal.mockResolvedValue(null)

        await expect(service.activate(ctx, 'sell_1')).rejects.toThrow(/checkout/)
        expect(writes.filter(w => w.table === 'affiliate_accounts')).toHaveLength(0)
    })

    it('refuses an out-of-range rate before calling anyone', async () => {
        await expect(service.activate(ctx, 'sell_1', { ratePct: 150 })).rejects.toThrow(/alíquota/)
        expect(checkoutInternal).not.toHaveBeenCalled()
    })

    it('does not touch referrals when the rate cannot reach the checkout', async () => {
        checkoutInternal.mockResolvedValue(null)

        await expect(service.setRate(ctx, 'sell_1', 25)).rejects.toThrow(/checkout/)
        expect(writes.filter(w => w.table === 'seller_referrals')).toHaveLength(0)
    })

    it('keeps referrals earning on a plain deactivation', async () => {
        checkoutInternal.mockResolvedValue({ affiliate: { sellerId: 'sell_1', status: 'inactive' } })

        const result = await service.deactivate(ctx, 'sell_1')

        expect(checkoutInternal).toHaveBeenCalledWith('affiliates/update', { sellerId: 'sell_1', status: 'inactive' })
        expect(result.referralsClosed).toBe(false)
        // Sem closeReferrals a janela dos indicados não é tocada.
        expect(writes.filter(w => w.table === 'seller_referrals')).toHaveLength(0)
    })

    it('closes the referral windows when asked', async () => {
        checkoutInternal.mockResolvedValue({ affiliate: { sellerId: 'sell_1', status: 'inactive' } })

        await service.deactivate(ctx, 'sell_1', { closeReferrals: true, reason: 'fraude' })

        const closed = writes.find(w => w.table === 'seller_referrals' && w.op === 'update')
        expect(closed?.payload).toHaveProperty('expires_at')
    })
})
