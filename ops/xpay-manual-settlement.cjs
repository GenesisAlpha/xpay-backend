const { createHmac, timingSafeEqual } = require('node:crypto')
const { createServer } = require('node:http')

const pageSize = 30
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function authorize(value, method, bridge, now = Math.floor(Date.now() / 1000)) {
  if (typeof value !== 'string' || !value.startsWith('Bearer ') || value.length > 2048) return null
  const token = value.slice(7).split('.')
  if (token.length !== 3 || token.some(part => !/^[a-zA-Z0-9_-]+$/.test(part))) return null
  const [header, body, signed] = token
  const signature = Buffer.from(signed, 'base64url')
  const expected = createHmac('sha256', bridge).update(header + '.' + body).digest()
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null
  try {
    const metadata = JSON.parse(Buffer.from(header, 'base64url'))
    const claims = JSON.parse(Buffer.from(body, 'base64url'))
    if (metadata.alg !== 'HS256' || metadata.crit || claims.iss !== 'orbia-crm' || claims.aud !== 'xpay-settlement-admin' ||
        !uuid.test(claims.sub ?? '') || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
        claims.exp <= now || claims.exp > now + 60 || claims.iat > now + 2 ||
        claims.exp <= claims.iat || claims.exp - claims.iat > 60 ||
        (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now))) return null
    if (claims.scope === 'settlement:manage' || (method === 'GET' && claims.scope === 'settlement:read')) return claims.sub
  } catch {
    return null
  }
  return null
}

function database(credential) {
  return async (path, params, body) => {
    const url = new URL('/rest/v1/' + path, 'https://oxbvwceiegagekfrfarg.supabase.co')
    url.search = new URLSearchParams(params).toString()
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        apikey: credential, Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json',
        'Accept-Profile': 'xpay_live', 'Content-Profile': 'xpay_live',
      },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(12_000), redirect: 'error',
    })
    const result = await response.json().catch(() => null)
    if (!response.ok) throw Object.assign(new Error('Settlement data API HTTP ' + response.status), { code: result?.code })
    return result
  }
}

function page(value) {
  if (value === null) return 0
  if (!/^\d{1,6}$/.test(value)) throw new Error('invalid pagination')
  return Number(value)
}

function todayInLisbon() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Lisbon', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date())
  const field = type => parts.find(part => part.type === type)?.value
  return [field('year'), field('month'), field('day')].join('-')
}

async function readPage(db, params) {
  const queuePage = page(params.get('queue'))
  const historyPage = page(params.get('history'))
  const [queue, history] = await Promise.all([
    db('xpay_manual_settlement_queue', {
      status: 'neq.paid', order: 'dispatch_window_at.asc.nullslast,paid_at.asc,invoice_id.asc',
      limit: pageSize + 1, offset: queuePage * pageSize,
    }),
    db('xpay_manual_settlement_history', {
      order: 'recorded_at.desc,id.desc', limit: pageSize + 1, offset: historyPage * pageSize,
    }),
  ])
  return {
    queue: queue.slice(0, pageSize), moreQueue: queue.length > pageSize,
    history: history.slice(0, pageSize), moreHistory: history.length > pageSize,
    today: todayInLisbon(),
  }
}

async function write(db, actor, body) {
  if (body?.action === 'book' && uuid.test(body.requestId ?? '') &&
      typeof body.reference === 'string' && body.reference.trim().length > 0 && body.reference.trim().length <= 120 &&
      typeof body.paymentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.paymentDate) &&
      Number.isSafeInteger(body.amountMinor) && body.amountMinor > 0 &&
      Array.isArray(body.invoiceIds) && body.invoiceIds.length > 0 && body.invoiceIds.length <= 100 &&
      body.invoiceIds.every(value => typeof value === 'string' && /^in_[a-zA-Z0-9]{1,125}$/.test(value))) {
    return db('rpc/xpay_book_manual_settlement', {}, {
      p_request_id: body.requestId, p_actor: actor, p_invoice_ids: body.invoiceIds,
      p_amount_minor: body.amountMinor, p_payment_date: body.paymentDate, p_reference: body.reference,
    })
  }
  if (body?.action === 'reverse' && uuid.test(body.settlementId ?? '') && typeof body.reason === 'string' &&
      body.reason.trim().length >= 4 && body.reason.trim().length <= 500) {
    return db('rpc/xpay_reverse_manual_settlement', {}, {
      p_id: body.settlementId, p_actor: actor, p_reason: body.reason,
    })
  }
  throw Object.assign(new Error('Invalid settlement details'), { code: '22023' })
}

function createService(db, bridge) {
  return createServer(async (req, res) => {
    const json = (status, payload) => res.writeHead(status, {
      'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8',
    }).end(JSON.stringify(payload))
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { return json(400, { error: 'invalid_fields' }) }
    if (url.pathname !== '/settlements' || !['GET', 'POST'].includes(req.method)) return json(404, { error: 'not_found' })
    const actor = authorize(req.headers.authorization, req.method, bridge)
    if (!actor) return json(401, { error: 'unauthorized' })
    try {
      if (req.method === 'GET') return json(200, await readPage(db, url.searchParams))
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 32_768) return json(413, { error: 'request_too_large' })
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks)) } catch { return json(400, { error: 'invalid_fields' }) }
      const id = await write(db, actor, body)
      if (!uuid.test(id ?? '')) throw new Error('Invalid settlement receipt')
      return json(200, { id })
    } catch (error) {
      if (error.code === '23505') return json(409, { error: 'duplicate' })
      if (error.code === '23514') return json(422, { error: 'ineligible_or_mismatched' })
      if (['22023', '22007', '22008'].includes(error.code) || error.message === 'invalid pagination') {
        return json(400, { error: 'invalid_fields' })
      }
      console.error('[xpay-settlement]', error.message)
      return json(503, { error: 'unavailable' })
    }
  })
}

if (require.main === module) {
  const bridge = process.env.XPAY_STRIPE_ADMIN_BRIDGE_KEY
  const secret = process.env.XPAY_SUPABASE_SERVICE_ROLE
  if (!bridge || bridge.length < 32 || !secret) throw new Error('Missing settlement service configuration')
  createService(database(secret), bridge).listen(3009, '0.0.0.0', () => console.log('[xpay-settlement] ready'))
}
module.exports = { authorize, createService }
