const { setTimeout: wait } = require('node:timers/promises')

const XPAY = 'https://oxbvwceiegagekfrfarg.supabase.co'
const ORBIA = 'https://xmbayvitmxygeiynagxj.supabase.co'
const workerInstallation = 'orbia.live'

function createPostgrest(origin, credential, schema, fetcher) {
  return async function request(path, { method = 'GET', body } = {}) {
    const response = await fetcher(origin + '/rest/v1/' + path, {
      method,
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
      headers: {
        apikey: credential,
        authorization: 'Bearer ' + credential,
        'content-type': 'application/json',
        'Accept-Profile': schema,
        'Content-Profile': schema,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const details = await response.json().catch(() => null)
      const code = typeof details?.code === 'string' && /^[A-Z0-9]+$/.test(details.code) ? ' ' + details.code : ''
      throw new Error('Data API ' + response.status + code)
    }
    return response.status === 204 ? null : await response.json()
  }
}

function filters(values) {
  return new URLSearchParams(values).toString()
}

function createDelivery({ xpayKey, orbiaKey, fetcher = global.fetch }) {
  const xpay = createPostgrest(XPAY, xpayKey, 'xpay_live', fetcher)
  const orbia = createPostgrest(ORBIA, orbiaKey, 'public', fetcher)

  async function deliver(event) {
    const body = event.body
    const refund = event.event_type === 'payment.refunded'
    const refundId = refund && /^re_[a-zA-Z0-9]{1,125}$/.test(body?.refundId ?? '') ? body.refundId : null
    const expectedKey = event.event_type + ':' + body?.transactionId + (refund ? ':' + refundId : '')
    if ((!refund && event.event_type !== 'payment.approved') ||
      (refund && (!refundId || body?.billingSource !== 'stripe_subscription')) ||
      body?.installation !== workerInstallation || event.event_key !== expectedKey || !body.organizationId) {
      throw new Error('Outbox event has no valid Orbia destination')
    }
    const mappings = await xpay('xpay_orbia_merchants?' + filters({
      select: 'orbia_org_id,orbia_installation',
      seller_id: 'eq.' + event.seller_id,
      limit: '2',
    }))
    if (mappings.length !== 1 || mappings[0].orbia_org_id !== body.organizationId
      || mappings[0].orbia_installation !== workerInstallation) {
      throw new Error('Outbox event does not match the seller destination')
    }

    if (body.billingSource === 'stripe_subscription') {
      const invoiceId = /^stripe-invoice:(in_[a-zA-Z0-9]{1,125})$/.exec(body.transactionId)?.[1]
      if (!invoiceId) throw new Error('Outbox event has no Stripe invoice reference')
      const invoices = await xpay('xpay_stripe_subscription_invoices?' + filters({
        select: 'invoice_id,gross_minor,fee_minor,net_minor,currency',
        invoice_id: 'eq.' + invoiceId,
        seller_id: 'eq.' + event.seller_id,
        limit: '1',
      }))
      const invoice = invoices[0]
      if (invoices.length !== 1 || invoice.currency !== 'EUR' || body.gross?.currency !== invoice.currency) {
        throw new Error('Outbox event does not match the booked EUR invoice')
      }
      if (refund) {
        const refunds = await xpay('xpay_stripe_subscription_refunds?' + filters({
          select: 'refund_id,gross_minor',
          refund_id: 'eq.' + refundId,
          invoice_id: 'eq.' + invoiceId,
          limit: '1',
        }))
        if (refunds.length !== 1 || body.gross?.minor !== refunds[0].gross_minor) {
          throw new Error('Outbox event does not match the booked Stripe refund')
        }
      } else if (body.gross?.minor !== invoice.gross_minor ||
        body.fee?.currency !== invoice.currency || body.fee?.minor !== invoice.fee_minor ||
        body.net?.currency !== invoice.currency || body.net?.minor !== invoice.net_minor ||
        body.fxFee?.currency !== invoice.currency || body.fxFee?.minor !== 0) {
        throw new Error('Outbox event does not match the booked EUR invoice')
      }
    } else {
      const sales = await xpay('transactions?' + filters({
        select: 'id',
        id: 'eq.' + body.transactionId,
        seller_id: 'eq.' + event.seller_id,
        status: 'eq.approved',
        provider: 'eq.stripe',
        limit: '1',
      }))
      if (sales.length !== 1) throw new Error('Outbox event has no approved Stripe transaction')
    }

    const saleId = await orbia(refund ? 'rpc/xpay_record_stripe_refund' : 'rpc/xpay_record_sale', {
      method: 'POST',
      body: {
        p_event_key: event.event_key,
        p_seller_id: event.seller_id,
        ...(refund ? {} : { p_occurred_at: event.created_at }),
        p_body: body,
      },
    })
    if (typeof saleId !== 'string' || !/^[a-f0-9-]{36}$/i.test(saleId)) {
      throw new Error('Orbia returned no recorded sale ID')
    }
  }

  return async function runBatch(now = new Date()) {
    const events = await xpay('xpay_event_outbox?' + filters({
      select: 'id,seller_id,event_key,event_type,body,created_at,attempts',
      delivered_at: 'is.null',
      next_attempt_at: 'lte.' + now.toISOString(),
      order: 'next_attempt_at.asc,id.asc',
      limit: '15',
    }))
    let delivered = 0
    for (const event of events) {
      const attempts = Number(event.attempts)
      if (!Number.isInteger(attempts) || attempts < 0) throw new Error('Invalid retry count in XPAY outbox')
      const filter = filters({ id: 'eq.' + event.id, attempts: 'eq.' + attempts, delivered_at: 'is.null' })
      let deliveredAt = null
      try {
        await deliver(event)
        deliveredAt = new Date().toISOString()
        delivered++
      } catch (error) {
        console.warn('[xpay-orbia] pending', event.id, error.message)
      }
      const delaySeconds = Math.min(3600, 20 * 2 ** Math.min(attempts, 8))
      await xpay('xpay_event_outbox?' + filter, {
        method: 'PATCH',
        body: deliveredAt
          ? { delivered_at: deliveredAt, attempts: attempts + 1 }
          : { next_attempt_at: new Date(now.getTime() + delaySeconds * 1000).toISOString(), attempts: attempts + 1 },
      })
    }
    return delivered
  }
}

async function main() {
  const xpayKey = process.env.XPAY_SUPABASE_SERVICE_ROLE
  const orbiaKey = process.env.ORBIA_SUPABASE_SERVICE_ROLE
  if (!xpayKey || !orbiaKey || xpayKey === orbiaKey || process.env.XPAY_OUTBOX_MODE !== 'live') {
    throw new Error('XPAY-to-Orbia worker requires separate live CRM and payment credentials')
  }
  const runBatch = createDelivery({ xpayKey, orbiaKey })
  let running = true
  process.once('SIGTERM', () => { running = false })
  process.once('SIGINT', () => { running = false })
  console.log('[xpay-orbia] ready')
  while (running) {
    try {
      const delivered = await runBatch()
      if (delivered) console.log('[xpay-orbia] delivered', delivered)
    } catch (error) {
      console.error('[xpay-orbia] batch failed', error.message)
    }
    if (running) await wait(10_000)
  }
}

module.exports = { createDelivery }
if (require.main === module) main().catch(error => {
  console.error('[xpay-orbia]', error.message)
  process.exitCode = 1
})

