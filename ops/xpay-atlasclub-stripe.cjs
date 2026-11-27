const { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } = require('node:crypto')
const { createServer } = require('node:http')

const offerId = 'xpay_atlasclub_mvp'
const stripeVersion = '2026-11-18.endive'
const route = '/webhook/stripe/atlasclub'
const endpointUrl = 'https://api.xpay.expert' + route
const metadataKey = 'atlasclub_subscription_webhook'
const stripeEvents = new Set([
  'invoice.paid', 'refund.created', 'refund.updated', 'charge.refunded',
  'charge.updated', 'charge.dispute.created',
])

function objectId(value, prefix) {
  const id = typeof value === 'string' ? value : value?.id
  return typeof id === 'string' && new RegExp('^' + prefix + '_[a-zA-Z0-9]{1,125}$').test(id) ? id : null
}

function verify(raw, signature, secret, now = Date.now()) {
  if (typeof signature !== 'string' || signature.length > 2048) return false
  const fields = signature.split(',').map(part => part.trim().split('=', 2))
  const timestamps = fields.filter(([key]) => key === 't')
  const timestamp = timestamps[0]?.[1]
  if (timestamps.length !== 1 || !/^\d{1,12}$/.test(timestamp ?? '') ||
      Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300) return false
  const expected = createHmac('sha256', secret).update(timestamp + '.').update(raw).digest()
  return fields.some(([key, value]) => key === 'v1' && /^[0-9a-f]{64}$/i.test(value ?? '') &&
    timingSafeEqual(expected, Buffer.from(value, 'hex')))
}

