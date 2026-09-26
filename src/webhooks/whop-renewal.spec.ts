jest.mock('../lib/supabase.client', () => ({ supabase: {} }))

import { DEFAULT_SELLER_FEES } from '../shared/fee.calculator'
import {
  isWhopRenewalPayment,
  renewalEconomics,
  renewalMetadata,
  whopPaymentAmountMinor,
  whopPaymentId,
} from './whop-renewal'
import { WebhookService } from './webhook.service'

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

describe('Whop payout event routing', () => {
  it.each(['payout.created', 'payout.updated', 'payout.reversed'])(
    'routes %s before payment mapping',
    async (type) => {
      const payoutHandler = {
        handles: jest.fn().mockReturnValue(true),
        handleVerifiedEvent: jest.fn().mockResolvedValue({ state: 'processing' }),
      }
      const service = new WebhookService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        payoutHandler as never,
      {} as never,
      )

      await (service as any).processWhopEvent(
        'biz_master',
        {},
        type,
        {
          id: `evt_${type}`,
          type,
          data: {
            id: 'wdrl_1',
            metadata: {
              koopfy_payout_id: '00000000-0000-4000-8000-000000000123',
              koopfy_account_id: 'biz_connected',
              koopfy_master_account_id: 'biz_master',
            },
          },
        },
      )

      expect(payoutHandler.handleVerifiedEvent).toHaveBeenCalledTimes(1)
    },
  )

  it('selects the master signing account without confusing it with the connected seller account', async () => {
    const payoutHandler = {
      handles: jest.fn().mockReturnValue(true),
      handleVerifiedEvent: jest.fn(),
    }
    const service = new WebhookService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      payoutHandler as never,
      {} as never,
    )
    const delegated = jest
      .spyOn(service, 'handleWhopWebhook')
      .mockResolvedValue({ state: 'processing' } as never)
    const body = {
      id: 'evt_payout',
      type: 'payout.updated',
      data: {
        id: 'wdrl_1',
        metadata: {
          koopfy_account_id: 'biz_connected',
          koopfy_master_account_id: 'biz_master',
        },
      },
    }

    await service.handleSharedWhopWebhook(body, JSON.stringify(body), {})

    expect(delegated).toHaveBeenCalledWith(
      'biz_master',
      body,
      JSON.stringify(body),
      {},
    )
  })

  it('never writes the raw Whop account id to logs or signature errors', async () => {
    const payoutHandler = { handles: jest.fn().mockReturnValue(true) }
    const whopAccounts = {
      getById: jest.fn().mockResolvedValue({
        config: { webhook_secret: 'ws_secret' },
      }),
    }
    const service = new WebhookService(
      {} as never,
      {} as never,
      whopAccounts as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      payoutHandler as never,
      {} as never,
    )
    jest.spyOn(service as any, 'verifyWhopSignature').mockReturnValue({
      valid: false,
      reason: 'bad signature',
    })
    const logged = [
      jest.spyOn(console, 'log').mockImplementation(),
      jest.spyOn(console, 'warn').mockImplementation(),
      jest.spyOn(console, 'error').mockImplementation(),
    ]

    const result = service.handleWhopWebhook(
      'biz_master_secret',
      { type: 'payout.updated' },
      '{}',
      {},
    )
    await expect(result).rejects.toThrow('assinatura inválida')

    expect(
      JSON.stringify(logged.flatMap((spy) => spy.mock.calls)),
    ).not.toContain('biz_master_secret')
    await result.catch((error) => {
      expect(String(error)).not.toContain('biz_master_secret')
    })
  })
})
