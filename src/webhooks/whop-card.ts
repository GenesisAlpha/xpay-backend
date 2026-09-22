// Bandeira e final do cartão de um pagamento da Whop.
//
// Com a Whop, o número do cartão é digitado no componente DELA: o checkout
// nunca vê o cartão e grava a bandeira como 'unknown'. Quem sabe a bandeira é o
// processador — a Whop devolve no pagamento (card_brand / card_last4, e também
// em payment_method.card). É daqui que o pedido passa a ter Visa, Mastercard…
//
// https://docs.whop.com/api-reference/payments/retrieve-payment

export interface WhopCard {
  brand: string | null
  last4: string | null
  /** payment_method_type da Whop: card, apple_pay, google_pay, cashapp… */
  methodType: string | null
}

const BRAND_ALIAS: Record<string, string> = {
  master: 'mastercard',
  american_express: 'amex',
  americanexpress: 'amex',
  'american express': 'amex',
  diners_club: 'diners',
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function whopCardOf(payment: any): WhopCard {
  if (!payment || typeof payment !== 'object') return { brand: null, last4: null, methodType: null }
  const card = payment.payment_method?.card ?? payment.payment_instrument?.card ?? {}

  const rawBrand = (text(payment.card_brand) ?? text(card.brand) ?? '').toLowerCase().replace(/\s+/g, ' ')
  const brand = rawBrand && rawBrand !== 'unknown' ? (BRAND_ALIAS[rawBrand] ?? rawBrand.replace(/ /g, '_')) : null

  const digits = (text(payment.card_last4) ?? text(card.last4) ?? '').replace(/\D/g, '')
  const last4 = digits.length >= 4 ? digits.slice(-4) : null

  const methodType = (text(payment.payment_method_type) ?? text(payment.payment_method?.payment_method_type) ?? '').toLowerCase() || null

  return { brand, last4, methodType }
}
