/**
 * Valores em dólar da venda pela Kontino a partir da liquidação real
 * (settlement: gross/fee/net em centavos de USD). Líquido para o seller =
 * net da BlindPay menos a taxa da venda (application fee). Sem liquidação,
 * não mexe em nada.
 */
export function valoresDaLiquidacaoKontino(
  settlement: { gross?: number | null; net?: number | null } | null | undefined,
  amountMinor: number | null | undefined,
  taxaUsdCents: number,
): Record<string, number> {
  const gross = Number(settlement?.gross)
  const net = Number(settlement?.net)
  if (!Number.isFinite(gross) || gross <= 0 || !Number.isFinite(net)) return {}
  const amount = Number(amountMinor)
  return {
    amount_usd_gross_cents: Math.round(gross),
    amount_usd_net_cents: Math.max(0, Math.round(net - (Number.isFinite(taxaUsdCents) ? taxaUsdCents : 0))),
    fx_fee_cents: 0,
    ...(Number.isFinite(amount) && amount > 0 ? { fx_rate: gross / amount } : {}),
  }
}
