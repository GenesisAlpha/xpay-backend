import {
  BadGatewayException, BadRequestException, ConflictException,
  Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common'
import { createHash } from 'node:crypto'
import Stripe from 'stripe'
import { CryptoService } from '../crypto/crypto.service'
import { supabase } from '../lib/supabase.client'

const events: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
]
const accountColumns = 'id, label, stripe_account_id, livemode, status, publishable_key, secret_key, webhook_secret, metadata'
const liveOrigin = 'https://api.xpay.expert'

type StripePoolRow = {
  id: string
  label: string | null
  stripe_account_id: string
  livemode: boolean
  status: string
  secret_key: string
  publishable_key: string
  webhook_secret: string | null
  metadata: Record<string, unknown> | null
}

@Injectable()
export class XpayStripeAdminService {
  constructor(private readonly crypto: CryptoService) {}

  async list() {
    this.requireLiveSchema()
    const { data, error } = await supabase.from('stripe_accounts').select(accountColumns)
      .eq('livemode', true).order('label')
    if (error) throw new ServiceUnavailableException('Gestão de contas Stripe indisponível.')
    return ((data ?? []) as StripePoolRow[]).map(row => this.summary(row))
  }

  async connect(input: unknown, actorId: string) {
    this.requireLiveSchema()
    const body = (input ?? {}) as Record<string, unknown>
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    const secret = typeof body.secretKey === 'string' ? body.secretKey.trim() : ''
    const publishable = typeof body.publishableKey === 'string' ? body.publishableKey.trim() : ''
    if (!label || label.length > 100 || !/^(sk|rk)_live_[a-zA-Z0-9_]{10,300}$/.test(secret)
      || !/^pk_live_[a-zA-Z0-9_]{10,300}$/.test(publishable)) {
      throw new BadRequestException('Indica uma identificação e duas chaves Stripe live válidas.')
    }

    const stripe = new Stripe(secret, { timeout: 10_000 })
    const account = await stripe.accounts.retrieve().catch(() => {
      throw new BadRequestException('A Stripe não aceitou a chave de servidor para consultar a conta.')
    })
    if (!/^acct_[a-zA-Z0-9]+$/.test(account.id)) {
      throw new BadGatewayException('A Stripe não devolveu uma conta válida.')
    }
    const registered = await this.find(account.id)
    if (registered?.webhook_secret) {
      if (registered.publishable_key !== publishable || this.crypto.decrypt(registered.secret_key) !== secret) {
        throw new ConflictException('A conta já está ligada. Usa um processo de rotação de chaves.')
      }
      return this.summary(registered)
    }

    if (!registered) await this.verifyKeyPair(stripe, publishable)
    const id = registered?.id ?? 'xpay_live_stripe_' + createHash('sha256').update(account.id).digest('hex').slice(0, 24)
    const url = liveOrigin + '/webhook/stripe/' + id
    await this.verifyReceiver(url)
    if (!registered) {
      const { error } = await supabase.from('stripe_accounts').upsert({
        id, label, stripe_account_id: account.id, country: account.country,
        default_currency: account.default_currency?.toUpperCase() ?? 'EUR',
        livemode: true, status: 'inactive', secret_key: this.crypto.encrypt(secret),
        publishable_key: publishable, supported_methods: ['card'],
        probe_charges_enabled: account.charges_enabled, probe_payouts_enabled: account.payouts_enabled,
        statement_descriptor: account.settings?.payments?.statement_descriptor ?? null,
        metadata: { xpay_linked_by: actorId },
      }, { onConflict: 'id', ignoreDuplicates: true })
      if (error) throw new ServiceUnavailableException('A XPAY não conseguiu registar a conta.')
    }

    const row = await this.find(account.id)
    if (!row || row.id !== id) throw new ConflictException('A conta Stripe tem outro registo na XPAY.')
    if (row.publishable_key !== publishable || this.crypto.decrypt(row.secret_key) !== secret) {
      throw new ConflictException('A conta foi registada com outro par de chaves.')
    }
    if (row.webhook_secret) return this.summary(row)

    const endpoint = await this.provisionWebhook(stripe, url, id)
    const { error } = await supabase.from('stripe_accounts').update({
      webhook_secret: this.crypto.encrypt(endpoint.secret),
      metadata: { ...row.metadata, stripe_webhook_endpoint_id: endpoint.id },
    }).eq('id', id).is('webhook_secret', null)
    if (error) throw new ServiceUnavailableException('O webhook existe na Stripe. Repete a ligação para guardar a assinatura.')
    const linked = await this.find(account.id)
    if (!linked?.webhook_secret) {
      throw new ServiceUnavailableException('A XPAY ainda não confirmou a gravação da assinatura.')
    }
    return this.summary(linked)
  }

