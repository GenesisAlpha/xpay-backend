jest.mock('../lib/supabase.client', () => ({ supabase: {} }))

import { DEFAULT_SELLER_FEES } from '../shared/fee.calculator'
import {
  isWhopRenewalPayment,
  renewalEconomics,
  renewalMetadata,
  whopPaymentAmountMinor,
  whopPaymentId,
} from './whop-renewal'

// Renovação da Whop: transação própria, com taxa da Koopfy e crédito do seller.

const FEES = {
  ...DEFAULT_SELLER_FEES,
  sellerId: 'seller-1',
  checkoutFeePct: 0,
  processingFeePct: 10,
  orchestrationFeePct: 0,
  feeFixedUsd: 0.30,
  reservePercentage: 0,
  reserveHoldDays: 0,
}

const PARENT = {
  method: 'card',
  provider: 'whop',
  payment_brand: null,
  net_amount: 8720,
  external_fee_cents: 250,
  external_fee_pct: 2.5,
  external_fee_recipient_id: 'koopfy-partner',
}

describe('renewalEconomics', () => {
  it('charges the Koopfy fee and credits the seller like a sale', () => {
    const result = renewalEconomics({ grossUSDcents: 10000, currencyConverted: false, sellerFees: FEES, parent: PARENT })
    // 10% + US$ 0,30 = 1030; comissão do parceiro 2,5% de 10000 = 250.
    expect(result).toMatchObject({
      fee: 1030,
      reserve_amount: 0,
      net_amount: 10000 - 1030 - 250,
      external_fee_cents: 250,
      external_fee_pct: 2.5,
      external_fee_recipient_id: 'koopfy-partner',
      externalFeeDropped: false,
      usd: { grossCents: 10000, fxFeeCents: 0, netCents: 10000 },
    })
  })

  it('uses the default fees when the seller has no fee row', () => {
    const result = renewalEconomics({
      grossUSDcents: 10000,
      currencyConverted: false,
      sellerFees: null,
      parent: { ...PARENT, external_fee_recipient_id: null },
    })
    // 1,9% + 8,9% + 0,9% + US$ 0,59 = 1229; reserva 10% de 8771 = 877.
    expect(result.fee).toBe(1229)
    expect(result.reserve_amount).toBe(877)
    expect(result.net_amount).toBe(10000 - 1229 - 877)
    expect(result.external_fee_cents).toBeNull()
  })

  it('charges the conversion fee only when the renewal is not in USD', () => {
    const result = renewalEconomics({
      grossUSDcents: 10000,
      currencyConverted: true,
      sellerFees: null,
      parent: { ...PARENT, external_fee_recipient_id: null },
    })
    // câmbio 2% = 200; taxas 1229; reserva 10% de 8571 = 857.
    expect(result.usd).toEqual({ grossCents: 10000, fxFeeCents: 200, netCents: 9800 })
    expect(result.fee).toBe(1229)
    expect(result.reserve_amount).toBe(857)
    expect(result.net_amount).toBe(8571 - 857)
  })

  it('scales a fixed partner fee with the renewal net', () => {
    const result = renewalEconomics({
      grossUSDcents: 5000,
      currencyConverted: false,
      sellerFees: FEES,
      parent: { ...PARENT, external_fee_pct: null, external_fee_cents: 1000, net_amount: 9000 },
    })
    // líquido-base da renovação 5000 − 530 = 4470; 1000 × 4470 / 10000 = 447.
    expect(result.external_fee_cents).toBe(447)
    expect(result.net_amount).toBe(4470 - 447)
  })

  it('never leaves the seller negative', () => {
    const result = renewalEconomics({
      grossUSDcents: 100,
      currencyConverted: false,
      sellerFees: FEES,
      parent: { ...PARENT, external_fee_pct: 99 },
    })
    expect(result.externalFeeDropped).toBe(true)
    expect(result.external_fee_cents).toBeNull()
  })
})

describe('Whop renewal payload', () => {
  it('only treats subscription cycles as renewals', () => {
    expect(isWhopRenewalPayment({ billing_reason: 'subscription_cycle' })).toBe(true)
    expect(isWhopRenewalPayment({ billing_reason: 'subscription_create' })).toBe(false)
    expect(isWhopRenewalPayment({})).toBe(false)
  })

  it('reads the payment id and the charged amount in minor units', () => {
    expect(whopPaymentId({ id: 'pay_123' })).toBe('pay_123')
    expect(whopPaymentId({ id: 'mem_123' })).toBeNull()
    expect(whopPaymentAmountMinor({ total: 148.67, subtotal: 150 })).toBe(14867)
    expect(whopPaymentAmountMinor({ total: null, final_amount: '49.90' })).toBe(4990)
    expect(whopPaymentAmountMinor({ total: 0 })).toBeNull()
  })

  it('keeps the purchase context but not the original payment', () => {
    const metadata = renewalMetadata(
      {
        payment_type: 'subscription',
        product_id: 'prod-1',
        whop_payment_id: 'pay_original',
        whop_recovery_url: 'https://whop.com/recover',
        whop_dispute: { id: 'dp_1' },
        whop_member_id: 'mber_1',
      },
      { parentTransactionId: 'tx-parent', paymentId: 'pay_renewal', membershipId: 'mem_1', cycle: 2 },
    )
    expect(metadata).toEqual({
      payment_type: 'subscription',
      product_id: 'prod-1',
      whop_member_id: 'mber_1',
      whop_payment_id: 'pay_renewal',
      whop_membership_id: 'mem_1',
      billing_reason: 'subscription_cycle',
      renewal_of_transaction_id: 'tx-parent',
      renewal_cycle: 2,
    })
  })
})
