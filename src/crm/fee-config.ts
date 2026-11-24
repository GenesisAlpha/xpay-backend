// Validação das taxas editadas no CRM (aprovação e edição da ficha do seller).

import { BadRequestException } from '@nestjs/common'
import { DEFAULT_FEE_SETTINGS, type FeeSettings } from '../shared/fee.calculator'

type NumericFeeKey = Exclude<keyof FeeSettings, 'anticipationEnabled' | 'localProcessingFeePct'>

interface FeeField {
  key: NumericFeeKey
  column: string
  min: number
  max: number
  integer?: boolean
  label: string
}

export const FEE_FIELDS: FeeField[] = [
  { key: 'fxFeePct', column: 'fx_fee_pct', min: 0, max: 20, label: 'Conversão de moeda (%)' },
  { key: 'checkoutFeePct', column: 'checkout_fee_pct', min: 0, max: 50, label: 'Checkout (%)' },
  { key: 'processingFeePct', column: 'processing_fee_pct', min: 0, max: 50, label: 'Processamento (%)' },
  { key: 'orchestrationFeePct', column: 'orchestration_fee_pct', min: 0, max: 50, label: 'Orquestração (%)' },
  { key: 'feeFixedUsd', column: 'fee_fixed_usd', min: 0, max: 50, label: 'Taxa fixa (USD)' },
  { key: 'reservePercentage', column: 'reserve_percentage', min: 0, max: 50, label: 'Reserva (%)' },
  { key: 'reserveHoldDays', column: 'reserve_hold_days', min: 0, max: 365, integer: true, label: 'Prazo da reserva (dias)' },
  { key: 'settlementDays', column: 'settlement_days', min: 0, max: 60, integer: true, label: 'Liberação (dias)' },
  { key: 'chargebackFeeUsd', column: 'chargeback_fee_usd', min: 0, max: 500, label: 'Taxa de chargeback (USD)' },
  { key: 'payoutMinUsd', column: 'payout_min_usd', min: 0, max: 100000, label: 'Saque mínimo (USD)' },
  { key: 'payoutFeePct', column: 'payout_fee_pct', min: 0, max: 50, label: 'Taxa de saque (%)' },
  { key: 'payoutFeeFixedUsd', column: 'payout_fee_fixed_usd', min: 0, max: 1000, label: 'Taxa fixa de saque (USD)' },
  { key: 'payoutFxFeePct', column: 'payout_fx_fee_pct', min: 0, max: 20, label: 'Spread de saque em outra moeda (%)' },
  { key: 'anticipationFeePct', column: 'anticipation_fee_pct', min: 0, max: 50, label: 'Taxa de antecipação (%)' },
]

/**
 * Processamento nos métodos locais (Pix, SPEI, Transferencias 3.0, PSE). Em
 * branco = o mesmo do cartão. `null` explícito limpa.
 */
export const LOCAL_FEE_FIELD = { key: 'localProcessingFeePct' as const, column: 'local_processing_fee_pct', min: 0, max: 50, label: 'Processamento em métodos locais (%)' }

/** Liga/desliga por seller. */
export const FEE_TOGGLES: Array<{ key: 'anticipationEnabled'; column: string; label: string }> = [
  { key: 'anticipationEnabled', column: 'anticipation_enabled', label: 'Antecipação habilitada' },
]

/**
 * Mescla o que veio do CRM sobre `base`. Aceita camelCase (`processingFeePct`)
 * ou o nome da coluna (`processing_fee_pct`); campo ausente mantém o de `base`.
 * Valor fora da faixa é recusado com a lista de erros.
 */
export function parseFeeSettings(input: unknown, base: FeeSettings = DEFAULT_FEE_SETTINGS): FeeSettings {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const result: FeeSettings = { ...base }
  const errors: string[] = []

  for (const field of FEE_FIELDS) {
    const raw = source[field.key] ?? source[field.column]
    if (raw === undefined || raw === null || raw === '') continue
    const value = typeof raw === 'string' ? Number(raw.replace(',', '.')) : Number(raw)
    if (!Number.isFinite(value) || value < field.min || value > field.max) {
      errors.push(`${field.label}: use um valor entre ${field.min} e ${field.max}.`)
      continue
    }
    if (field.integer && !Number.isInteger(value)) {
      errors.push(`${field.label}: use um número inteiro.`)
      continue
    }
    result[field.key] = Math.round(value * 100) / 100
  }

  {
    const f = LOCAL_FEE_FIELD
    const tem = f.key in source || f.column in source
    const raw = f.key in source ? source[f.key] : source[f.column]
    if (tem && (raw === null || raw === '')) result.localProcessingFeePct = null
    else if (raw !== undefined && raw !== null) {
      const value = typeof raw === 'string' ? Number(raw.replace(',', '.')) : Number(raw)
      if (!Number.isFinite(value) || value < f.min || value > f.max) errors.push(`${f.label}: use um valor entre ${f.min} e ${f.max}, ou deixe em branco.`)
      else result.localProcessingFeePct = Math.round(value * 100) / 100
    }
  }

  for (const toggle of FEE_TOGGLES) {
    const raw = source[toggle.key] ?? source[toggle.column]
    if (raw === undefined || raw === null || raw === '') continue
    if (raw === true || raw === 1 || raw === '1' || raw === 'true') result[toggle.key] = true
    else if (raw === false || raw === 0 || raw === '0' || raw === 'false') result[toggle.key] = false
    else errors.push(`${toggle.label}: use sim ou não.`)
  }

  // Mensagem em texto: o CRM mostra só `message`.
  if (errors.length) throw new BadRequestException(`Taxas inválidas. ${errors.join(' ')}`)
  return result
}

/** O que mudou entre duas tarifas (para o log de auditoria). */
export function feeChanges(before: FeeSettings, after: FeeSettings) {
  return Object.fromEntries(
    [...FEE_FIELDS, ...FEE_TOGGLES, LOCAL_FEE_FIELD]
      .filter((f) => (before[f.key] ?? null) !== (after[f.key] ?? null))
      .map((f) => [f.column, { from: before[f.key] ?? null, to: after[f.key] ?? null }]),
  )
}

/** A coluna dos métodos locais quando mudou (inclusive para limpar: volta a ser a do cartão). */
export function localFeeWrite(before: FeeSettings, after: FeeSettings) {
  return (before.localProcessingFeePct ?? null) === (after.localProcessingFeePct ?? null) ? {} : { local_processing_fee_pct: after.localProcessingFeePct ?? null }
}

/**
 * Colunas da taxa de checkout quando o CRM a alterou: origem 'crm' e a hora.
 * Sem mudança no "Checkout (%)" não toca na origem — o plano (ou o 'legacy')
 * continua valendo.
 */
export function checkoutFeeWrite(before: FeeSettings, after: FeeSettings, now = new Date()) {
  if (before.checkoutFeePct === after.checkoutFeePct) return {}
  return { checkout_fee_source: 'crm' as const, checkout_fee_updated_at: now.toISOString() }
}
