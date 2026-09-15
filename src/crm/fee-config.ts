// Validação das taxas editadas no CRM (aprovação e edição da ficha do seller).

import { BadRequestException } from '@nestjs/common'
import { DEFAULT_FEE_SETTINGS, type FeeSettings } from '../shared/fee.calculator'

interface FeeField {
  key: keyof FeeSettings
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

  // Mensagem em texto: o CRM mostra só `message`.
  if (errors.length) throw new BadRequestException(`Taxas inválidas. ${errors.join(' ')}`)
  return result
}

/** O que mudou entre duas tarifas (para o log de auditoria). */
export function feeChanges(before: FeeSettings, after: FeeSettings) {
  return Object.fromEntries(
    FEE_FIELDS.filter((f) => before[f.key] !== after[f.key]).map((f) => [f.column, { from: before[f.key], to: after[f.key] }]),
  )
}
