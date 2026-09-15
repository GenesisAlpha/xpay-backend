// webhooks/whop-renewal.ts
//
// Renovação de assinatura da Whop vira transação própria no pay — filha da
// compra original — com a taxa da Koopfy e o crédito do seller calculados como
// numa venda. Antes ela só ia para whop_subscriptions.metadata: o dinheiro
// entrava na conta Whop sem aparecer em saldo nenhum.
//
// Regras:
//  • só payment.succeeded com billing_reason subscription_cycle cria a filha;
//    failed/pending do ciclo não mexem na compra original (já aprovada);
//  • a primeira cobrança depois do teste grátis também chega como
//    subscription_cycle e conta como renovação;
//  • o valor é o do payment da Whop (moeda travada no plano), convertido para
//    USD com o câmbio do dia — nunca recalculado a partir do plano;
//  • idempotência pelo id do payment (pay_xxx), gravado em provider_transaction_id.

import { calculateSaleFees, DEFAULT_SELLER_FEES, type SellerFees } from '../shared/fee.calculator'

export const WHOP_RENEWAL_BILLING_REASON = 'subscription_cycle'

export function isWhopRenewalPayment(data: any): boolean {
  return data?.billing_reason === WHOP_RENEWAL_BILLING_REASON
}

export function whopPaymentId(data: any): string | null {
  const id = typeof data?.id === 'string' ? data.id.trim() : ''
  return id.startsWith('pay_') ? id : null
}

/** Valor cobrado, em centavos da moeda da cobrança (a Whop reporta em unidade principal). */
export function whopPaymentAmountMinor(data: any): number | null {
  for (const value of [data?.total, data?.final_amount, data?.amount, data?.subtotal]) {
    if (value === null || value === undefined || value === '') continue
    const amount = Number(value)
    if (Number.isFinite(amount) && amount > 0) return Math.round(amount * 100)
  }
  return null
}

// Contexto que é do PAGAMENTO, não da compra: não passa da original para a renovação.
const PER_PAYMENT_METADATA = ['whop_payment_id', 'whop_recovery_url', 'whop_dispute']

export function renewalMetadata(
  parentMetadata: Record<string, any> | null | undefined,
  renewal: { parentTransactionId: string; paymentId: string; membershipId: string | null; cycle: number },
): Record<string, any> {
  const metadata: Record<string, any> = { ...(parentMetadata ?? {}) }
  for (const key of PER_PAYMENT_METADATA) delete metadata[key]
  return {
    ...metadata,
    whop_payment_id: renewal.paymentId,
    ...(renewal.membershipId ? { whop_membership_id: renewal.membershipId } : {}),
    billing_reason: WHOP_RENEWAL_BILLING_REASON,
    renewal_of_transaction_id: renewal.parentTransactionId,
    renewal_cycle: renewal.cycle,
  }
}

export interface RenewalParentFees {
  method: string | null
  provider: string | null
  payment_brand: string | null
  net_amount: number | null
  external_fee_cents: number | null
  external_fee_pct: number | null
  external_fee_recipient_id: string | null
}

/**
 * Taxas da renovação — mesma conta de createPayment: taxas do seller sobre o
 * bruto em USD (conversão só fora do USD), reserva, e o external_fee (comissão
 * do parceiro) herdado da compra original. Percentual é reaplicado; valor fixo
 * acompanha a proporção do líquido, para a comissão não passar do que a
 * renovação rende.
 */
export function renewalEconomics(args: {
  grossUSDcents: number
  currencyConverted: boolean
  sellerFees: SellerFees | null
  parent: RenewalParentFees
}) {
  const { parent } = args
  const base = calculateSaleFees(args.grossUSDcents, args.sellerFees ?? DEFAULT_SELLER_FEES, {
    currencyConverted: args.currencyConverted,
  })
  const netUSDcents = base.grossCents - base.fxFeeCents
  const baseNetCents = base.netCents

  let externalFeeCents = 0
  if (parent.external_fee_recipient_id) {
    if (parent.external_fee_pct != null && parent.external_fee_pct > 0) {
      externalFeeCents = Math.floor(netUSDcents * Number(parent.external_fee_pct) / 100)
    } else if ((parent.external_fee_cents ?? 0) > 0 && (parent.net_amount ?? 0) > 0) {
      const parentBaseNet = Number(parent.net_amount) + Number(parent.external_fee_cents)
      externalFeeCents = Math.floor(Number(parent.external_fee_cents) * baseNetCents / parentBaseNet)
    }
  }
  // Nunca deixa o seller negativo: sem espaço, a comissão fica de fora (e é logada por quem chama).
  const externalFeeDropped = externalFeeCents > 0 && externalFeeCents >= baseNetCents
  if (externalFeeDropped) externalFeeCents = 0

  return {
    fee: base.platformFeeCents,
    chargeback_protection_fee: 0,
    reserve_amount: base.reserveCents,
    net_amount: baseNetCents - externalFeeCents,
    available_at: base.availableAt.toISOString(),
    reserve_until: base.reserveUntil.toISOString(),
    external_fee_cents: externalFeeCents > 0 ? externalFeeCents : null,
    external_fee_pct: externalFeeCents > 0 ? parent.external_fee_pct ?? null : null,
    external_fee_recipient_id: externalFeeCents > 0 ? parent.external_fee_recipient_id : null,
    externalFeeDropped,
    /** Não são colunas do insert: quem chama grava à parte. */
    breakdown: base.breakdown,
    usd: { grossCents: base.grossCents, fxFeeCents: base.fxFeeCents, netCents: netUSDcents },
  }
}
