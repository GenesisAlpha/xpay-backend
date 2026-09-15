// ============================================================================
// LUCRO DA KOOPFY POR VENDA
// ----------------------------------------------------------------------------
// O custo do provider é calculado na venda pelo modelo fixo
// (fee.calculator#calculateProviderCost) e gravado em
// `transactions.fee_breakdown.provider_cost`. Aqui só se lê o que foi gravado:
// lucro da venda = (taxa da plataforma + câmbio) − custo do provider.
// ============================================================================

/** Custo do provider gravado na venda, em centavos de USD. Nulo em venda anterior ao modelo. */
export function providerCostCents(feeBreakdown: any): number | null {
  const total = feeBreakdown?.provider_cost?.total_cents;
  if (total === null || total === undefined || total === '') return null;
  const n = Number(total);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Receita da Koopfy na venda: taxa da plataforma + câmbio (o câmbio não entra em `transactions.fee`). */
export function koopfySaleRevenueCents(tx: { fee?: unknown; fee_breakdown?: any }): number {
  return Math.round(Number(tx.fee ?? 0)) + Math.round(Number(tx.fee_breakdown?.fx_fee_cents ?? 0));
}

/** Lucro da Koopfy na venda, em centavos de USD. Nulo quando a venda não tem custo do provider. */
export function saleProfitCents(tx: { fee?: unknown; fee_breakdown?: any }): number | null {
  const cost = providerCostCents(tx.fee_breakdown);
  return cost === null ? null : koopfySaleRevenueCents(tx) - cost;
}
