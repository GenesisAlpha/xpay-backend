// ============================================================================
// PROVEDOR POR MÉTODO — a plataforma decide quem cobra cada método
// ----------------------------------------------------------------------------
// Antes: o CRM escolhia UM provedor por seller (`sellers.provider_default`) e a
// cadeia de failover por método era fixa no código (failover.config.ts).
// Agora: a política é da plataforma e é por MÉTODO — "Pix e SPEI no Kontino,
// cartão na Kaja Payments" — editável no CRM, com:
//
//   • cadeia ordenada por regra (primário + reservas) — o failover já existente
//     percorre a cadeia, até FAILOVER_MAX_HOPS;
//   • regra por país e/ou moeda do comprador (a mais específica vence);
//   • exceção por seller (vence tudo; ex.: isolar um seller num provedor);
//   • provedor indisponível (sem credencial, sem conta ativa, em espera) sai da
//     cadeia na hora de cobrar, e o motivo fica no log e no CRM.
//
// Sem regra para o método, vale o comportamento antigo (provider_default do
// seller + FAILOVER_CHAIN) — a migração é gradual e nada para de cobrar.
//
// Regra pura: sem banco, sem Nest. O serviço carrega as regras e a
// disponibilidade e chama `resolveMethodRoute`.
// ============================================================================

export type RoutedProvider =
  | 'kontino' | 'kaja' | 'stripe' | 'whop' | 'clip' | 'approvebly' | 'setinel_gate'
  | 'rox_pay' | 'coinflow' | 'paypal' | 'slash'

export type PaymentMethodKey =
  | 'card' | 'apple_pay' | 'google_pay' | 'pix' | 'spei' | 'boleto' | 'mbway' | 'crypto' | 'paypal' | 'link'

/** Catálogo exibido no CRM: o que cada método aceita e o rótulo. */
export const METHOD_CATALOG: Record<PaymentMethodKey, { label: string; providers: RoutedProvider[] }> = {
  card:       { label: 'Cartão',     providers: ['kaja', 'stripe', 'whop', 'clip', 'rox_pay', 'setinel_gate', 'approvebly', 'slash'] },
  apple_pay:  { label: 'Apple Pay',  providers: ['kaja', 'stripe', 'whop', 'setinel_gate'] },
  google_pay: { label: 'Google Pay', providers: ['kaja', 'stripe', 'whop', 'setinel_gate'] },
  pix:        { label: 'Pix',        providers: ['kontino', 'approvebly', 'whop'] },
  spei:       { label: 'SPEI',       providers: ['kontino', 'clip'] },
  boleto:     { label: 'Boleto',     providers: ['approvebly'] },
  mbway:      { label: 'MB WAY',     providers: ['setinel_gate'] },
  crypto:     { label: 'Cripto',     providers: ['coinflow', 'whop'] },
  paypal:     { label: 'PayPal',     providers: ['paypal'] },
  link:       { label: 'Link',       providers: ['stripe'] },
}

export const PROVIDER_LABEL: Record<RoutedProvider, string> = {
  kontino: 'Kontino', kaja: 'Kaja Payments', stripe: 'Stripe', whop: 'Whop', clip: 'Clip',
  approvebly: 'Approvebly', setinel_gate: 'Sentinel Gate', rox_pay: 'Rox Pay', coinflow: 'Coinflow',
  paypal: 'PayPal', slash: 'Slash',
}

/**
 * Provedores que não usam o pool de contas do router: cobram por API própria,
 * antes do failover (Kontino: cobrança Connect; Clip SPEI: reserva de CLABE).
 */
export const DIRECT_PROVIDERS: ReadonlySet<RoutedProvider> = new Set(['kontino'])

export type MethodRouteRule = {
  id: string
  method: string
  /** ISO-2 do comprador; null = qualquer país. */
  country: string | null
  /** ISO-4217; null = qualquer moeda. */
  currency: string | null
  /** Exceção de um seller; null = regra da plataforma. */
  seller_id: string | null
  /** Ordem: primário primeiro, depois as reservas. */
  providers: string[]
  enabled: boolean
}

export type ProviderAvailability = Partial<Record<string, { available: boolean; reason?: string | null }>>

