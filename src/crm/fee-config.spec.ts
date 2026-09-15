jest.mock('../lib/supabase.client', () => ({ supabase: {} }))

import { BadRequestException } from '@nestjs/common'
import { DEFAULT_FEE_SETTINGS } from '../shared/fee.calculator'
import { feeChanges, parseFeeSettings } from './fee-config'

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
