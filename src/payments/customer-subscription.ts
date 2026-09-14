// payments/customer-subscription.ts
//
// Assinatura vista pelo COMPRADOR (área do cliente, via checkout). A fonte é a
// membership na Whop, lida na hora: whop_subscriptions só espelha o que os
// webhooks membership.* trouxeram, e esses eventos podem nem estar assinados.
//
// Regras do produto:
//   • cancelar vale no fim do período pago — o comprador mantém o acesso até lá;
//   • dá para reativar enquanto o período não acabou;
//   • plano parcelado (split_pay_required_payments) é uma compra dividida, não
//     uma assinatura aberta: cancelamento só pelo suporte.

import type { WhopMembershipState } from '../orchestrator/providers/whop.provider'

const SUBSCRIPTION_PAYMENT_TYPES = new Set(['subscription', 'assinatura-recorrente'])

export type CustomerSubscriptionStatus =
    | 'active'
    | 'trialing'
    | 'canceling'
    | 'past_due'
    | 'completed'
    | 'ended'
    | 'unknown'

export interface CustomerSubscriptionView {
    status: CustomerSubscriptionStatus
    cancelAtPeriodEnd: boolean
    /** Fim do período pago (ISO): próxima cobrança, ou fim do acesso se cancelando. */
    currentPeriodEnd: string | null
    /** Número fixo de cobranças; null = assinatura aberta. */
    installments: number | null
    canCancel: boolean
    canReactivate: boolean
}

export function isSubscriptionTransaction(metadata: any): boolean {
    return SUBSCRIPTION_PAYMENT_TYPES.has(String(metadata?.payment_type ?? ''))
        || Boolean(metadata?.subscription_charge)
}

export function installmentsOf(metadata: any): number | null {
    const value = Number(metadata?.pricing_plan?.split_pay_required_payments)
    return Number.isInteger(value) && value > 0 ? value : null
}

function statusOf(membership: WhopMembershipState): CustomerSubscriptionStatus {
    switch (membership.status) {
        case 'active':
        case 'trialing':
            return membership.cancelAtPeriodEnd ? 'canceling' : membership.status
        case 'canceling':
            return 'canceling'
        case 'past_due':
        case 'unresolved':
            return 'past_due'
        case 'completed':
            return 'completed'
        case 'canceled':
        case 'expired':
        case 'drafted':
            return 'ended'
        default:
            // Status novo da Whop: neutro. 'ended' cortaria o acesso do comprador.
            return 'unknown'
    }
}

export function customerSubscriptionView(
    membership: WhopMembershipState,
    metadata: any,
    now = Date.now(),
): CustomerSubscriptionView {
    const status = statusOf(membership)
    const installments = installmentsOf(metadata)
    const periodEnd = membership.renewalPeriodEnd ? Date.parse(membership.renewalPeriodEnd) : NaN
    const periodOpen = !Number.isFinite(periodEnd) || periodEnd > now
    const openSubscription = installments === null

    return {
        status,
        cancelAtPeriodEnd: status === 'canceling',
        currentPeriodEnd: membership.renewalPeriodEnd,
        installments,
        canCancel: openSubscription && (status === 'active' || status === 'trialing' || status === 'past_due'),
        canReactivate: openSubscription && status === 'canceling' && periodOpen,
    }
}
