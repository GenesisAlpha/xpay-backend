import { customerSubscriptionView, installmentsOf, isSubscriptionTransaction } from './customer-subscription'

// O comprador cancela no fim do período pago, reativa até lá, e plano parcelado
// só sai pelo suporte.

const NOW = Date.parse('2026-09-14T12:00:00.000Z')
const PERIOD_END = '2026-10-14T12:00:00.000Z'
const SUBSCRIPTION = { payment_type: 'subscription' }
const INSTALLMENTS = { payment_type: 'subscription', pricing_plan: { split_pay_required_payments: 3 } }

function membership(overrides: Record<string, any> = {}) {
    return { id: 'mem_1', status: 'active', cancelAtPeriodEnd: false, renewalPeriodEnd: PERIOD_END, ...overrides }
}

describe('customerSubscriptionView', () => {
    it('lets the buyer cancel an open subscription', () => {
        expect(customerSubscriptionView(membership(), SUBSCRIPTION, NOW)).toEqual({
            status: 'active',
            cancelAtPeriodEnd: false,
            currentPeriodEnd: PERIOD_END,
            installments: null,
            canCancel: true,
            canReactivate: false,
        })
    })

    it('shows a scheduled cancellation as reactivatable until the period ends', () => {
        for (const m of [membership({ cancelAtPeriodEnd: true }), membership({ status: 'canceling' })]) {
            expect(customerSubscriptionView(m, SUBSCRIPTION, NOW)).toMatchObject({
                status: 'canceling', cancelAtPeriodEnd: true, canCancel: false, canReactivate: true,
            })
        }
        const afterPeriod = Date.parse(PERIOD_END) + 1
        expect(customerSubscriptionView(membership({ cancelAtPeriodEnd: true }), SUBSCRIPTION, afterPeriod))
            .toMatchObject({ canReactivate: false })
    })

    it('never lets the buyer cancel or reactivate an installment plan', () => {
        expect(customerSubscriptionView(membership(), INSTALLMENTS, NOW))
            .toMatchObject({ installments: 3, canCancel: false, canReactivate: false })
        expect(customerSubscriptionView(membership({ cancelAtPeriodEnd: true }), INSTALLMENTS, NOW))
            .toMatchObject({ canReactivate: false })
    })

    it('maps the Whop lifecycle', () => {
        const statusOf = (status: string) => customerSubscriptionView(membership({ status }), SUBSCRIPTION, NOW).status
        expect(statusOf('trialing')).toBe('trialing')
        expect(statusOf('past_due')).toBe('past_due')
        expect(statusOf('unresolved')).toBe('past_due')
        expect(statusOf('completed')).toBe('completed')
        expect(statusOf('canceled')).toBe('ended')
        expect(statusOf('expired')).toBe('ended')
        // Status desconhecido não pode virar "encerrada": o checkout cortaria o acesso.
        expect(statusOf('something_new')).toBe('unknown')
        expect(customerSubscriptionView(membership({ status: 'canceled' }), SUBSCRIPTION, NOW))
            .toMatchObject({ canCancel: false, canReactivate: false })
    })
})

describe('subscription markers on the transaction', () => {
    it('recognises subscription purchases', () => {
        expect(isSubscriptionTransaction({ payment_type: 'subscription' })).toBe(true)
        expect(isSubscriptionTransaction({ payment_type: 'assinatura-recorrente' })).toBe(true)
        expect(isSubscriptionTransaction({ subscription_charge: { first_charge: 10 } })).toBe(true)
        expect(isSubscriptionTransaction({ payment_type: 'pagamento-unico', subscription_config: null })).toBe(false)
        expect(isSubscriptionTransaction(null)).toBe(false)
    })

    it('reads the fixed number of payments', () => {
        expect(installmentsOf(INSTALLMENTS)).toBe(3)
        expect(installmentsOf({ pricing_plan: { split_pay_required_payments: null } })).toBeNull()
        expect(installmentsOf({ pricing_plan: {} })).toBeNull()
        expect(installmentsOf({})).toBeNull()
    })
})
