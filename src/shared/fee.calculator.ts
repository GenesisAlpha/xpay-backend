// shared/fee.calculator.ts
// Calcula taxas, reservas e liquidação para uma transação
// baseado nas seller_fees do seller.

import { supabase } from '../lib/supabase.client'

// ─── Tipos ────────────────────────────────────────────────────────────────────

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

export interface TransactionFeeResult {
  grossAmount:      number   // valor bruto (USD)
  platformFee:      number   // taxa da plataforma (% + fixo)
  reserveAmount:    number   // valor retido como reserva
  netAmount:        number   // valor líquido para o seller
  availableAt:      Date     // data de disponibilização (D+settlementDays)
  reserveUntil:     Date     // data de liberação da reserva
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

// ─── Calcula todas as taxas para uma transação ────────────────────────────────

export function calculateFees(
  grossAmountUsd: number,
  fees: SellerFees,
  options?: { anticipate?: boolean },
): TransactionFeeResult {

  // Taxa da plataforma: % + fixo
  const platformFee =
    (grossAmountUsd * fees.feePercentage) / 100
    + fees.feeFixedUsd

  // Valor após taxa da plataforma
  const afterPlatformFee = grossAmountUsd - platformFee

  // Reserva (% sobre o líquido após taxa)
  const reserveAmount = fees.reservePercentage > 0
    ? (afterPlatformFee * fees.reservePercentage) / 100
    : 0

  // Valor líquido disponível
  const netAmount = afterPlatformFee - reserveAmount

  // Datas
  const now          = new Date()
  const availableAt  = addBusinessDays(now, fees.settlementDays)
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
    grossAmount:     round(grossAmountUsd),
    platformFee:     round(platformFee),
    reserveAmount:   round(reserveAmount),
    netAmount:       round(netAmount),
    availableAt,
    reserveUntil,
    anticipationFee:     anticipationFee   !== undefined ? round(anticipationFee)   : undefined,
    netIfAnticipated:    netIfAnticipated  !== undefined ? round(netIfAnticipated)  : undefined,
  }
}

// ─── Calcula breakdown para exibição no frontend ──────────────────────────────

export function feeBreakdown(grossUsd: number, fees: SellerFees) {
  const result = calculateFees(grossUsd, fees)
  return {
    grossAmount:       result.grossAmount,
    platformFee:       result.platformFee,
    platformFeePct:    fees.feePercentage,
    platformFeeFixed:  fees.feeFixedUsd,
    reserveAmount:     result.reserveAmount,
    reservePct:        fees.reservePercentage,
    netAmount:         result.netAmount,
    settlementDays:    fees.settlementDays,
    availableAt:       result.availableAt.toLocaleDateString('pt-BR'),
    anticipationFee:   round((result.netAmount * fees.anticipationFeePct) / 100),
    netIfAnticipated:  round(result.netAmount - (result.netAmount * fees.anticipationFeePct) / 100),
    anticipationPct:   fees.anticipationFeePct,
    riskLevel:         fees.riskLevel,
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

function addBusinessDays(date: Date, days: number): Date {
  const d    = new Date(date)
  let added  = 0
  while (added < days) {
    d.setDate(d.getDate() + 1)
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) added++ // pula sáb e dom
  }
  return d
}