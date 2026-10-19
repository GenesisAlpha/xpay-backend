// Nomes do cadastro (seller_profiles.enabled_methods, seller_kpis.method) →
// ids do catálogo de métodos que o painel mostra. O cadastro guarda
// 'credit_card'; o catálogo chama de 'card'. Sem traduzir, o cartão aparecia
// "pendente" para todo seller que não fosse Whop, o dash travava o toggle
// desligado e, ao salvar Pagamentos, o cartão saía do checkout.
const CATALOG_ALIASES: Record<string, string> = {
  credit_card: 'card',
  debit_card: 'card',
  mbway: 'mb_way',
  sepa: 'sepa_debit',
}

export function catalogMethodId(method: unknown): string {
  const id = String(method ?? '').trim().toLowerCase()
  return CATALOG_ALIASES[id] ?? id
}

// O que a Stripe/Whop própria do seller cobre no checkout embedado.
const OWN_CARD_METHODS = ['card', 'apple_pay', 'google_pay']

/**
 * Métodos liberados no catálogo. Com conta própria de cartão (Stripe ou Whop
 * dele), cartão e wallets saem por ela mesmo sem aprovação na Koopfy.
 */
export function catalogEnabledMethods(params: {
  enabledMethods: unknown[] | null | undefined
  ownCardAccount: boolean
}): Set<string> {
  const enabled = new Set((params.enabledMethods ?? []).map(catalogMethodId).filter(Boolean))
  if (params.ownCardAccount) for (const method of OWN_CARD_METHODS) enabled.add(method)
  return enabled
}
