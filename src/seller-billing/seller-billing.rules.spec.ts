import {
  billingStatusFromWhopPayment,
  savedCardFromSetupIntent,
  setupIntentMatches,
  toWhopPrice,
  whopFailureMessage,
} from './seller-billing.rules'

describe('billingStatusFromWhopPayment', () => {
  it('paid only when Whop says so', () => {
    expect(billingStatusFromWhopPayment({ status: 'paid' })).toBe('paid')
    expect(billingStatusFromWhopPayment({ status: 'open', substatus: 'pending' })).toBe('pending')
    expect(billingStatusFromWhopPayment({})).toBe('pending')
  })

  it('failed on explicit failure states', () => {
    expect(billingStatusFromWhopPayment({ status: 'open', substatus: 'failed' })).toBe('failed')
    expect(billingStatusFromWhopPayment({ status: 'uncollectible' })).toBe('failed')
    expect(billingStatusFromWhopPayment({ status: 'void' })).toBe('failed')
  })
})

describe('whopFailureMessage', () => {
  it('prefers the message, then the decline code', () => {
    expect(whopFailureMessage({ failure_message: 'Insufficient funds' })).toBe('Insufficient funds')
    expect(whopFailureMessage({ decline_code: 'do_not_honor' })).toBe('Cartão recusado (do_not_honor)')
    expect(whopFailureMessage({})).toBeNull()
  })
})

describe('toWhopPrice', () => {
  it('converts cents to major units', () => {
    expect(toWhopPrice(1234, 'usd')).toBe(12.34)
    expect(toWhopPrice(500, 'BRL')).toBe(5)
  })

  it('keeps zero-decimal currencies as they are', () => {
    expect(toWhopPrice(1500, 'JPY')).toBe(1500)
  })
})

describe('savedCardFromSetupIntent', () => {
  const intent = {
    status: 'succeeded',
    member: { id: 'mber_1' },
    payment_method: { id: 'payt_1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } },
  }

  it('extracts member, method and card', () => {
    expect(savedCardFromSetupIntent(intent)).toEqual({
      memberId: 'mber_1', paymentMethodId: 'payt_1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030,
    })
  })

  it('ignores intents that did not succeed or lack ids', () => {
    expect(savedCardFromSetupIntent({ ...intent, status: 'processing' })).toBeNull()
    expect(savedCardFromSetupIntent({ ...intent, member: null })).toBeNull()
  })

  it('reads the card fields flat on the payment method too', () => {
    const flat = { status: 'succeeded', member: { id: 'm' }, payment_method: { id: 'p', brand: 'mastercard', last4: '1111' } }
    expect(savedCardFromSetupIntent(flat)).toMatchObject({ brand: 'mastercard', last4: '1111', expMonth: null })
  })
})

describe('setupIntentMatches', () => {
  it('matches by checkout configuration id', () => {
    expect(setupIntentMatches({ checkout_configuration: { id: 'ch_1' } }, 'ch_1', 'ws')).toBe(true)
    expect(setupIntentMatches({ checkout_configuration: { id: 'ch_2' } }, 'ch_1', 'ws')).toBe(false)
  })

  it('falls back to our metadata', () => {
    expect(setupIntentMatches({ metadata: { koopfy_billing: 'setup', koopfy_workspace_id: 'ws' } }, 'ch_1', 'ws')).toBe(true)
    expect(setupIntentMatches({ metadata: { koopfy_billing: 'setup', koopfy_workspace_id: 'other' } }, 'ch_1', 'ws')).toBe(false)
  })
})
