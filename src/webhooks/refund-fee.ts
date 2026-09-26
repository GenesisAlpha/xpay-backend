// webhooks/refund-fee.ts
//
// Estorno: o seller arca com o valor CHEIO da venda. A taxa da Koopfy não é
// reembolsável — o comprador recebe o bruto de volta da conta da Koopfy, então
// o seller devolve o que recebeu (crédito), perde a reserva e paga a taxa.
//
// Antes só o crédito era revertido e a taxa saía do caixa da Koopfy.

export interface RefundFeeInput {
  /** Bruto da venda em centavos de USD (transactions.amount_usd_gross_cents). */
  grossUsdCents: number | null | undefined
  /** Soma dos credit_pending do seller nesta venda (o que está sendo revertido). */
  creditedCents: number
  /** Reserva ainda presa (reserve_hold em hold) — cancelada, não volta ao seller. */
  reserveHeldCents: number
  /** Fallback sem bruto gravado: taxa da plataforma (transactions.fee). */
  feeCents?: number | null
  /** Fallback sem bruto gravado: comissão de parceiro (transactions.external_fee_cents). */
  externalFeeCents?: number | null
}

/**
 * Estorno que a própria Whop fez (alerta de chargeback com estorno automático,
 * decisão dela) cobra também a taxa de chargeback do seller. Reembolso pedido
 * do nosso lado (seller/CRM) marca a transação antes (refunded_by /
 * refund_requested_by) e não paga essa taxa — só o valor cheio.
 */
export function isWhopInitiatedRefund(tx: { provider?: string | null; metadata?: Record<string, any> | null }): boolean {
  if (String(tx?.provider ?? '').toLowerCase() !== 'whop') return false
  const metadata = tx?.metadata ?? {}
  return !metadata.refunded_by && !metadata.refund_requested_by
}

/** Centavos a debitar do seller além do crédito revertido. Nunca negativo. */
export function refundFeeCents(input: RefundFeeInput): number {
  const gross = Number(input.grossUsdCents)
  if (Number.isFinite(gross) && gross > 0) {
    return Math.max(0, Math.round(gross - input.creditedCents - input.reserveHeldCents))
  }
  const fallback = Number(input.feeCents ?? 0) + Number(input.externalFeeCents ?? 0)
  return Number.isFinite(fallback) ? Math.max(0, Math.round(fallback)) : 0
}
