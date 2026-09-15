// shared/fee.calculator.ts
// Taxas da Koopfy por seller (seller_fees): venda, reserva, chargeback e saque.
//
// Modelo (2026-09-15, definido pelo dono):
//   • todas as porcentagens incidem sobre o valor BRUTO da venda em USD;
//   • conversão de moeda só quando a venda não é em USD;
//   • taxa da plataforma = checkout + processamento + orquestração + fixa;
//   • reserva = % do que sobra depois das taxas (pode ser zero);
//   • chargeback (e alerta de chargeback da Whop) cobra uma taxa fixa;
//   • saque: mínimo, % e fixa sobre o valor sacado, e spread se sair em outra moeda.
// Tudo tem padrão aqui e pode ser alterado por seller no CRM.

import { supabase } from '../lib/supabase.client'

export interface FeeSettings {
  fxFeePct: number
  checkoutFeePct: number
  processingFeePct: number
  orchestrationFeePct: number
  feeFixedUsd: number
  reservePercentage: number
  reserveHoldDays: number
  settlementDays: number
  chargebackFeeUsd: number
  payoutMinUsd: number
  payoutFeePct: number
  payoutFeeFixedUsd: number
  payoutFxFeePct: number
  /** Seller pode antecipar o saldo a liquidar pagando `anticipationFeePct`. */
  anticipationEnabled: boolean
  anticipationFeePct: number
}

export interface SellerFees extends FeeSettings {
  sellerId: string
  riskLevel: string | null
}

export const DEFAULT_FEE_SETTINGS: FeeSettings = {
  fxFeePct: 2,
  checkoutFeePct: 1.9,
  processingFeePct: 8.9,
  orchestrationFeePct: 0.9,
  feeFixedUsd: 0.59,
  reservePercentage: 10,
  reserveHoldDays: 90,
  settlementDays: 3,
  chargebackFeeUsd: 30,
  payoutMinUsd: 200,
  payoutFeePct: 0,
  payoutFeeFixedUsd: 0,
  payoutFxFeePct: 2,
  anticipationEnabled: false,
  anticipationFeePct: 4.99,
}

/** Tarifa de quem não tem linha em seller_fees (a mesma para venda e renovação). */
export const DEFAULT_SELLER_FEES: SellerFees = { sellerId: '', riskLevel: null, ...DEFAULT_FEE_SETTINGS }

/** Soma das porcentagens da venda (sem câmbio) — o "x%" mostrado nas telas e e-mails. */
export function saleFeePct(fees: FeeSettings): number {
  return round2(fees.checkoutFeePct + fees.processingFeePct + fees.orchestrationFeePct)
}

/** Colunas de seller_fees para gravar. `fee_percentage` fica como soma, para leitores antigos. */
export function sellerFeesRow(fees: FeeSettings) {
  return {
    fx_fee_pct: fees.fxFeePct,
    checkout_fee_pct: fees.checkoutFeePct,
    processing_fee_pct: fees.processingFeePct,
    orchestration_fee_pct: fees.orchestrationFeePct,
    fee_fixed_usd: fees.feeFixedUsd,
    reserve_percentage: fees.reservePercentage,
    reserve_hold_days: fees.reserveHoldDays,
    settlement_days: fees.settlementDays,
    chargeback_fee_usd: fees.chargebackFeeUsd,
    payout_min_usd: fees.payoutMinUsd,
    payout_fee_pct: fees.payoutFeePct,
    payout_fee_fixed_usd: fees.payoutFeeFixedUsd,
    payout_fx_fee_pct: fees.payoutFxFeePct,
    fee_percentage: saleFeePct(fees),
    anticipation_enabled: fees.anticipationEnabled,
    anticipation_fee_pct: fees.anticipationFeePct,
  }
}

