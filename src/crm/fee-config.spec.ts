jest.mock('../lib/supabase.client', () => ({ supabase: {} }))

import { BadRequestException } from '@nestjs/common'
import { DEFAULT_FEE_SETTINGS } from '../shared/fee.calculator'
import { feeChanges, localFeeWrite, parseFeeSettings } from './fee-config'

describe('parseFeeSettings', () => {
  it('keeps the defaults for fields that were not sent', () => {
    expect(parseFeeSettings({ processingFeePct: 7.5 })).toEqual({ ...DEFAULT_FEE_SETTINGS, processingFeePct: 7.5 })
  })

  it('accepts column names, strings with comma and zero', () => {
    const result = parseFeeSettings({ reserve_percentage: '0', fee_fixed_usd: '0,49', payout_min_usd: 100 })
    expect(result.reservePercentage).toBe(0)
    expect(result.feeFixedUsd).toBe(0.49)
    expect(result.payoutMinUsd).toBe(100)
  })

  it('rejects out-of-range and non-integer values', () => {
    expect(() => parseFeeSettings({ processingFeePct: 80 })).toThrow(BadRequestException)
    expect(() => parseFeeSettings({ settlementDays: 2.5 })).toThrow(BadRequestException)
    expect(() => parseFeeSettings({ feeFixedUsd: 'abc' })).toThrow(BadRequestException)
  })

  it('lists what changed for the audit log', () => {
    const after = parseFeeSettings({ chargebackFeeUsd: 45 })
    expect(feeChanges(DEFAULT_FEE_SETTINGS, after)).toEqual({ chargeback_fee_usd: { from: 30, to: 45 } })
  })
})

describe('processamento nos métodos locais (CRM)', () => {
  it('define, mantém e limpa', () => {
    const def = parseFeeSettings({ local_processing_fee_pct: '1,5' })
    expect(def.localProcessingFeePct).toBe(1.5)
    expect(parseFeeSettings({}, def).localProcessingFeePct).toBe(1.5)
    expect(parseFeeSettings({ localProcessingFeePct: null }, def).localProcessingFeePct).toBeNull()
    expect(parseFeeSettings({ local_processing_fee_pct: '' }, def).localProcessingFeePct).toBeNull()
  })
  it('recusa fora da faixa', () => {
    expect(() => parseFeeSettings({ localProcessingFeePct: 60 })).toThrow(BadRequestException)
  })
  it('escreve a coluna só quando mudou (inclusive para limpar)', () => {
    const com = { ...DEFAULT_FEE_SETTINGS, localProcessingFeePct: 1 }
    expect(localFeeWrite(DEFAULT_FEE_SETTINGS, DEFAULT_FEE_SETTINGS)).toEqual({})
    expect(localFeeWrite(DEFAULT_FEE_SETTINGS, com)).toEqual({ local_processing_fee_pct: 1 })
    expect(localFeeWrite(com, DEFAULT_FEE_SETTINGS)).toEqual({ local_processing_fee_pct: null })
    expect(feeChanges(DEFAULT_FEE_SETTINGS, com)).toMatchObject({ local_processing_fee_pct: { from: null, to: 1 } })
  })
})
