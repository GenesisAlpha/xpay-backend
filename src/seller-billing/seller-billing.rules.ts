// Regras puras da cobrança de comissões no cartão do seller (sem I/O), para
// poderem ser testadas sem Whop e sem banco.

/** Metadata que marca uma cobrança/sessão como da Koopfy cobrando o SELLER. */
export const BILLING_METADATA_KEY = 'koopfy_billing'

export type BillingChargeStatus = 'pending' | 'paid' | 'failed'

/**
 * Estado de um pagamento da Whop (resposta do POST/GET /payments) na nossa
 * régua. A resposta do POST não é o resultado final: sem `paid` nem falha
 * explícita, continua pendente até o webhook ou a próxima consulta.
 */
export function billingStatusFromWhopPayment(payment: any): BillingChargeStatus {
  const status = String(payment?.status ?? '').toLowerCase()
  const substatus = String(payment?.substatus ?? '').toLowerCase()
  if (substatus === 'failed' || ['uncollectible', 'void', 'failed'].includes(status)) return 'failed'
  if (status === 'paid' || substatus === 'succeeded') return 'paid'
  return 'pending'
}

export function whopFailureMessage(payment: any): string | null {
  const message = payment?.failure_message ?? payment?.error?.message ?? null
  if (message) return String(message).slice(0, 500)
  if (payment?.decline_code) return `Cartão recusado (${payment.decline_code})`
  return null
}

/**
 * `initial_price` da Whop é em unidade principal (9.99), não em centavos.
 * Moedas sem casas decimais (JPY, CLP…) também existem na Whop; para elas o
 * valor em centavos do checkout já é a unidade.
 */
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'clp', 'vnd', 'isk', 'huf', 'twd', 'ugx', 'pyg', 'xaf', 'xof'])
export function toWhopPrice(amountMinor: number, currency: string): number {
  const cur = String(currency).toLowerCase()
  return ZERO_DECIMAL.has(cur) ? Math.round(amountMinor) : Math.round(amountMinor) / 100
}

/** Cartão salvo, na forma que o painel mostra. */
export interface SavedCard {
  memberId: string
  paymentMethodId: string
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
}

/**
 * Do setup intent da Whop, o que interessa. Só vale `succeeded` — os outros
 * estados (processing, requires_action, canceled) ainda não deixam cobrar.
 */
export function savedCardFromSetupIntent(intent: any): SavedCard | null {
  if (String(intent?.status ?? '').toLowerCase() !== 'succeeded') return null
  const pm = intent?.payment_method ?? null
  const memberId = intent?.member?.id ?? intent?.member_id ?? null
  const paymentMethodId = pm?.id ?? intent?.payment_method_id ?? null
  if (!memberId || !paymentMethodId) return null
  const card = pm?.card ?? pm?.payment_instrument ?? pm ?? {}
  const num = (value: unknown) => (Number.isFinite(Number(value)) && value != null ? Number(value) : null)
  return {
    memberId: String(memberId),
    paymentMethodId: String(paymentMethodId),
    brand: card?.brand ?? card?.card_brand ?? null,
    last4: card?.last4 ?? card?.last_four ?? null,
    expMonth: num(card?.exp_month),
    expYear: num(card?.exp_year),
  }
}

/** O setup intent pertence à sessão que abrimos para este workspace? */
export function setupIntentMatches(intent: any, sessionId: string, workspaceId: string): boolean {
  const configId = intent?.checkout_configuration?.id ?? intent?.checkout_configuration_id ?? null
  if (configId && configId === sessionId) return true
  const metadata = intent?.metadata ?? {}
  return metadata?.[BILLING_METADATA_KEY] === 'setup' && metadata?.koopfy_workspace_id === workspaceId
}