  private requireLiveSchema() {
    if (process.env.XPAY_DB_SCHEMA !== 'xpay_live') throw new NotFoundException()
  }

  private async find(accountId: string) {
    const { data, error } = await supabase.from('stripe_accounts').select(accountColumns)
      .eq('stripe_account_id', accountId).eq('livemode', true).maybeSingle()
    if (error) throw new ServiceUnavailableException('Não foi possível consultar o registo da conta Stripe.')
    return data as StripePoolRow | null
  }

  private summary(row: StripePoolRow) {
    return {
      id: row.id, label: row.label, stripeAccountId: row.stripe_account_id,
      livemode: row.livemode, status: row.status, webhookConfigured: Boolean(row.webhook_secret),
      webhookEndpointId: row.metadata?.stripe_webhook_endpoint_id ?? null,
      webhookUrl: liveOrigin + '/webhook/stripe/' + row.id,
    }
  }

  private async verifyKeyPair(stripe: Stripe, publishableKey: string) {
    try {
      const setup = await stripe.setupIntents.create({ automatic_payment_methods: { enabled: true } })
      try {
        if (!setup.client_secret) throw new Error('SetupIntent has no client secret')
        const pkStripe = new Stripe(publishableKey, { timeout: 10_000 })
        const verified = await pkStripe.setupIntents.retrieve(setup.id, { client_secret: setup.client_secret })
        if (verified.id !== setup.id || !verified.livemode) throw new Error('Different Stripe account')
      } finally {
        await stripe.setupIntents.cancel(setup.id)
      }
    } catch {
      throw new BadRequestException('Não foi possível validar que as duas chaves pertencem à mesma conta Stripe. Confere as chaves e as permissões de Setup Intents.')
    }
  }

  private async verifyReceiver(url: string) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      redirect: 'error', signal: AbortSignal.timeout(8000),
    }).catch(() => null)
    if (response?.status !== 400 || await response.text() !== 'Bad Request') {
      throw new ServiceUnavailableException('A rota de webhook da XPAY ainda não está pronta para esta conta.')
    }
  }

  private async provisionWebhook(stripe: Stripe, url: string, id: string) {
    try {
      const idempotencyKey = 'xpay-stripe-webhook-v1-' + id
      let previous: Stripe.WebhookEndpoint | undefined
      for await (const endpoint of stripe.webhookEndpoints.list({ limit: 100 })) {
        if (endpoint.url !== url) continue
        if (previous || endpoint.metadata?.xpay_account_id !== id
          || Date.now() - endpoint.created * 1000 >= 23 * 60 * 60 * 1000) {
          throw new ConflictException('Já existe um webhook para esta rota. Confere o registo na Stripe antes de criar outro.')
        }
        previous = endpoint
      }
      const endpoint = await stripe.webhookEndpoints.create({
        url, enabled_events: events, description: 'XPAY payments',
        metadata: { xpay_account_id: id },
      }, { idempotencyKey })
      if (!endpoint.livemode || endpoint.url !== url || endpoint.status !== 'enabled'
        || (previous && endpoint.id !== previous.id) || !endpoint.secret?.startsWith('whsec_')) {
        throw new ConflictException('A Stripe não devolveu uma assinatura válida para o webhook esperado.')
      }
      return { id: endpoint.id, secret: endpoint.secret }
    } catch (error) {
      if (error instanceof ConflictException) throw error
      throw new BadGatewayException('A Stripe não conseguiu registar o webhook. Confere a autorização de escrita da chave.')
    }
  }
}
