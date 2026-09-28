import * as crypto from 'crypto'

// Supabase falso: toda consulta à tabela de transações devolve `txRow`, e os
// updates ficam registrados para conferência.
let txRow: any = null
const updates: any[] = []
function builder() {
  const b: any = {}
  for (const m of ['select', 'eq', 'neq', 'not', 'order', 'limit', 'in']) b[m] = jest.fn(() => b)
  b.update = jest.fn((patch: any) => { updates.push(patch); return b })
  b.maybeSingle = jest.fn(async () => ({ data: txRow, error: null }))
  b.single = jest.fn(async () => ({ data: txRow, error: null }))
  b.then = (resolve: any) => resolve({ data: null, error: null })
  return b
}
jest.mock('../lib/supabase.client', () => ({ supabase: { from: jest.fn(() => builder()), rpc: jest.fn() } }))

const keys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
process.env.SLASH_WEBHOOK_PUBLIC_KEYS = keys.publicKey
process.env.SLASH_API_KEY = 'sk_test'
process.env.KOOPFY_PLATFORM_WALLET_REF = process.env.KOOPFY_PLATFORM_WALLET_REF ?? 'platform'

import { WebhookService } from './webhook.service'
import { SlashProvider } from '../orchestrator/providers/slash.provider'

function signed(event: string, entityId: string) {
  const raw = Buffer.from(JSON.stringify({ event, eventId: 'ev_1', entityId, eventTimestamp: '2026-09-28T00:00:00Z' }))
  const signature = crypto.sign('sha256', raw, keys.privateKey).toString('base64')
  return { raw, headers: { 'slash-webhook-signature': signature } }
}

