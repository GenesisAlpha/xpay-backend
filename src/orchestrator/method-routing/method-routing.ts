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
  | 'card' | 'apple_pay' | 'google_pay' | 'pix' | 'spei' | 'transfers_ar' | 'pse'

/**
 * Catálogo exibido no Admin: o que cada método aceita e o rótulo. A Koopfy
 * orquestra Kaja Payments (cartão e carteiras), Clip (só cartão, no México) e
 * Kontino (trilhos locais, na conta conectada do seller).
 */
export const METHOD_CATALOG: Record<PaymentMethodKey, { label: string; providers: RoutedProvider[] }> = {
  card:         { label: 'Cartão',             providers: ['kaja', 'clip'] },
  apple_pay:    { label: 'Apple Pay',          providers: ['kaja'] },
  google_pay:   { label: 'Google Pay',         providers: ['kaja'] },
  pix:          { label: 'Pix',                providers: ['kontino'] },
  spei:         { label: 'SPEI',               providers: ['kontino'] },
  transfers_ar: { label: 'Transferencias 3.0', providers: ['kontino'] },
  pse:          { label: 'PSE',                providers: ['kontino'] },
}

/** Provedores em operação. Os demais ficam só para ler o histórico. */
export const ACTIVE_PROVIDERS: ReadonlySet<RoutedProvider> = new Set(['kaja', 'kontino', 'clip'])

/** País das contas Clip: fora dele a Clip não entra em nenhuma regra. */
export const CLIP_COUNTRY = 'MX'

/** Moeda fixa de cada trilho da Kontino. */
export const KONTINO_CURRENCY: Partial<Record<PaymentMethodKey, string>> = {
  pix: 'BRL', spei: 'MXN', transfers_ar: 'ARS', pse: 'COP',
}

export const PROVIDER_LABEL: Record<RoutedProvider, string> = {
  kontino: 'Kontino', kaja: 'Kaja Payments', stripe: 'Stripe', whop: 'Whop', clip: 'Clip',
  approvebly: 'Approvebly', setinel_gate: 'Sentinel Gate', rox_pay: 'Rox Pay', coinflow: 'Coinflow',
  paypal: 'PayPal', slash: 'Slash',
}

/**
 * Provedores que não usam o pool de contas do router: cobram por API própria,
 * antes do failover (Kontino: cobrança Connect).
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
  // Kontino cobra por trilho local com moeda fixa (Pix BRL, SPEI MXN, Transferencias ARS, PSE COP).
  if (list.includes('kontino') && input.currency) {
    const fixed = KONTINO_CURRENCY[method] ?? null
    if (fixed && upper(input.currency) !== fixed) return `Kontino cobra ${METHOD_CATALOG[method].label} só em ${fixed}.`
  }
  // A conta Clip é mexicana e cobra em peso. O checkout ainda não sabe a moeda
  // final ao escolher o formulário (para a Clip ela vira MXN), então a regra é
  // pelo país, com a moeda em branco.
  if (list.includes('clip')) {
    if (upper(input.country) !== CLIP_COUNTRY) return 'A Clip atende só o México: use o país MX nesta regra.'
    if (input.currency) return 'Deixe a moeda em branco: a Clip sempre cobra em MXN.'
  }
  return null
}

/**
 * Cartão na Clip só cobra com a reserva feita antes do formulário: o token do
 * cartão nasce preso à conta reservada. Com reserva, a cobrança é da Clip mesmo
 * que o endereço digitado tire o comprador da regra. Sem reserva, o formulário
 * foi de outro provedor e a Clip sai da cadeia.
 */
export function rotaDoCartaoClip(
  route: MethodRoute | null,
  ctx: { method: unknown; temReserva: boolean; provedorPadrao?: string | null },
): MethodRoute | null {
  if (!route || normalizeMethod(ctx.method) !== 'card') return route
  if (ctx.temReserva) {
    if (!route.ruleId && ctx.provedorPadrao === 'clip') return route
    return { ...route, ruleId: route.ruleId ?? 'reserva_clip', configured: ['clip'], chain: ['clip'], skipped: [] }
  }
  if (!route.chain.includes('clip')) return route
  const skipped = [...route.skipped, { provider: 'clip', reason: 'Sem reserva de cartão' }]
  const chain = route.chain.filter(p => p !== 'clip')
  return chain.length
    ? { ...route, chain, skipped }
    : { ruleId: null, scope: 'legacy', configured: [], chain: [], skipped }
}

/**
 * Métodos do checkout quando o cartão é da Clip: ela só atende cartão. SPEI e
 * os outros trilhos locais ficam só para quem tem conta Kontino, que é quem os
 * cobra.
 */
export function metodosComClip(metodos: string[], temContaKontino: boolean): string[] {
  return metodos.filter(m => {
    const key = normalizeMethod(m)
    return key === 'card' || (temContaKontino && key in KONTINO_CURRENCY)
  })
}