function stripeApi(secret) {
  return async (path, query = {}, form) => {
    const url = new URL('https://api.stripe.com/v1/' + path)
    url.search = new URLSearchParams(query).toString()
    const headers = { Authorization: 'Bearer ' + secret, 'Stripe-Version': stripeVersion }
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const response = await fetch(url, {
      headers, method: form ? 'POST' : 'GET', body: form && new URLSearchParams(form),
      redirect: 'error', signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) throw new Error('Stripe API HTTP ' + response.status)
    return response.json()
  }
}

function bookingApi(origin, secret, schema) {
  return async (payment, refunds) => {
    const response = await fetch(new URL('/rest/v1/rpc/xpay_sync_stripe_subscription', origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: {
        apikey: secret, Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json',
        'Content-Profile': schema,
      },
      body: JSON.stringify({ p_payment: payment, p_refunds: refunds }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      const code = typeof body?.code === 'string' && /^[0-9A-Z]{5}$/.test(body.code) ? ' ' + body.code : ''
      throw new Error('Booking API HTTP ' + response.status + code)
    }
    const ref = await response.json()
    if (ref !== 'stripe-invoice:' + payment.invoice_id) throw new Error('Unexpected booking receipt')
    return ref
  }
}

function liveWebhookConfig(supabaseKey, accountId, stripeAccountId) {
  const encoded = process.env.CRYPTO_MASTER_KEY
  if (!/^[0-9a-f]{64}$/i.test(encoded ?? '')) throw new Error('Stripe vault encryption key unavailable')
  const key = Buffer.from(encoded, 'hex')
  const purpose = Buffer.from('xpay:stripe:atlasclub:' + stripeAccountId)
  const url = new URL('https://oxbvwceiegagekfrfarg.supabase.co/rest/v1/stripe_accounts')
  url.search = new URLSearchParams({ id: 'eq.' + accountId, stripe_account_id: 'eq.' + stripeAccountId,
    livemode: 'eq.true', select: 'metadata,updated_at' }).toString()
  const headers = {
    apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey, 'Content-Type': 'application/json',
    'Content-Profile': 'xpay_live', 'Accept-Profile': 'xpay_live', Prefer: 'return=representation',
  }
  async function request(method, target, body) {
    const r = await fetch(target, { method, headers, body: body && JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(12_000) })
    if (!r.ok) throw new Error('Stripe vault HTTP ' + r.status)
    return r.json()
  }
  async function read() {
    const rows = await request('GET', url)
    if (rows.length !== 1) throw new Error('Stripe vault account is not unique')
    return rows[0]
  }
  function open(entry) {
    if (!objectId(entry?.endpointId, 'we') || !/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i.test(entry?.cipher ?? '')) {
      throw new Error('Invalid AtlasClub webhook vault entry')
    }
    const [iv, tag, encrypted] = entry.cipher.split(':').map(field => Buffer.from(field, 'hex'))
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(purpose)
    decipher.setAuthTag(tag)
    const secret = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    if (!secret.startsWith('whsec_')) throw new Error('Invalid AtlasClub webhook signing key')
    return secret
  }
  async function save(account, endpoint) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(purpose)
    const encrypted = Buffer.concat([cipher.update(endpoint.secret, 'utf8'), cipher.final()])
    const entry = { endpointId: endpoint.id, cipher: [iv, cipher.getAuthTag(), encrypted].map(v => v.toString('hex')).join(':') }
    const target = new URL(url)
    target.searchParams.set('updated_at', 'eq.' + account.updated_at)
    const body = { metadata: { ...(account.metadata ?? {}), [metadataKey]: entry }, updated_at: new Date().toISOString() }
    const rows = await request('PATCH', target, body)
    if (rows.length !== 1 || rows[0].metadata?.[metadataKey]?.endpointId !== endpoint.id) {
      throw new Error('AtlasClub webhook vault was changed concurrently')
    }
    return open(rows[0].metadata[metadataKey])
  }
  return { open, read, save }
}

async function ensureWebhook({ stripe, vault, key }) {
  const account = await vault.read()
  const entry = account.metadata?.[metadataKey]
  if (entry) {
    const existing = await stripe('webhook_endpoints/' + entry.endpointId)
    if (existing.url !== endpointUrl || existing.status !== 'enabled' ||
        existing.livemode !== true || ![...stripeEvents].every(type => existing.enabled_events?.includes(type))) {
      throw new Error('Existing AtlasClub webhook differs from runtime configuration')
    }
    return { endpointId: existing.id, secret: vault.open(entry) }
  }
  const inventory = await stripe('webhook_endpoints', { limit: '100' })
  if (inventory.has_more || inventory.data.some(hook => hook.url === endpointUrl)) {
    throw new Error('Stripe endpoint already exists or inventory is incomplete')
  }
  const enabled = Object.fromEntries([...stripeEvents].map((type, i) => ['enabled_events[' + i + ']', type]))
  const endpoint = await stripe('webhook_endpoints', {}, {
    url: endpointUrl, api_version: stripeVersion, description: 'XPAY AtlasClub billing',
    'metadata[purpose]': 'xpay_atlasclub_subscription', ...enabled,
  })
  if (!objectId(endpoint.id, 'we') || endpoint.livemode !== true || !endpoint.secret?.startsWith('whsec_')) {
    throw new Error('Stripe did not return a live AtlasClub webhook')
  }
  try {
    return { endpointId: endpoint.id, secret: await vault.save(account, endpoint) }
  } catch (error) {
    const confirmed = await vault.read().catch(() => null)
    if (confirmed?.metadata?.[metadataKey]?.endpointId === endpoint.id) {
      return { endpointId: endpoint.id, secret: vault.open(confirmed.metadata[metadataKey]) }
    }
    if (confirmed) {
      await fetch('https://api.stripe.com/v1/webhook_endpoints/' + endpoint.id, {
        method: 'DELETE', headers: { Authorization: 'Bearer ' + key, 'Stripe-Version': stripeVersion },
        signal: AbortSignal.timeout(12_000),
      }).catch(() => null)
    }
    throw error
  }
}

function createBilling({ stripe, book, live, priceId, accountId, stripeAccountId }) {
  async function invoiceForPayment(paymentIntent) {
    if (!paymentIntent) return null
    const list = await stripe('invoice_payments', {
      'payment[type]': 'payment_intent', 'payment[payment_intent]': paymentIntent, status: 'paid', limit: '2',
    })
    if (list.has_more || list.data.length > 1) throw new Error('Payment matches multiple paid invoices')
    return objectId(list.data[0]?.invoice, 'in')
  }

  async function chargeForEvent(object) {
    const directIntent = objectId(object.payment_intent, 'pi')
    if (directIntent) return directIntent
    const charge = objectId(object.charge, 'ch')
    if (!charge) return null
    return objectId((await stripe('charges/' + charge)).payment_intent, 'pi')
  }

  async function process(event) {
    if (event.livemode !== live || (event.account && event.account !== stripeAccountId)) throw new Error('Wrong Stripe account or mode')
    if (!stripeEvents.has(event.type)) return null
    const first = event.data?.object
    if (!first) throw new Error('Missing Stripe event object')
    const forceDispute = event.type === 'charge.dispute.created'
    const invoiceId = event.type === 'invoice.paid' ? objectId(first.id, 'in') : await invoiceForPayment(await chargeForEvent(first))
    if (!invoiceId) return null

    const invoice = await stripe('invoices/' + invoiceId)
    const subscription = invoice.parent?.subscription_details
    if (subscription?.metadata?.xpay_offer_id !== offerId) return null
    const subscriptionId = objectId(subscription.subscription, 'sub')
    if (invoice.id !== invoiceId || invoice.livemode !== live || !subscriptionId ||
        invoice.status !== 'paid' || invoice.currency !== 'eur' ||
        !['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason) ||
        !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid <= 0 || invoice.amount_paid !== invoice.total) {
      throw new Error('Pilot invoice is not a standard paid EUR billing period')
    }

    const [lines, payments] = await Promise.all([
      stripe('invoices/' + invoiceId + '/lines', { limit: '2' }),
      stripe('invoice_payments', { invoice: invoiceId, status: 'paid', limit: '2' }),
    ])
    const line = lines.data[0]
    const details = line?.parent?.subscription_item_details
    const payment = payments.data[0]
    const paymentIntentId = objectId(payment?.payment?.payment_intent, 'pi')
    const paidAt = payment?.status_transitions?.paid_at
    if (lines.has_more || lines.data.length !== 1 || line?.amount !== invoice.amount_paid ||
        line.currency !== 'eur' || line.quantity !== 1 || line.pricing?.price_details?.price !== priceId ||
        !details || details.proration || objectId(details.subscription, 'sub') !== subscriptionId ||
        payments.has_more || payments.data.length !== 1 || payment?.payment?.type !== 'payment_intent' ||
        payment?.livemode !== live || payment?.amount_paid !== invoice.amount_paid || payment?.currency !== 'eur' ||
        !paymentIntentId || !Number.isSafeInteger(paidAt) || paidAt <= 0) {
      throw new Error('Pilot invoice line or payment allocation does not match')
    }

    const [intent, refunds] = await Promise.all([
      stripe('payment_intents/' + paymentIntentId, { 'expand[0]': 'latest_charge.balance_transaction' }),
      stripe('refunds', { payment_intent: paymentIntentId, limit: '100' }),
    ])
    const charge = intent.latest_charge
    const chargeId = objectId(charge, 'ch')
    if (intent.id !== paymentIntentId || intent.livemode !== live || intent.currency !== 'eur' ||
        intent.status !== 'succeeded' || intent.amount_received !== invoice.amount_paid ||
        !chargeId || charge?.captured !== true || charge?.paid !== true || charge.currency !== 'eur' ||
        charge.amount_captured !== invoice.amount_paid || refunds.has_more) {
      throw new Error('Pilot charge has not been reconciled')
    }
    const refunded = refunds.data.filter(item => item.status === 'succeeded').map(item => {
      const refundId = objectId(item.id, 're')
      if (!refundId || item.currency !== 'eur' || objectId(item.payment_intent, 'pi') !== paymentIntentId ||
          objectId(item.charge, 'ch') !== chargeId || !Number.isSafeInteger(item.amount) || item.amount <= 0) {
        throw new Error('Pilot refund does not match its charge')
      }
      return { refund_id: refundId, gross_minor: item.amount }
    })

    const rawBalance = charge.balance_transaction
    const balance = objectId(rawBalance, 'txn') && typeof rawBalance === 'object' ? {
      id: rawBalance.id, currency: rawBalance.currency?.toUpperCase(), gross_minor: rawBalance.amount,
      fee_minor: rawBalance.fee, net_minor: rawBalance.net, available_on: rawBalance.available_on,
      status: rawBalance.status, exchange_rate: rawBalance.exchange_rate,
    } : null
    return book({
      offer_id: offerId, provider_account_id: accountId, stripe_account_id: stripeAccountId,
      price_id: priceId, invoice_id: invoiceId, subscription_id: subscriptionId,
      payment_intent_id: paymentIntentId, charge_id: chargeId, gross_minor: invoice.amount_paid,
      currency: 'EUR', paid_at: new Date(paidAt * 1000).toISOString(),
      stripe_balance: balance, disputed: forceDispute || charge.disputed === true,
    }, refunded)
  }
  return { process }
}

function httpServer(billing, secret) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'GET' && req.url === '/health') return res.writeHead(200).end('ok')
    if (req.method !== 'POST' || req.url !== route) return res.writeHead(404).end()
    if (!req.headers['stripe-signature']) return res.writeHead(400).end()
    const chunks = []
    let size = 0
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > 512 * 1024) return res.writeHead(413).end()
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks)
      if (!verify(body, req.headers['stripe-signature'], secret)) return res.writeHead(400).end()
      let payload
      try { payload = JSON.parse(body) } catch { return res.writeHead(400).end() }
      await billing.process(payload)
      return res.writeHead(200).end('ok')
    } catch (error) {
      console.error('[atlasclub-stripe]', error.message)
      return res.writeHead(503).end()
    }
  })
}

