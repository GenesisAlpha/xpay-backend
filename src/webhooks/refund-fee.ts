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

/** Centavos a debitar do seller além do crédito revertido. Nunca negativo. */
export function refundFeeCents(input: RefundFeeInput): number {
  const gross = Number(input.grossUsdCents)
  if (Number.isFinite(gross) && gross > 0) {
    return Math.max(0, Math.round(gross - input.creditedCents - input.reserveHeldCents))
  }
  const fallback = Number(input.feeCents ?? 0) + Number(input.externalFeeCents ?? 0)
  return Number.isFinite(fallback) ? Math.max(0, Math.round(fallback)) : 0
}
