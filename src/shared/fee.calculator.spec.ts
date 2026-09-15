jest.mock('../lib/supabase.client', () => ({ supabase: {} }))

import {
  calculatePayoutFees,
  calculateProviderCost,
  calculateSaleFees,
  payoutCurrencyForMethod,
  publicFeeBreakdown,
  DEFAULT_FEE_SETTINGS,
  saleFeePct,
  sellerFeesFromRow,
  sellerFeesRow,
} from './fee.calculator'

describe('publicFeeBreakdown', () => {
  it('turns the stored breakdown into separate USD fees with their rates', () => {
    const { breakdown } = calculateSaleFees(10000, DEFAULT_FEE_SETTINGS, { currencyConverted: true, now: new Date('2026-09-15T12:00:00Z') })
    expect(publicFeeBreakdown(breakdown)).toEqual({
      processing: 8.9,
      orchestration: 0.9,
      checkout: 1.9,
      fixed: 0.59,
      fx: 2,
      rates: { processingPct: 8.9, orchestrationPct: 0.9, checkoutPct: 1.9, fixedUsd: 0.59, fxPct: 2 },
    })
  })

  it('returns null for sales before the fee model', () => {
    expect(publicFeeBreakdown(null)).toBeNull()
    expect(publicFeeBreakdown({ some: 'legacy' })).toBeNull()
  })
})

describe('calculateProviderCost', () => {
  it('charges processing, fixed and orchestration, plus conversion outside USD', () => {
    expect(calculateProviderCost(10000, { currencyConverted: true })).toEqual({
      processing_cents: 270,
      fixed_cents: 30,
      orchestration_cents: 80,
      fx_cents: 150,
      total_cents: 530,
      rates: { processing_pct: 2.7, fixed_usd: 0.3, orchestration_pct: 0.8, fx_pct: 1.5 },
    })
    expect(calculateProviderCost(10000, { currencyConverted: false })).toMatchObject({ fx_cents: 0, total_cents: 380 })
  })

  it('is stored in the sale breakdown without changing what the seller pays', () => {
    const r = calculateSaleFees(10000, DEFAULT_FEE_SETTINGS, { currencyConverted: false })
    expect(r.providerCostCents).toBe(380)
    expect((r.breakdown.provider_cost as any).total_cents).toBe(380)
    expect(r.netCents).toBe(10000 - 1229 - 877)
  })
})

describe('calculateSaleFees', () => {
  it('applies every rate on the gross USD amount and the reserve on what is left', () => {
    const r = calculateSaleFees(10000, DEFAULT_FEE_SETTINGS, { currencyConverted: true, now: new Date('2026-09-15T12:00:00Z') })
    expect(r).toMatchObject({
      grossCents: 10000,
      fxFeeCents: 200,
      checkoutFeeCents: 190,
      processingFeeCents: 890,
      orchestrationFeeCents: 90,
      fixedFeeCents: 59,
      platformFeeCents: 1229,
      reserveCents: 857, // 10% de 10000 − 200 − 1229 = 8571
      netCents: 7714,
    })
    expect(r.grossCents - r.fxFeeCents).toBe(r.platformFeeCents + r.reserveCents + r.netCents)
  })

  it('skips the conversion fee for sales already in USD', () => {
    const r = calculateSaleFees(10000, DEFAULT_FEE_SETTINGS, { currencyConverted: false })
    expect(r.fxFeeCents).toBe(0)
    expect(r.netCents).toBe(10000 - 1229 - 877)
  })

  it('respects a zero reserve and custom rates', () => {
    const r = calculateSaleFees(
      5000,
      { ...DEFAULT_FEE_SETTINGS, reservePercentage: 0, processingFeePct: 5, checkoutFeePct: 0, orchestrationFeePct: 0, feeFixedUsd: 0 },
      { currencyConverted: false },
    )
    expect(r.platformFeeCents).toBe(250)
    expect(r.reserveCents).toBe(0)
    expect(r.netCents).toBe(4750)
  })

  it('never charges more than the sale', () => {
    const r = calculateSaleFees(50, DEFAULT_FEE_SETTINGS, { currencyConverted: true })
    expect(r.platformFeeCents).toBe(49) // 50 − câmbio 1
    expect(r.netCents).toBe(0)
    expect(r.reserveCents).toBe(0)
  })
})

describe('calculatePayoutFees', () => {
  it('charges percentage, fixed and spread only for another currency', () => {
    const fees = { ...DEFAULT_FEE_SETTINGS, payoutFeePct: 1, payoutFeeFixedUsd: 2 }
    expect(calculatePayoutFees(50000, fees, { currencyConverted: false })).toEqual({
      amountCents: 50000, feeCents: 700, fxFeeCents: 0, netCents: 49300,
    })
    expect(calculatePayoutFees(50000, fees, { currencyConverted: true })).toEqual({
      amountCents: 50000, feeCents: 700, fxFeeCents: 986, netCents: 48314,
    })
  })

  it('uses zero payout fee and 2% spread by default', () => {
    expect(calculatePayoutFees(20000, DEFAULT_FEE_SETTINGS, { currencyConverted: true })).toEqual({
      amountCents: 20000, feeCents: 0, fxFeeCents: 400, netCents: 19600,
    })
  })
})

describe('payoutCurrencyForMethod', () => {
  it('pays Pix in BRL, IBAN in EUR and the rest in USD', () => {
    expect(payoutCurrencyForMethod('pix')).toBe('BRL')
    expect(payoutCurrencyForMethod('IBAN')).toBe('EUR')
    expect(payoutCurrencyForMethod('ach')).toBe('USD')
    expect(payoutCurrencyForMethod('crypto')).toBe('USD')
  })
})

describe('seller_fees rows', () => {
  it('writes the sum as the legacy fee_percentage', () => {
    expect(saleFeePct(DEFAULT_FEE_SETTINGS)).toBe(11.7)
    expect(sellerFeesRow(DEFAULT_FEE_SETTINGS)).toMatchObject({
      processing_fee_pct: 8.9, checkout_fee_pct: 1.9, orchestration_fee_pct: 0.9,
      fee_percentage: 11.7, chargeback_fee_usd: 30, payout_min_usd: 200, payout_fx_fee_pct: 2,
    })
  })

  it('keeps legacy rows charging the same total until the migration runs', () => {
    const fees = sellerFeesFromRow({ seller_id: 's1', fee_percentage: 14.99, fee_fixed_usd: 0.59, reserve_percentage: 5 })
    expect(fees).toMatchObject({ processingFeePct: 14.99, checkoutFeePct: 0, orchestrationFeePct: 0, reservePercentage: 5, fxFeePct: 2 })
  })

  it('reads the new columns, including zero values', () => {
    const fees = sellerFeesFromRow({
      seller_id: 's1', processing_fee_pct: 7, checkout_fee_pct: 0, orchestration_fee_pct: 0.5,
      fee_fixed_usd: 0, reserve_percentage: 0, chargeback_fee_usd: 0,
    })
    expect(fees).toMatchObject({ processingFeePct: 7, checkoutFeePct: 0, orchestrationFeePct: 0.5, feeFixedUsd: 0, reservePercentage: 0, chargebackFeeUsd: 0 })
  })
})