export type MethodRoute = {
  /** Regra aplicada (null = sem regra: comportamento antigo). */
  ruleId: string | null
  scope: 'seller' | 'country_currency' | 'country' | 'currency' | 'method' | 'legacy'
  /** Cadeia configurada, na ordem. */
  configured: RoutedProvider[]
  /** Cadeia que de fato será tentada (só os disponíveis). */
  chain: RoutedProvider[]
  /** Provedores pulados e por quê. */
  skipped: Array<{ provider: string; reason: string }>
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()
const upper = (v: unknown) => String(v ?? '').trim().toUpperCase()

export function normalizeMethod(method: unknown): string {
  const m = norm(method)
  if (m === 'credit_card' || m === 'debit_card' || m === 'cartao') return 'card'
  if (m === 'applepay') return 'apple_pay'
  if (m === 'googlepay') return 'google_pay'
  return m
}

/** Especificidade: seller > país+moeda > país > moeda > só o método. */
function score(rule: MethodRouteRule): number {
  return (rule.seller_id ? 8 : 0) + (rule.country ? 2 : 0) + (rule.currency ? 1 : 0) + (rule.country && rule.currency ? 1 : 0)
}

function scopeOf(rule: MethodRouteRule): MethodRoute['scope'] {
  if (rule.seller_id) return 'seller'
  if (rule.country && rule.currency) return 'country_currency'
  if (rule.country) return 'country'
  if (rule.currency) return 'currency'
  return 'method'
}

export function pickRule(
  rules: MethodRouteRule[],
  ctx: { method: string; country?: string | null; currency?: string | null; sellerId?: string | null },
): MethodRouteRule | null {
  const method = normalizeMethod(ctx.method)
  const country = upper(ctx.country)
  const currency = upper(ctx.currency)
  const candidates = rules.filter(r =>
    r.enabled
    && normalizeMethod(r.method) === method
    && (!r.seller_id || r.seller_id === ctx.sellerId)
    && (!r.country || upper(r.country) === country)
    && (!r.currency || upper(r.currency) === currency)
    && Array.isArray(r.providers) && r.providers.length > 0,
  )
  if (!candidates.length) return null
  return candidates.sort((a, b) => score(b) - score(a))[0]
}

export function resolveMethodRoute(
  rules: MethodRouteRule[],
  availability: ProviderAvailability,
  ctx: { method: string; country?: string | null; currency?: string | null; sellerId?: string | null },
): MethodRoute {
  const rule = pickRule(rules, ctx)
  if (!rule) return { ruleId: null, scope: 'legacy', configured: [], chain: [], skipped: [] }

  const seen = new Set<string>()
  const configured = rule.providers.map(norm).filter(p => p && !seen.has(p) && seen.add(p)) as RoutedProvider[]
  const skipped: MethodRoute['skipped'] = []
  const chain: RoutedProvider[] = []
  for (const p of configured) {
    const a = availability[p]
    if (a && a.available === false) skipped.push({ provider: p, reason: a.reason ?? 'indisponível' })
    else chain.push(p)
  }
  return { ruleId: rule.id, scope: scopeOf(rule), configured, chain, skipped }
}

/**
 * Validação de uma regra antes de gravar. Devolve o primeiro problema, ou null.
 * O CRM mostra a mensagem como veio.
 */
export function validateRule(input: {
  method?: unknown; country?: unknown; currency?: unknown; providers?: unknown
}): string | null {
  const method = normalizeMethod(input.method) as PaymentMethodKey
  if (!METHOD_CATALOG[method]) return 'Método desconhecido.'
  if (input.country != null && input.country !== '' && !/^[A-Za-z]{2}$/.test(String(input.country))) return 'País deve ser ISO de 2 letras (ex.: BR).'
  if (input.currency != null && input.currency !== '' && !/^[A-Za-z]{3}$/.test(String(input.currency))) return 'Moeda deve ser ISO de 3 letras (ex.: BRL).'
  if (!Array.isArray(input.providers) || input.providers.length === 0) return 'Escolha ao menos um provedor.'
  if (input.providers.length > 5) return 'No máximo 5 provedores por regra.'
  const allowed = new Set<string>(METHOD_CATALOG[method].providers)
  const list = input.providers.map(norm)
  if (new Set(list).size !== list.length) return 'Provedor repetido na cadeia.'
  const wrong = list.find(p => !allowed.has(p))
  if (wrong) return `${PROVIDER_LABEL[wrong as RoutedProvider] ?? wrong} não atende ${METHOD_CATALOG[method].label}.`
  // Kontino cobra por trilho local com moeda fixa (SPEI só MXN, Pix só BRL).
  if (list.includes('kontino') && input.currency) {
    const fixed = method === 'pix' ? 'BRL' : method === 'spei' ? 'MXN' : null
    if (fixed && upper(input.currency) !== fixed) return `Kontino cobra ${METHOD_CATALOG[method].label} só em ${fixed}.`
  }
  return null
}
