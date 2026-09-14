// shared/fee.calculator.ts
// Calcula taxas, reservas e liquidação para uma transação
// baseado nas seller_fees do seller.

import { supabase } from '../lib/supabase.client'

// ─── Constantes ───────────────────────────────────────────────────────────────

// Taxa adicional cobrada quando o método de pagamento é Klarna
const KLARNA_EXTRA_FEE_PCT = 5

// Surcharges adicionais (somam ao fee da plataforma)
const AMEX_DINERS_SURCHARGE_PCT = 2   // cartões Amex / Diners
const WALLET_SURCHARGE_PCT      = 1   // Apple Pay / Google Pay
const CROSS_BORDER_SURCHARGE_PCT = 2  // transação cross-border

// Taxa fixa cobrada do seller quando um chargeback é aceito (USD)
export const CHARGEBACK_FEE_USD = 50

// Taxa de PROTEÇÃO contra chargeback (Coinflow CBP) — % cobrada do seller quando
// o provider é Coinflow. Cobre o custo da proteção (NSure/Verisoul) da Coinflow.
export const CHARGEBACK_PROTECTION_FEE_PCT = 1.5

// ─── Surcharge (%) por bandeira / wallet / cross-border ───────────────────────
export function computeSurchargePct(opts?: {
  cardBrand?:    string
  walletMethod?: string
  crossBorder?:  boolean
}): number {
  let pct = 0

  const brand = (opts?.cardBrand ?? '').toLowerCase().replace(/[\s_]/g, '')
  if (['amex', 'americanexpress', 'diners', 'dinersclub'].includes(brand)) {
    pct += AMEX_DINERS_SURCHARGE_PCT
  }

  const wallet = (opts?.walletMethod ?? '').toLowerCase()
  if (wallet === 'apple_pay' || wallet === 'google_pay') {
    pct += WALLET_SURCHARGE_PCT
  }

  if (opts?.crossBorder) pct += CROSS_BORDER_SURCHARGE_PCT

  return pct
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type PaymentMethod =
  | 'CARD'
  | 'PIX'
  | 'BOLETO'
  | 'KLARNA'
  // adicione outros métodos conforme necessário

export interface SellerFees {
  sellerId:           string
  riskLevel:          'WHITE' | 'GRAY' | 'BLACK'
  feePercentage:      number  // ex: 9.99
  feeFixedUsd:        number  // ex: 0.30
  settlementDays:     number  // ex: 3
  reservePercentage:  number  // ex: 5.00
  reserveHoldDays:    number  // ex: 90
  anticipationFeePct: number  // ex: 4.99
}

/** Tarifa de quem não tem linha em seller_fees (a mesma para venda e renovação). */
export const DEFAULT_SELLER_FEES: SellerFees = {
  sellerId: '', riskLevel: 'WHITE',
  feePercentage: 9.99, feeFixedUsd: 0.30,
  settlementDays: 3, reservePercentage: 5.00,
  reserveHoldDays: 90, anticipationFeePct: 4.99,
}

export interface TransactionFeeResult {
  grossAmount:      number   // valor bruto (USD)
  platformFee:      number   // taxa da plataforma (% + fixo + surcharges + CBP)
  chargebackProtectionFee: number // parcela de proteção de chargeback (Coinflow) DENTRO do platformFee
  surchargeFee:     number   // parcela de surcharge (bandeira/wallet/cross-border) dentro do platformFee
  surchargePct:     number   // % de surcharge aplicado
  paymentMethodFee: number   // taxa adicional por método de pagamento (ex: Klarna)
  reserveAmount:    number   // valor retido como reserva
  netAmount:        number   // valor líquido para o seller
  availableAt:      Date     // data de disponibilização (D+settlementDays)
  reserveUntil:     Date     // data de liberação da reserva
  paymentMethod:    PaymentMethod
  // Antecipação (se solicitada)
  anticipationFee?: number   // taxa cobrada pela antecipação
  netIfAnticipated?: number  // líquido caso antecipe
}

// ─── Busca as tarifas do seller ───────────────────────────────────────────────

export async function getSellerFees(sellerId: string): Promise<SellerFees | null> {
  const { data } = await supabase
    .from('seller_fees')
    .select('*')
    .eq('seller_id', sellerId)
    .maybeSingle()

  if (!data) return null

  return {
    sellerId:           data.seller_id,
    riskLevel:          data.risk_level,
    feePercentage:      Number(data.fee_percentage),
    feeFixedUsd:        Number(data.fee_fixed_usd),
    settlementDays:     data.settlement_days,
    reservePercentage:  Number(data.reserve_percentage),
    reserveHoldDays:    data.reserve_hold_days,
    anticipationFeePct: Number(data.anticipation_fee_pct),
  }
}

// ─── Retorna a taxa extra (%) cobrada por método de pagamento ─────────────────

export function getPaymentMethodFeePct(method: PaymentMethod): number {
  switch (method) {
    case 'KLARNA': return KLARNA_EXTRA_FEE_PCT
    default:       return 0
  }
}

// ─── Calcula todas as taxas para uma transação ────────────────────────────────

export function calculateFees(
  grossAmountUsd: number,
  fees: SellerFees,
  options?: {
    anticipate?:    boolean
    paymentMethod?: PaymentMethod
    cardBrand?:     string    // 'amex', 'diners', 'visa'...
    walletMethod?:  string    // 'apple_pay', 'google_pay'
    crossBorder?:   boolean
    provider?:      string    // 'coinflow' → +1.5% de proteção de chargeback
  },
): TransactionFeeResult {

  const paymentMethod = options?.paymentMethod ?? 'CARD'

  // Surcharge (%) por bandeira / wallet / cross-border
  const surchargePct = computeSurchargePct({
    cardBrand:    options?.cardBrand,
    walletMethod: options?.walletMethod,
    crossBorder:  options?.crossBorder,
  })
  const surchargeFee = (grossAmountUsd * surchargePct) / 100

  // Proteção de chargeback (Coinflow CBP): +1.5% — entra DENTRO do platformFee
  // (a liquidação/ledger fecham via platform_fee) e é exposta à parte p/ registro.
  const chargebackProtectionFee = options?.provider === 'coinflow'
    ? (grossAmountUsd * CHARGEBACK_PROTECTION_FEE_PCT) / 100
    : 0

  // Taxa da plataforma: % + fixo + surcharges + proteção de chargeback
  const platformFee =
    (grossAmountUsd * fees.feePercentage) / 100
    + fees.feeFixedUsd
    + surchargeFee
    + chargebackProtectionFee

  // Taxa adicional por método de pagamento (ex: +5% para Klarna)
  const paymentMethodFeePct = getPaymentMethodFeePct(paymentMethod)
  const paymentMethodFee    = paymentMethodFeePct > 0
    ? (grossAmountUsd * paymentMethodFeePct) / 100
    : 0

  // Valor após todas as taxas de processamento
  const afterAllFees = grossAmountUsd - platformFee - paymentMethodFee

  // Reserva (% sobre o líquido após taxas)
  const reserveAmount = fees.reservePercentage > 0
    ? (afterAllFees * fees.reservePercentage) / 100
    : 0

  // Valor líquido disponível
  const netAmount = afterAllFees - reserveAmount

  // Datas
  // A liberação só ocorre às SEGUNDAS e QUINTAS. O settlementDays (T+N) define a
  // maturidade; o availableAt encaixa no próximo dia de liberação a partir dela.
  const now          = new Date()
  const maturity     = addCalendarDays(now, fees.settlementDays)
  const availableAt  = nextReleaseDay(maturity)
  const reserveUntil = fees.reserveHoldDays > 0
    ? addCalendarDays(now, fees.reserveHoldDays)
    : now

  // Antecipação (D+0)
  let anticipationFee: number | undefined
  let netIfAnticipated: number | undefined

  if (options?.anticipate) {
    anticipationFee  = (netAmount * fees.anticipationFeePct) / 100
    netIfAnticipated = netAmount - anticipationFee
  }

  return {
    grossAmount:      round(grossAmountUsd),
    platformFee:      round(platformFee),
    chargebackProtectionFee: round(chargebackProtectionFee),
    surchargeFee:     round(surchargeFee),
    surchargePct,
    paymentMethodFee: round(paymentMethodFee),
    reserveAmount:    round(reserveAmount),
    netAmount:        round(netAmount),
    availableAt,
    reserveUntil,
    paymentMethod,
    anticipationFee:  anticipationFee  !== undefined ? round(anticipationFee)  : undefined,
    netIfAnticipated: netIfAnticipated !== undefined ? round(netIfAnticipated) : undefined,
  }
}

// ─── Calcula breakdown para exibição no frontend ──────────────────────────────

export function feeBreakdown(
  grossUsd: number,
  fees: SellerFees,
  paymentMethod: PaymentMethod = 'CARD',
) {
  const result = calculateFees(grossUsd, fees, { paymentMethod })
  return {
    grossAmount:          result.grossAmount,
    platformFee:          result.platformFee,
    platformFeePct:       fees.feePercentage,
    platformFeeFixed:     fees.feeFixedUsd,
    paymentMethod:        result.paymentMethod,
    paymentMethodFee:     result.paymentMethodFee,
    paymentMethodFeePct:  getPaymentMethodFeePct(paymentMethod),
    reserveAmount:        result.reserveAmount,
    reservePct:           fees.reservePercentage,
    netAmount:            result.netAmount,
    settlementDays:       fees.settlementDays,
    availableAt:          result.availableAt.toLocaleDateString('pt-BR'),
    anticipationFee:      round((result.netAmount * fees.anticipationFeePct) / 100),
    netIfAnticipated:     round(result.netAmount - (result.netAmount * fees.anticipationFeePct) / 100),
    anticipationPct:      fees.anticipationFeePct,
    riskLevel:            fees.riskLevel,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round(v: number): number {
  return Math.round(v * 100) / 100
}

function addCalendarDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

// Próximo dia de liberação (SEGUNDA=1 ou QUINTA=4) na data dada ou depois dela.
// O horário é zerado (00:00) para liberar no início do dia.
function nextReleaseDay(date: Date): Date {
  const RELEASE_DOWS = [1, 4] // segunda, quinta
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  for (let i = 0; i < 7; i++) {
    if (RELEASE_DOWS.includes(d.getDay())) return d
    d.setDate(d.getDate() + 1)
  }
  return d
}