describe('WebhookService.handleSlashWebhook', () => {
  let service: any
  let provider: SlashProvider

  beforeEach(() => {
    updates.length = 0
    provider = new SlashProvider()
    service = Object.create(WebhookService.prototype)
    service.router = { getProviderInstance: () => provider }
    service.handleWebhookProvider = jest.fn(async () => ({ ok: true }))
    service.refundTransaction = jest.fn(async () => ({ refunded: true }))
    txRow = {
      id: 'tx-1', provider: 'slash', status: 'pending', amount: 4990, currency: 'USD',
      provider_transaction_id: 'pi_current', metadata: {},
    }
  })

  const intent = (over: any = {}) => ({
    id: 'pi_current', status: 'succeeded', amount: 4990, currency: 'usd',
    metadata: { koopfy_transaction_id: 'tx-1' }, ...over,
  })

  it('recusa assinatura inválida com erro (a Slash reentrega)', async () => {
    const { raw } = signed('payments.payment_intent.updated', 'pi_current')
    await expect(service.handleSlashWebhook(raw, { 'slash-webhook-signature': 'AAAA' })).rejects.toThrow(/assinatura/)
  })

  it('succeeded aprova pela transação do metadata, lendo o estado no GET', async () => {
    const get = jest.spyOn(provider, 'getPaymentIntent').mockResolvedValue(intent())
    const { raw, headers } = signed('payments.payment_intent.updated', 'pi_current')
    await service.handleSlashWebhook(raw, headers)
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ id: 'slash_main' }), 'pi_current')
    expect(service.handleWebhookProvider).toHaveBeenCalledWith({ reference: 'tx-1', status: 'PAID', type: 'TRANSACTION' })
  })

  it('processing promove o pedido (payment.processing)', async () => {
    jest.spyOn(provider, 'getPaymentIntent').mockResolvedValue(intent({ status: 'processing' }))
    const { raw, headers } = signed('payments.payment_intent.updated', 'pi_current')
    await service.handleSlashWebhook(raw, headers)
    expect(service.handleWebhookProvider).toHaveBeenCalledWith({ reference: 'tx-1', status: 'PROCESSING', type: 'TRANSACTION' })
  })

  it('pending depois de processing (cartão recusado) volta a transação para pendente', async () => {
    txRow.status = 'processing'
    jest.spyOn(provider, 'getPaymentIntent').mockResolvedValue(intent({ status: 'pending' }))
    const { raw, headers } = signed('payments.payment_intent.updated', 'pi_current')
    await service.handleSlashWebhook(raw, headers)
    expect(service.handleWebhookProvider).toHaveBeenCalledWith({ reference: 'tx-1', status: 'PENDING', type: 'TRANSACTION' })
  })

  it('intent antigo do mesmo pedido: cancelamento é ignorado, pagamento aprova e vira o atual', async () => {
    jest.spyOn(provider, 'getPaymentIntent').mockResolvedValue(intent({ id: 'pi_old', status: 'canceled' }))
    const a = signed('payments.payment_intent.updated', 'pi_old')
    await expect(service.handleSlashWebhook(a.raw, a.headers)).resolves.toEqual({ ignored: true, reason: 'stale intent' })
    expect(service.handleWebhookProvider).not.toHaveBeenCalled()

    jest.spyOn(provider, 'getPaymentIntent').mockResolvedValue(intent({ id: 'pi_old', status: 'succeeded' }))
    const b = signed('payments.payment_intent.updated', 'pi_old')
    await service.handleSlashWebhook(b.raw, b.headers)
    expect(updates).toContainEqual({ provider_transaction_id: 'pi_old' })
    expect(service.handleWebhookProvider).toHaveBeenCalledWith(expect.objectContaining({ status: 'PAID' }))
  })

  it('intent sem o nosso metadata não é da Koopfy', async () => {
    txRow = null
    jest.spyOn(provider, 'getPaymentIntent').mockResolvedValue(intent({ metadata: {} }))
    const { raw, headers } = signed('payments.payment_intent.updated', 'pi_x')
    await expect(service.handleSlashWebhook(raw, headers)).resolves.toMatchObject({ ignored: true })
  })

  it('intent nosso sem transação é órfão: erro para a Slash reentregar', async () => {
    txRow = null
    jest.spyOn(provider, 'getPaymentIntent').mockResolvedValue(intent())
    const { raw, headers } = signed('payments.payment_intent.updated', 'pi_current')
    await expect(service.handleSlashWebhook(raw, headers)).rejects.toThrow(/não encontrada/)
  })

  it('reembolso total estorna; parcial só registra', async () => {
    jest.spyOn(provider, 'getPaymentIntent').mockResolvedValue(intent())
    jest.spyOn(provider, 'getRefund').mockResolvedValue({ id: 'rf_1', status: 'succeeded', amount: 1000, paymentIntentId: 'pi_current' })

    jest.spyOn(provider, 'listRefunds').mockResolvedValue([
      { id: 'rf_1', status: 'succeeded', amount: 1000 },
      { id: 'rf_0', status: 'failed', amount: 3990 },
    ])
    const a = signed('payments.refund.updated', 'rf_1')
    await expect(service.handleSlashWebhook(a.raw, a.headers)).resolves.toMatchObject({ partialRefund: true, refundedMinor: 1000 })
    expect(service.refundTransaction).not.toHaveBeenCalled()

    jest.spyOn(provider, 'listRefunds').mockResolvedValue([
      { id: 'rf_1', status: 'succeeded', amount: 1000 },
      { id: 'rf_2', status: 'succeeded', amount: 3990 },
    ])
    const b = signed('payments.refund.updated', 'rf_1')
    await service.handleSlashWebhook(b.raw, b.headers)
    expect(service.refundTransaction).toHaveBeenCalledWith('tx-1')
  })

  it('reembolso ainda pendente não mexe em nada', async () => {
    jest.spyOn(provider, 'getRefund').mockResolvedValue({ id: 'rf_1', status: 'processing', paymentIntentId: 'pi_current' })
    const { raw, headers } = signed('payments.refund.created', 'rf_1')
    await expect(service.handleSlashWebhook(raw, headers)).resolves.toMatchObject({ received: true })
    expect(service.refundTransaction).not.toHaveBeenCalled()
  })
})