function num(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Linha de seller_fees → tarifa. Linha anterior à migration do novo modelo (sem
 * processing_fee_pct): `fee_percentage` era o total cobrado, então vira a taxa
 * de processamento e checkout/orquestração ficam zerados — o seller continua
 * pagando o mesmo percentual.
 */
export function sellerFeesFromRow(data: Record<string, any>): SellerFees {
  const D = DEFAULT_FEE_SETTINGS
  const legacy = data.processing_fee_pct === null || data.processing_fee_pct === undefined
  return {
    sellerId: String(data.seller_id ?? ''),
    riskLevel: data.risk_level ?? null,
    fxFeePct: num(data.fx_fee_pct, D.fxFeePct),
    checkoutFeePct: num(data.checkout_fee_pct, legacy ? 0 : D.checkoutFeePct),
    processingFeePct: num(data.processing_fee_pct, legacy ? num(data.fee_percentage, D.processingFeePct) : D.processingFeePct),
    orchestrationFeePct: num(data.orchestration_fee_pct, legacy ? 0 : D.orchestrationFeePct),
    feeFixedUsd: num(data.fee_fixed_usd, D.feeFixedUsd),
    reservePercentage: num(data.reserve_percentage, D.reservePercentage),
    reserveHoldDays: num(data.reserve_hold_days, D.reserveHoldDays),
    settlementDays: num(data.settlement_days, D.settlementDays),
    chargebackFeeUsd: num(data.chargeback_fee_usd, D.chargebackFeeUsd),
    payoutMinUsd: num(data.payout_min_usd, D.payoutMinUsd),
    payoutFeePct: num(data.payout_fee_pct, D.payoutFeePct),
    payoutFeeFixedUsd: num(data.payout_fee_fixed_usd, D.payoutFeeFixedUsd),
    payoutFxFeePct: num(data.payout_fx_fee_pct, D.payoutFxFeePct),
    anticipationEnabled: data.anticipation_enabled === true,
    anticipationFeePct: num(data.anticipation_fee_pct, D.anticipationFeePct),
  }
}

// ─── Busca as tarifas do seller ───────────────────────────────────────────────

export async function getSellerFees(sellerId: string): Promise<SellerFees | null> {
  const { data } = await supabase
    .from('seller_fees')
    .select('*')
    .eq('seller_id', sellerId)
    .maybeSingle()

  return data ? sellerFeesFromRow(data) : null
}

/** Tarifa efetiva: a do seller ou o padrão. */
export async function getEffectiveSellerFees(sellerId: string): Promise<SellerFees> {
  return (await getSellerFees(sellerId)) ?? { ...DEFAULT_SELLER_FEES, sellerId }
}

// ─── Venda ────────────────────────────────────────────────────────────────────

export interface SaleFeeResult {
  grossCents: number
  fxFeeCents: number
  checkoutFeeCents: number
  processingFeeCents: number
  orchestrationFeeCents: number
  fixedFeeCents: number
  /** checkout + processamento + orquestração + fixa (vai para `transactions.fee`). */
  platformFeeCents: number
  reserveCents: number
  /** Crédito do seller (vai para `transactions.net_amount`). */
  netCents: number
  availableAt: Date
  reserveUntil: Date
  breakdown: Record<string, unknown>
}

/**
 * Taxas de uma venda, em centavos de USD.
 *
 * As taxas nunca passam do valor da venda: numa venda menor que as taxas, a
 * taxa da plataforma é limitada ao que sobra depois do câmbio e o seller fica
 * com zero (sem crédito negativo).
 */
export function calculateSaleFees(
  grossCents: number,
  fees: FeeSettings,
  options: { currencyConverted: boolean; now?: Date },
): SaleFeeResult {
  const gross = Math.max(0, Math.round(grossCents))
  const pct = (rate: number) => Math.round((gross * rate) / 100)

  const fxFeeCents = options.currencyConverted ? pct(fees.fxFeePct) : 0
  const checkoutFeeCents = pct(fees.checkoutFeePct)
  const processingFeeCents = pct(fees.processingFeePct)
  const orchestrationFeeCents = pct(fees.orchestrationFeePct)
  const fixedFeeCents = Math.round(fees.feeFixedUsd * 100)

  const afterFx = Math.max(0, gross - fxFeeCents)
  const platformFeeCents = Math.min(
    afterFx,
    checkoutFeeCents + processingFeeCents + orchestrationFeeCents + fixedFeeCents,
  )
  const afterFees = afterFx - platformFeeCents
  const reserveCents = fees.reservePercentage > 0 ? Math.round((afterFees * fees.reservePercentage) / 100) : 0
  const netCents = afterFees - reserveCents

  const now = options.now ?? new Date()
  const availableAt = nextReleaseDay(addCalendarDays(now, fees.settlementDays))
  const reserveUntil = fees.reserveHoldDays > 0 ? addCalendarDays(now, fees.reserveHoldDays) : now

  return {
    grossCents: gross,
    fxFeeCents,
    checkoutFeeCents,
    processingFeeCents,
    orchestrationFeeCents,
    fixedFeeCents,
    platformFeeCents,
    reserveCents,
    netCents,
    availableAt,
    reserveUntil,
    breakdown: {
      model: '2026-09',
      gross_cents: gross,
      fx_fee_cents: fxFeeCents,
      checkout_fee_cents: checkoutFeeCents,
      processing_fee_cents: processingFeeCents,
      orchestration_fee_cents: orchestrationFeeCents,
      fixed_fee_cents: fixedFeeCents,
      platform_fee_cents: platformFeeCents,
      reserve_cents: reserveCents,
      net_cents: netCents,
      rates: {
        fx_fee_pct: options.currencyConverted ? fees.fxFeePct : 0,
        checkout_fee_pct: fees.checkoutFeePct,
        processing_fee_pct: fees.processingFeePct,
        orchestration_fee_pct: fees.orchestrationFeePct,
        fee_fixed_usd: fees.feeFixedUsd,
        reserve_percentage: fees.reservePercentage,
      },
    },
  }
}

/**
 * `transactions.fee_breakdown` → taxas separadas em USD para as telas.
 * Nulo quando a venda é anterior ao modelo de taxas (sem breakdown): a tela
 * mostra só o total de `transactions.fee`.
 */
export function publicFeeBreakdown(breakdown: any) {
  if (!breakdown || typeof breakdown !== 'object' || breakdown.processing_fee_cents == null) return null
  const usd = (cents: unknown) => round2(Number(cents ?? 0) / 100)
  const rate = (value: unknown) => {
    const n = Number(value ?? 0)
    return Number.isFinite(n) ? n : 0
  }
  const rates = breakdown.rates ?? {}
  return {
    processing: usd(breakdown.processing_fee_cents),
    orchestration: usd(breakdown.orchestration_fee_cents),
    checkout: usd(breakdown.checkout_fee_cents),
    fixed: usd(breakdown.fixed_fee_cents),
    fx: usd(breakdown.fx_fee_cents),
    rates: {
      processingPct: rate(rates.processing_fee_pct),
      orchestrationPct: rate(rates.orchestration_fee_pct),
      checkoutPct: rate(rates.checkout_fee_pct),
      fixedUsd: rate(rates.fee_fixed_usd),
      fxPct: rate(rates.fx_fee_pct),
    },
  }
}

// ─── Saque ────────────────────────────────────────────────────────────────────

export interface PayoutFeeResult {
  amountCents: number
  feeCents: number
  fxFeeCents: number
  netCents: number
}

/** Taxas de um saque (em centavos de USD): % + fixa sobre o valor, e spread se sair em outra moeda. */
export function calculatePayoutFees(
  amountCents: number,
  fees: FeeSettings,
  options: { currencyConverted: boolean },
): PayoutFeeResult {
  const amount = Math.max(0, Math.round(amountCents))
  const feeCents = Math.min(amount, Math.round((amount * fees.payoutFeePct) / 100) + Math.round(fees.payoutFeeFixedUsd * 100))
  const fxFeeCents = options.currencyConverted
    ? Math.min(amount - feeCents, Math.round(((amount - feeCents) * fees.payoutFxFeePct) / 100))
    : 0
  return { amountCents: amount, feeCents, fxFeeCents, netCents: amount - feeCents - fxFeeCents }
}

/** Moeda em que o saque é pago: Pix em BRL, IBAN em EUR, ACH e USDT em USD. */
export function payoutCurrencyForMethod(method: string): 'USD' | 'BRL' | 'EUR' {
  const m = String(method ?? '').toLowerCase()
  if (m === 'pix') return 'BRL'
  if (m === 'iban') return 'EUR'
  return 'USD'
}

// ─── Antecipação ──────────────────────────────────────────────────────────────

/** Antecipação do saldo a liquidar: a taxa incide sobre todo o valor antecipado. */
export function calculateAnticipation(pendingCents: number, fees: FeeSettings) {
  const pending = Math.max(0, Math.round(pendingCents))
  const feeCents = Math.min(pending, Math.round((pending * fees.anticipationFeePct) / 100))
  return { pendingCents: pending, feeCents, netCents: pending - feeCents }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round2(v: number): number {
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