async function main() {
  const key = process.env.XPAY_STRIPE_KEY ?? ''
  let webhook = process.env.XPAY_STRIPE_WEBHOOK_SECRET ?? ''
  const priceId = process.env.XPAY_STRIPE_PRICE_ID
  const accountId = process.env.XPAY_STRIPE_PROVIDER_ID
  const stripeAccountId = process.env.XPAY_STRIPE_ACCOUNT
  const supabaseKey = process.env.XPAY_SUPABASE_SERVICE_ROLE
  const live = process.env.XPAY_STRIPE_MODE === 'live'
  if ((!live && process.env.XPAY_STRIPE_MODE !== 'sandbox') ||
      !new RegExp('^[sr]k_' + (live ? 'live' : 'test') + '_').test(key) ||
      !objectId(priceId, 'price') || !objectId(stripeAccountId, 'acct') ||
      !accountId || !supabaseKey) throw new Error('Missing Stripe billing configuration')
  const stripe = stripeApi(key)
  const account = await stripe('account')
  if (account.id !== stripeAccountId) throw new Error('Stripe key belongs to another account')
  if (live && process.argv[2] === '--inspect-eur-destination') {
    const bankAccounts = await stripe('accounts/' + stripeAccountId + '/external_accounts', { object: 'bank_account', limit: '100' })
      .catch(() => null)
    const norm = value => String(value ?? '').trim().replace(/[. ]/g, '').toUpperCase()
    const matches = bankAccounts?.data?.filter(bank => bank.currency === 'eur' && norm(bank.account_holder_name) === 'MGJEXPERTLTD')
    console.log(JSON.stringify({
      platformCompanyMatches: norm(account.company?.name) === 'MGJEXPERTLTD', platformPayoutsEnabled: account.payouts_enabled,
      platformDefaultCurrency: account.default_currency, bankInventoryReadable: Boolean(bankAccounts),
      matchingEurBankDestinations: matches?.length, completeInventory: bankAccounts?.has_more === false,
    }))
    return
  }
  if (live) {
    const vault = liveWebhookConfig(supabaseKey, accountId, stripeAccountId)
    if (process.argv[2] === '--provision-webhook') {
      const result = await ensureWebhook({ stripe, vault, key })
      console.log(JSON.stringify({ stripeEndpoint: result.endpointId, encrypted: true }))
      return
    }
    webhook = vault.open((await vault.read()).metadata?.[metadataKey])
  }
  if (!webhook.startsWith('whsec_')) throw new Error('Missing Stripe webhook signing key')
  if (live && process.argv[2] === '--probe-webhook') {
    const body = JSON.stringify({ type: 'ping', livemode: true, data: { object: {} } })
    const timestamp = Math.floor(Date.now() / 1000)
    const digest = createHmac('sha256', webhook).update(timestamp + '.' + body).digest('hex')
    const send = signature => fetch(endpointUrl, {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...signature && { 'Stripe-Signature': signature } },
    })
    const [unsigned, signed] = await Promise.all([send(), send('t=' + timestamp + ',v1=' + digest)])
    console.log(JSON.stringify({ unsigned: unsigned.status, signed: signed.status }))
    if (unsigned.status !== 400 || signed.status !== 200) throw new Error('AtlasClub webhook signature gate mismatch')
    return
  }
  const book = bookingApi('https://oxbvwceiegagekfrfarg.supabase.co', supabaseKey, live ? 'xpay_live' : 'xpay_billing_sandbox')
  const billing = createBilling({ stripe, book, live, priceId, accountId, stripeAccountId })
  httpServer(billing, webhook).listen(3008, '0.0.0.0', () => console.log('[atlasclub-stripe] ready'))
}

module.exports = { createBilling, httpServer, stripeApi, verify, stripeVersion }
if (require.main === module) main().catch(error => {
  console.error('[atlasclub-stripe]', error.message)
  process.exitCode = 1
})
