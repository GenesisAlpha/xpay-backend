const { randomUUID } = require('node:crypto')
const { stripeApi } = require('./xpay-atlasclub-stripe.cjs')

async function main() {
  const key = process.env.XPAY_TEST_KEY
  if (!key?.startsWith('sk_test_')) throw new Error('Stripe sandbox key required')
  const stripe = stripeApi(key)
  if ((await stripe('account')).id !== 'acct_1UDmhJGvCr3rw8GW') throw new Error('Unexpected sandbox account')
  const order = randomUUID()
  const session = await stripe('checkout/sessions', {}, {
    mode: 'payment',
    'payment_method_types[0]': 'mb_way',
    'line_items[0][price_data][currency]': 'eur',
    'line_items[0][price_data][unit_amount]': '990',
    'line_items[0][price_data][product_data][name]': 'XPAY MB WAY Pro sandbox',
    'line_items[0][quantity]': '1',
    'payment_intent_data[metadata][xpay_order_id]': order,
    client_reference_id: order,
    integration_identifier: 'xpay_mbway_azfhrbpt',
    success_url: 'https://xpay.expert/',
    cancel_url: 'https://xpay.expert/',
  })
  try {
    const url = new URL(session.url)
    if (session.livemode !== false || session.mode !== 'payment' || session.amount_total !== 990 ||
        session.currency !== 'eur' || session.payment_status !== 'unpaid' || session.client_reference_id !== order ||
        session.payment_method_types?.join() !== 'mb_way' ||
        url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') throw new Error('Unexpected session')
  } finally {
    const expired = await stripe('checkout/sessions/' + session.id + '/expire', {}, {})
    if (expired.status !== 'expired' || expired.payment_status !== 'unpaid') throw new Error('Expiration not verified')
  }
  console.log('MB WAY only; EUR 9.90; sandbox; expired unpaid')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
