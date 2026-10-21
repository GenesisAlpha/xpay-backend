// Origem da taxa de checkout (sem banco: os módulos puros importam daqui).

/**
 * Quem gravou a taxa de checkout por último (migration 20261020180000):
 *   'plan'   o checkout, com o padrão do plano da conta;
 *   'crm'    a equipe, no campo "Checkout (%)";
 *   'legacy' antes da taxa única: cada formato segue cobrando o que cobrava.
 */
export type CheckoutFeeSource = 'legacy' | 'plan' | 'crm'

/** Taxa de checkout do plano gratuito: o padrão de quem entra a partir de 2026-10-20. */
export const PLAN_FREE_CHECKOUT_FEE_PCT = 2.5

/** A taxa de checkout vale para TODA venda (fonte única)? Só depois do plano ou do CRM. */
export function checkoutFeeIsUnified(fees: { checkoutFeeSource: CheckoutFeeSource } | null | undefined): boolean {
  return fees?.checkoutFeeSource === 'plan' || fees?.checkoutFeeSource === 'crm'
}

export function normalizeCheckoutFeeSource(raw: unknown): CheckoutFeeSource {
  return raw === 'plan' || raw === 'crm' ? raw : 'legacy'
}
