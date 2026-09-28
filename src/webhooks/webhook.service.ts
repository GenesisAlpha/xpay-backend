// nexor/src/webhooks/webhook.service.ts

import { SellerBillingService } from '../seller-billing/seller-billing.service'
import { whopDeclineCode } from '../orchestrator/providers/whop.provider'
import { whopCardOf } from './whop-card'
import { isWhopInitiatedRefund, refundFeeCents } from './refund-fee'
import { Injectable, Optional } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { WalletService } from '../wallets/wallet.service'
import { AccountRouterService } from '../orchestrator/router/account-router.service'
import { getProviderAccountById } from '../orchestrator/provider-accounts.config'
import { RoxPayProvider } from '../orchestrator/providers/rox-pay.provider'
import { WhopAccountsService } from '../orchestrator/whop/whop-accounts.service'
import { isLinkedProviderAccountId } from '../orchestrator/whop/whop-linked'
import {
  fromPaypalValue,
  isOwnProviderAccountId,
  isPaypalOwnAccountId,
  isStripeOwnAccountId,
  isWhopExtraAccountId,
  toPaypalValue,
} from '../orchestrator/seller-provider/seller-provider-accounts'
import { SellerProviderAccountsService } from '../orchestrator/seller-provider/seller-provider-accounts.service'
import { StripeAccountsService } from '../orchestrator/stripe/stripe-accounts.service'
import { StripeRiskService } from '../orchestrator/stripe/stripe-risk.service'
import { StripeEfwService } from '../orchestrator/stripe/stripe-efw.service'
import { AffiliateRiskService } from '../orchestrator/stripe/affiliate-risk.service'
import { CurrencyService } from '../currency/currency.service'
import { getEffectiveSellerFees } from '../shared/fee.calculator'
import {
  isWhopRenewalPayment,
  renewalEconomics,
  renewalMetadata,
  whopPaymentAmountMinor,
  whopPaymentId,
} from './whop-renewal'
import * as crypto from 'crypto'
import { WhopPayoutWebhookService } from '../payouts/whop-payout-webhook.service'

// Status do Sentinel Gate → status canônico do handleWebhookProvider.
const SENTINEL_WEBHOOK_STATUS: Record<string, 'PAID' | 'PENDING' | 'FAILED' | 'PROCESSING'> = {
  captured: 'PAID',
  // Cliente iniciou o pagamento (inseriu os dados) → promove awaiting_payment →
  // pending no checkout (aparece no painel + conta). Ainda NÃO é venda.
  sale_in_progress: 'PROCESSING',
  pending: 'PENDING',
  processing: 'PENDING',
  failed: 'FAILED',
  expired: 'FAILED',
  // 'refunded' tratado à parte (estorno) — TODO quando houver fluxo de refund.
}

// Status/evento da Coinflow → status canônico. ⚠️ Os nomes exatos dos eventos
// dependem da doc de webhooks da Coinflow — ajustar quando confirmado.
const COINFLOW_WEBHOOK_STATUS: Record<string, 'PAID' | 'PENDING' | 'FAILED'> = {
  settled: 'PAID',
  succeeded: 'PAID',
  completed: 'PAID',
  paid: 'PAID',
  pending: 'PENDING',
  processing: 'PENDING',
  created: 'PENDING',
  failed: 'FAILED',
  declined: 'FAILED',
  canceled: 'FAILED',
  cancelled: 'FAILED',
}

// Status.Description da Rox Pay (GET /transactions/{id}) → status canônico.
// Nomes vistos na doc (GET /webhooks/event/type): Success, Settled, Declined,
// Cancelled. Os demais (Initialized/Authorized/Pending/Refunded) são defensivos
// — ajustar se a Rox confirmar nomenclatura diferente em produção.
const ROX_PAY_STATUS_MAP: Record<string, 'PAID' | 'PENDING' | 'FAILED' | 'PROCESSING' | 'REFUNDED'> = {
  success: 'PAID',
  settled: 'PAID',
  authorized: 'PROCESSING',
  initialized: 'PENDING',
  pending: 'PENDING',
  processing: 'PROCESSING',
  declined: 'FAILED',
  failed: 'FAILED',
  cancelled: 'FAILED',
  canceled: 'FAILED',
  refunded: 'REFUNDED',
}

// Evento da Whop → status canônico do handleWebhookProvider.
// Lista completa em docs.whop.com/api-reference/webhooks/webhook.
const WHOP_EVENT_STATUS: Record<string, 'PAID' | 'PENDING' | 'FAILED' | 'REFUNDED'> = {
  'payment.succeeded': 'PAID',
  'payment.pending': 'PENDING',
  'payment.created': 'PENDING',
  'payment.failed': 'FAILED',
  'refund.created': 'REFUNDED',
}

// Tolerância do timestamp da assinatura (Standard Webhooks). Fora dela, o
// evento é recusado — é o que impede replay de um payload legítimo capturado.
const WHOP_SIGNATURE_TOLERANCE_S = 5 * 60

// Evento da Stripe → status canônico do handleWebhookProvider.
//
// A fonte da verdade é o PaymentIntent, não o Charge: um intent pode ter várias
// tentativas de charge e só a última importa. `charge.succeeded` fica de fora
// de propósito — ele chega ANTES de payment_intent.succeeded e aprovaria o
// pedido antes de a Stripe ter terminado de decidir.
const STRIPE_EVENT_STATUS: Record<string, 'PAID' | 'PENDING' | 'FAILED' | 'REFUNDED'> = {
  'payment_intent.succeeded': 'PAID',
  'payment_intent.processing': 'PENDING',
  'payment_intent.payment_failed': 'FAILED',
  'payment_intent.canceled': 'FAILED',
  'charge.refunded': 'REFUNDED',
}

// Eventos que NÃO mexem em transação — alimentam o governador de risco.
// São eles que fazem a quarentena automática existir; ignorá-los reduz o pool a
// um balanceador de carga cego.
const STRIPE_RISK_EVENTS = new Set([
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'radar.early_fraud_warning.created',
  'review.opened',
  'review.closed',
  'payout.failed',
  'account.updated',
])

// Tolerância do timestamp da assinatura da Stripe. O default do SDK é 300s.
const STRIPE_SIGNATURE_TOLERANCE_S = 5 * 60

// Espelho dos Sets de StripeProvider.toStripeAmount — usados para DESFAZER a
// conversão ao conferir o valor que voltou no webhook. Duplicados de propósito:
// importar o provider aqui puxaria o SDK da Stripe para dentro do webhook, que
// precisa funcionar mesmo com a chave da conta revogada. Se mexer num, mexa no
// outro — a divergência aparece como alerta de valor errado em toda venda.
const STRIPE_ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
])
const STRIPE_THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND'])

@Injectable()
export class WebhookService {

  constructor(
    private readonly walletService: WalletService,
    private readonly router: AccountRouterService,
    private readonly whopAccounts: WhopAccountsService,
    private readonly stripeAccounts: StripeAccountsService,
    private readonly stripeRisk: StripeRiskService,
    private readonly stripeEfw: StripeEfwService,
    private readonly affiliateRisk: AffiliateRiskService,
    private readonly currencyService: CurrencyService,
    private readonly payoutHandler: WhopPayoutWebhookService,
    private readonly sellerBilling: SellerBillingService,
    // PayPal do próprio seller: resolve a conta 'paypall_…' e verifica a
    // assinatura do evento com a credencial dela.
    @Optional() private readonly sellerProviders?: SellerProviderAccountsService,
  ) { }

  // opts.skipDispatch: pula o postback ao seller (usado na aprovação SÍNCRONA do
  // provider 'simulator', onde o checkout marca o pedido pago por outro caminho).
  async handleWebhookProvider(body: any, opts: { skipDispatch?: boolean } = {}) {

    console.log(body);

    const transactionId = body?.reference
      ?? body.data?.reference
      ?? null

    const status = body.status
      ?? body.data?.status
      ?? null

    const type = body.type
      ?? body.data?.type
      ?? null


    if (!transactionId) {
      console.warn('[WebhookService] transactionId inválido:', transactionId)
      return { ignored: true, reason: 'invalid transactionId' }
    }

    const { data: tx } = await supabase
      .from('transactions').select('*').eq('id', transactionId).single()

    if (!tx) throw new Error('Transaction not found')

    if (tx.status === 'approved') return { alreadyProcessed: true }

    const now = new Date().toISOString()

    // ── Pagamento aprovado ────────────────────────────────────────────────
    if (status === 'PAID' && type === 'TRANSACTION') {

      const { data: approvedRows, error: updateError } = await supabase
        .from('transactions')
        .update({
          status: 'approved',
          provider_status: 'completed',
          approved_at: now,
          processed_at: now,
          webhook_sent: true,
          last_webhook_at: now,
          updated_at: new Date(),
        })
        .eq('id', tx.id)
        .neq('status', 'approved')
        .select()

      if (updateError) {
        console.error('[WebhookService] update approved error:', updateError)
        throw updateError
      }

      // Duas entregas do mesmo evento (a Whop reenvia) passam juntas pelo
      // `tx.status === 'approved'` lá em cima. Só quem trocou o status segue:
      // sem isso, a carteira era creditada e o postback saía duas vezes, e o
      // checkout criava dois pedidos na Shopify.
      if (!approvedRows?.length) return { alreadyProcessed: true }

      // ── Side effects ─────────────────────────────────────────────────

      // 1) Crédito pendente na wallet (com external_fee se houver)
      //
      // Conta PRÓPRIA do seller (Whop, Stripe ou PayPal dele): o dinheiro
      // entrou na conta DELE. Creditar aqui criaria saldo que a Koopfy não tem
      // como pagar no saque.
      if (isOwnProviderAccountId(tx.provider_account_id)) {
        console.log(
          `[WebhookService] venda ${tx.id} na conta do próprio seller `
          + `(${tx.provider_account_id}) — sem crédito na carteira da Koopfy.`,
        )
      } else {
      await this.walletService.creditPending({
        sellerId: tx.seller_id,
        transactionId: tx.id,
        amount: tx.net_amount,
        fee: tx.fee,
        reserveAmount: tx.reserve_amount,
        availableAt: tx.available_at,
        reserveUntil: tx.reserve_until,
        externalFee: tx.external_fee_cents
          ? { amount: tx.external_fee_cents, recipientId: tx.external_fee_recipient_id }
          : null,
        // 🔥 NOVO
        platformFee: tx.fee > 0 && tx.platform_partner
          ? {
            amount: tx.fee,
            walletRef: tx.platform_partner === 'koopfy'
              ? process.env.KOOPFY_PLATFORM_WALLET_REF!
              : process.env.NEXOR_PLATFORM_WALLET_REF!,
            partner: tx.platform_partner,
          }
          : null,
      })
      }

      // 2) Contabiliza volume PAGO no router
      if (tx.provider_account_id) {
        const volumeForRouting =
          tx.amount_usd_net_cents
          ?? tx.net_amount
          ?? tx.amount
          ?? 0

        if (volumeForRouting > 0) {
          this.router.markPaid(tx.provider_account_id, volumeForRouting)
            .catch(err => console.error('[WebhookService] markPaid error:', err))
        }
      } else {
        console.warn(
          '[WebhookService] tx sem provider_account_id, pulando markPaid:',
          tx.id,
        )
      }

      // 3) KPI de aprovação (seller principal)
      const { error: kpiError } = await supabase.rpc('increment_kpi_safe', {
        p_seller_id: tx.seller_id,
        p_amount: tx.amount_usd_net_cents,
        p_fee: tx.fee ?? 0,
        p_status: 'approved',
        p_method: tx.method,
      })
      if (kpiError) console.error('[WebhookService] KPI error:', kpiError)

      // 🔥 3b) KPI da external_fee — categoria própria pro recipient
      if (tx.external_fee_cents && tx.external_fee_recipient_id) {
        const { error: extKpiError } = await supabase.rpc('increment_kpi_safe', {
          p_seller_id: tx.external_fee_recipient_id,
          p_method: 'external_fee',
          p_amount: tx.external_fee_cents,
          p_fee: 0,
          p_status: 'approved',
        })
        if (extKpiError) {
          console.error('[WebhookService] external_fee KPI error:', extKpiError)
        }
      }

      // 4) Dispatch de webhooks pro seller
      if (!opts.skipDispatch) await this.dispatchToAll(tx, 'payment.approved', {
        status: 'approved',
        transactionId: tx.id,
        amount: tx.amount,
        currency: tx.currency,
        amountUsd: tx.amount_usd_net_cents,
        netAmount: tx.net_amount,
        fee: tx.fee,
        availableAt: tx.available_at,
        ...(tx.external_fee_cents
          ? {
            externalFee: {
              amount: tx.external_fee_cents,
              pct: tx.external_fee_pct,
              recipientId: tx.external_fee_recipient_id,
            },
          }
          : {}),
      })
    }

    // ── Pagamento INICIADO (cliente inseriu os dados / sale_in_progress) ──────
    // Promove o pedido no checkout de awaiting_payment → pending (aparece no
    // painel + conta como pendente). Ainda NÃO é venda; a captura (PAID) vem depois.
    if (status === 'PROCESSING' && type === 'TRANSACTION') {
      await supabase
        .from('transactions')
        .update({
          status: 'processing',
          provider_status: 'processing',
          last_webhook_at: now,
          updated_at: new Date(),
        })
        .eq('id', tx.id)
        .not('status', 'in', '(approved,paid,failed)')

      if (!opts.skipDispatch) {
        await this.dispatchToAll(tx, 'payment.processing', {
          status: 'processing',
          transactionId: tx.id,
        }).catch((e: any) => console.error('[WebhookService] dispatch payment.processing:', e?.message))
      }
      return { processing: true }
    }

    // ── Pagamento pendente ──────────────────────────────────────────────────
    if (status === 'PENDING' && type === 'TRANSACTION') {

      const { data: updated, error: updateError } = await supabase
        .from('transactions')
        .update({
          status: 'pending',
          provider_status: 'pending',
          webhook_sent: true,
          last_webhook_at: now,
          updated_at: new Date(),
        })
        .eq('id', tx.id)
        .not('status', 'in', '(approved)')
        .select()

      if (updateError) {
        console.error('[WebhookService] update failed error:', updateError)
        throw updateError
      }

      if (!updated || updated.length === 0) {
        return { alreadyProcessed: true }
      }

      return { pending: true }
    }

    // ── Pagamento falhou ──────────────────────────────────────────────────
    if (status === 'FAILED' && type === 'TRANSACTION') {

      const failureMessage = body.failure_message ?? body.data?.failure_message ?? null
      const failureCode = body.failure_code ?? body.data?.failure_code ?? null

      const { data: updated, error: updateError } = await supabase
        .from('transactions')
        .update({
          status: 'failed',
          provider_status: 'failed',
          failure_code: failureCode,
          failure_message: failureMessage,
          error_message: failureMessage,
          failed_at: now,
          processed_at: now,
          webhook_sent: true,
          last_webhook_at: now,
          updated_at: new Date(),
        })
        .eq('id', tx.id)
        .not('status', 'in', '(approved,failed)')
        .select()

      if (updateError) {
        console.error('[WebhookService] update failed error:', updateError)
        throw updateError
      }

      if (!updated || updated.length === 0) {
        return { alreadyProcessed: true }
      }

      const { error: kpiError } = await supabase.rpc('increment_kpi_safe', {
        p_seller_id: tx.seller_id,
        p_amount: tx.amount_usd_net_cents,
        p_fee: 0,
        p_status: 'failed',
        p_method: tx.method,

      })
      if (kpiError) console.error('[WebhookService] KPI error:', kpiError)

      // Não registra KPI da external_fee em failed — fee só conta como
      // receita da plataforma quando o pagamento é efetivo.

      if (!opts.skipDispatch) await this.dispatchToAll(tx, 'payment.failed', {
        status: 'failed',
        transactionId: tx.id,
        amount: tx.amount,
        currency: tx.currency,
        failureCode,
        failureMessage,
      })

      return { failed: true }
    }

    return { received: true }
  }

  // ─── SENTINEL GATE ────────────────────────────────────────────────────────
  // Mapeia o payload do Sentinel pro formato canônico e reaproveita TODA a
  // lógica de handleWebhookProvider (crédito, markPaid, KPIs, postbacks).
  async handleSentinelWebhook(body: any, rawBody: string, headers: Record<string, string> = {}) {
    console.log('[Sentinel webhook]', body)

    // ⚠️ Validação de assinatura DESATIVADA temporariamente — a chave de webhook
    // estava causando erro de "assinatura inválida" e derrubando webhooks legítimos.
    // A correlação da transação (provider_transaction_id / order_id) já garante
    // que só atualizamos pedidos reais. Reativar quando a whsec estiver acertada.
    // if (!this.verifySentinelSignature(rawBody, headers)) {
    //   console.warn('[WebhookService] Sentinel: assinatura inválida')
    //   return { ignored: true, reason: 'invalid signature' }
    // }

    // Resolve a transação interna:
    //  • primário → provider_transaction_id == sentinel_transaction_id (id único)
    //  • fallback → order_id (== order_number → external_reference, ou == tx.id antigo)
    const reference = await this.resolveSentinelTxId(body)
    const rawStatus = String(body?.status ?? '').toLowerCase()

    if (!reference) {
      console.warn('[WebhookService] Sentinel webhook: transação não encontrada', {
        wc_order_id: body?.wc_order_id,
        sentinel_transaction_id: body?.sentinel_transaction_id,
      })
      return { ignored: true, reason: 'transaction not found' }
    }

    // Estorno
    if (rawStatus === 'refunded') {
      return this.refundTransaction(reference)
    }

    const mapped = SENTINEL_WEBHOOK_STATUS[rawStatus]
    if (!mapped) {
      console.warn('[WebhookService] Sentinel status não mapeado:', rawStatus)
      return { ignored: true, reason: 'unmapped status' }
    }

    return this.handleWebhookProvider({
      reference,
      status: mapped,
      type: 'TRANSACTION',
      failure_message: body?.gateway_response ?? null,
    })
  }

  // ─── COINFLOW ──────────────────────────────────────────────────────────────
  // A Coinflow confirma o settlement por webhook. Correlacionamos pela
  // webhookInfo.reference (= nosso transactionId) e, em fallback, pelo paymentId
  // (== provider_transaction_id). ⚠️ A verificação de assinatura segue a doc de
  // webhooks da Coinflow — habilite com COINFLOW_WEBHOOK_SECRET quando confirmada.
  async handleCoinflowWebhook(body: any, rawBody: string, headers: Record<string, string> = {}) {
    console.log('[Coinflow webhook]', body)

    if (!this.verifyCoinflowSignature(rawBody, headers)) {
      console.warn('[WebhookService] Coinflow: assinatura inválida')
      return { ignored: true, reason: 'invalid signature' }
    }

    const data = body?.data ?? body
    const rawStatus = String(
      body?.eventType ?? body?.event ?? data?.status ?? body?.status ?? '',
    ).toLowerCase()

    // 1. webhookInfo.reference (nosso transactionId) — primário.
    let reference: string | null =
      data?.webhookInfo?.reference ?? body?.webhookInfo?.reference ?? null

    // 2. Fallback: resolve pelo paymentId == provider_transaction_id.
    if (!reference) {
      const paymentId = data?.paymentId ?? body?.paymentId ?? null
      if (paymentId) {
        const { data: tx } = await supabase
          .from('transactions')
          .select('id')
          .eq('provider_transaction_id', paymentId)
          .maybeSingle()
        reference = tx?.id ?? null
      }
    }

    if (!reference) {
      console.warn('[WebhookService] Coinflow webhook: transação não encontrada', {
        paymentId: data?.paymentId, eventType: body?.eventType,
      })
      return { ignored: true, reason: 'transaction not found' }
    }

    if (rawStatus === 'refunded' || rawStatus === 'returned') {
      return this.refundTransaction(reference)
    }

    const mapped = COINFLOW_WEBHOOK_STATUS[rawStatus]
    if (!mapped) {
      console.warn('[WebhookService] Coinflow status não mapeado:', rawStatus)
      return { ignored: true, reason: 'unmapped status' }
    }

    return this.handleWebhookProvider({
      reference,
      status: mapped,
      type: 'TRANSACTION',
      failure_message: data?.failureMessage ?? data?.message ?? null,
    })
  }

  // Verificação de assinatura do webhook da Coinflow. Sem segredo configurado,
  // aceita (lenient) com aviso — apertar para HMAC quando a doc for confirmada.
  private verifyCoinflowSignature(rawBody: string, headers: Record<string, string>): boolean {
    const secret = process.env.COINFLOW_WEBHOOK_SECRET
    if (!secret) {
      console.warn('[WebhookService] Coinflow: COINFLOW_WEBHOOK_SECRET ausente — pulando verificação (configurar p/ produção)')
      return true
    }
    // ⚠️ TODO: ajustar o nome do header e o esquema conforme a doc da Coinflow.
    const sig = headers['x-coinflow-signature'] ?? headers['coinflow-signature'] ?? ''
    const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    } catch {
      return false
    }
  }

  // ─── ROX PAY ──────────────────────────────────────────────────────────────
  // A Rox Pay NÃO assina os deliveries — autenticamos pelo header custom
  // (Authorization: Bearer <ROX_PAY_WEBHOOK_SECRET>) configurado no cadastro
  // do webhook (POST /api/v4/webhooks/create). O corpo do evento é enxuto, então
  // buscamos o status AUTORITATIVO via GET /transactions/{TransactionId} em vez
  // de confiar no texto do evento. `TransactionId` == nosso transactions.id
  // (mandamos o próprio id interno como TransactionId ao criar o payment link).
  async handleRoxPayWebhook(body: any, headers: Record<string, string> = {}) {
    console.log('[Rox Pay webhook]', body)

    const secret = process.env.ROX_PAY_WEBHOOK_SECRET
    if (secret) {
      const provided = headers['authorization'] ?? headers['Authorization'] ?? ''
      if (provided !== `Bearer ${secret}` && provided !== secret) {
        console.warn('[WebhookService] Rox Pay: header de autenticação inválido')
        return { ignored: true, reason: 'invalid secret' }
      }
    } else {
      console.warn('[WebhookService] ROX_PAY_WEBHOOK_SECRET ausente — pulando verificação (configurar p/ produção)')
    }

    // ⚠️ A Rox Pay usa o MESMO nome "TransactionId" pra coisas diferentes em
    // endpoints diferentes: na resposta de POST /payments/link, `TransactionId`
    // ecoa a nossa referência (roxTransactionId, ex. "828050802-ms0iqdbx"). Mas
    // no payload do WEBHOOK, `TransactionId` é o ID NUMÉRICO INTERNO deles (ex.
    // "9881683") — a nossa referência vem em `TransactionUuid`. Confirmado com
    // payload real: PaymentUrl termina em ".../828050802-ms0iqdbx", que bate
    // com TransactionUuid, não com TransactionId. Usar o campo errado aqui faz
    // a busca por provider_transaction_id NUNCA achar a transação — o webhook
    // responde 201 (recebido) mas a transação nunca é atualizada.
    const reference: string | null = body?.TransactionUuid ?? body?.data?.TransactionUuid
      ?? body?.TransactionId ?? body?.data?.TransactionId ?? null
    if (!reference) {
      console.warn('[WebhookService] Rox Pay webhook: TransactionUuid/TransactionId ausente', body)
      return { ignored: true, reason: 'transaction not found' }
    }

    // `reference` é o order_number (TransactionId ≤30 chars da Rox Pay), NÃO o
    // transactions.id — resolvemos por provider_transaction_id (primário, único
    // por tentativa) com fallback em external_reference (mesmo padrão do Sentinel).
    let tx: { id: string; provider_account_id: string | null } | null = null

    const { data: byProviderTxId } = await supabase
      .from('transactions').select('id, provider_account_id')
      .eq('provider_transaction_id', reference).maybeSingle()
    tx = byProviderTxId ?? null

    if (!tx) {
      const { data: byRef } = await supabase
        .from('transactions').select('id, provider_account_id')
        .eq('external_reference', reference)
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle()
      tx = byRef ?? null
    }

    if (!tx) {
      console.warn('[WebhookService] Rox Pay webhook: transação não encontrada', reference)
      return { ignored: true, reason: 'transaction not found' }
    }

    const account = tx.provider_account_id ? getProviderAccountById(tx.provider_account_id) : undefined
    if (!account) {
      console.warn('[WebhookService] Rox Pay webhook: conta do provider não encontrada', tx.provider_account_id)
      return { ignored: true, reason: 'account not found' }
    }

    let statusDescription: string | null = null
    let raw: any = null
    try {
      const provider = this.router.getProviderInstance('rox_pay') as RoxPayProvider
      const result = await provider.getTransactionStatus(reference, {
        api_url: account.api_url,
        apiKey: account.apiKey,
        apiSecret: account.apiSecret,
        config: account.config,
      })
      statusDescription = result.statusDescription
      raw = result.raw
    } catch (err: any) {
      console.error('[WebhookService] Rox Pay: erro ao buscar status autoritativo:', err?.message)
      return { ignored: true, reason: 'status fetch failed' }
    }

    const mapped = ROX_PAY_STATUS_MAP[String(statusDescription ?? '').toLowerCase()]
    if (!mapped) {
      console.warn('[WebhookService] Rox Pay status não mapeado:', statusDescription)
      return { ignored: true, reason: 'unmapped status' }
    }

    if (mapped === 'REFUNDED') return this.refundTransaction(tx.id)

    return this.handleWebhookProvider({
      reference: tx.id,
      status: mapped,
      type: 'TRANSACTION',
      failure_message: raw?.Message ?? null,
    })
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WHOP — endpoint compartilhado (/webhook/whop) e legado por conta
  // (/webhook/whop/:accountId).
  //
  // Diferente dos demais providers, aqui não existe UM segredo: cada company do
  // pool tem o seu. No endpoint compartilhado, o metadata `koopfy_account_id`
  // permite escolher o segredo certo antes de validar a assinatura.
  // ══════════════════════════════════════════════════════════════════════════

  async handleSharedWhopWebhook(
    body: any,
    rawBody: string,
    headers: Record<string, string> = {},
  ) {
    const data = body?.data ?? {}
    const metadata =
      data?.metadata
      ?? data?.payment?.metadata
      ?? data?.checkout_configuration?.metadata
      ?? data?.plan?.metadata
      ?? body?.metadata
      ?? {}
    const eventType = String(body?.type ?? body?.event ?? '')
    const accountId = String(
      this.payoutHandler.handles(eventType)
        ? metadata?.koopfy_master_account_id ?? metadata?.koopfy_account_id
        : metadata?.koopfy_account_id,
    ).trim()

    if (!accountId) {
      // Não responder 2xx: eventos sem identificação devem ser reenviados pela
      // Whop, pois sem a conta não há como escolher o segredo de assinatura.
      console.error('[WebhookService] Whop: evento no endpoint compartilhado sem koopfy_account_id')
      throw new Error('Whop: koopfy_account_id ausente no webhook')
    }

    return this.handleWhopWebhook(accountId, body, rawBody, headers)
  }

  async handleWhopWebhook(
    accountId: string,
    body: any,
    rawBody: string,
    headers: Record<string, string> = {},
  ) {
    const eventType = String(body?.type ?? body?.event ?? '')

    // ── 1. Conta ──
    // getById NÃO filtra por status de propósito: webhook de conta pausada
    // continua chegando e é dinheiro que já entrou.
    const account = await this.whopAccounts.getById(accountId)
    if (!account) {
      console.warn('[WebhookService] Whop: conta desconhecida para evento', eventType)
      return { ignored: true, reason: 'unknown account' }
    }

    // ── 2. Assinatura (Standard Webhooks) ──
    const secret = account.config?.webhook_secret
    if (!secret) {
      // Sem segredo, qualquer um que descubra a URL confirma pagamento. Recusa —
      // ao contrário dos providers legados aqui, que só avisam e seguem.
      //
      // THROW, não 2xx (mesmo motivo da assinatura inválida abaixo): com a conta
      // vindo do env, faltar WHOP_WEBHOOK_SECRET é o erro de configuração mais
      // provável. Responder 200 faria a Whop dar o evento por entregue e o
      // pagamento aprovado nunca confirmaria; com erro ela reentrega até o
      // segredo entrar no env.
      console.error('[WebhookService] Whop: conta sem webhook_secret — evento recusado', eventType)
      throw new Error('Whop: conta sem webhook_secret (configure WHOP_WEBHOOK_SECRET)')
    }

    const verification = this.verifyWhopSignature(rawBody, headers, secret)
    if (!verification.valid) {
      console.error(
        `[WebhookService] Whop: ASSINATURA INVÁLIDA (${verification.reason}) para ${eventType}. `
        + 'Se isto aparecer pra TODO evento, a suspeita nº1 é a derivação da chave '
        + '(a Whop usa `ws_<hex>` e o HMAC é sobre a string crua, não base64 decodificado) '
        + 'ou o body ter sido re-serializado antes de chegar aqui (ver express.raw em main.ts).',
      )
      // THROW, não 2xx. Devolver 200 aqui faz a Whop marcar como entregue e o
      // evento se perde PRA SEMPRE — dinheiro entrou e o pedido nunca confirma.
      // Com 5xx ela reentrega por horas, o que dá janela pra corrigir o segredo
      // sem perder as primeiras vendas. Assinatura inválida de verdade (ataque)
      // só custa algumas retentativas ruidosas.
      throw new Error(`Whop: assinatura inválida (${verification.reason})`)
    }

    const webhookCorrelation = sanitizedWebhookCorrelation(headers['webhook-id'])
    console.log('[Whop webhook]', eventType, webhookCorrelation)

    // ── 3. Dedupe ──
    // A Whop entrega at-least-once. Sem isto, um redelivery de payment.succeeded
    // roda o pipeline de crédito de novo. A PK da tabela é a trava real — a
    // corrida entre duas entregas simultâneas morre no conflito, não no if.
    const webhookId = headers['webhook-id'] ?? null
    if (webhookId) {
      const { error: dedupeError } = await supabase
        .from('whop_webhook_events')
        .insert({ webhook_id: webhookId, account_id: accountId, event_type: eventType })

      if (dedupeError) {
        // 23505 = unique_violation → já processado.
        if ((dedupeError as any).code === '23505') {
          return { alreadyProcessed: true }
        }
        console.error('[WebhookService] Whop dedupe insert error:', dedupeError.message)
      }
    }

    // A marca acima é uma RESERVA, não um "pronto". Se o processamento estourar,
    // ela é desfeita no catch — senão o retry da Whop chegaria como duplicado e
    // o pagamento ficaria pendente pra sempre por causa de um erro transitório.
    try {
      return await this.processWhopEvent(accountId, account, eventType, body)
    } catch (err) {
      if (webhookId) {
        await supabase.from('whop_webhook_events').delete().eq('webhook_id', webhookId)
      }
      throw err
    }
  }

  private async processWhopEvent(
    accountId: string,
    account: { config?: Record<string, any> },
    eventType: string,
    body: any,
  ) {
    if (this.payoutHandler.handles(eventType)) {
      return this.payoutHandler.handleVerifiedEvent(body, accountId)
    }
    // Comissão da Koopfy cobrada no cartão do seller (ou o cartão sendo salvo):
    // não há transação nossa por trás — sem este desvio o evento cairia em
    // "transação não encontrada" e a Whop reenviaria para sempre.
    if (SellerBillingService.isBillingEvent(body)) {
      return this.sellerBilling.handleWebhook(eventType, body)
    }
    if (eventType.startsWith('membership.')) {
      return this.persistWhopMembership(accountId, eventType, body);
    }

    // ── 4. Disputa (chargeback) — não muda o status da transação ──
    if (eventType === 'dispute.created' || eventType === 'dispute.updated') {
      return this.handleWhopDispute(accountId, account, eventType, body)
    }

    // ── 4a. Alerta antecipado de chargeback — cobra a taxa de chargeback ──
    if (eventType === 'dispute_alert.created') {
      return this.handleWhopDisputeAlert(accountId, account, body)
    }

    // ── 4b. Renovação de assinatura ──
    // A cobrança do ciclo herda o metadata da compra e casaria com a transação
    // ORIGINAL (já aprovada). Não é ela: a renovação paga vira transação filha,
    // com taxa e crédito do seller (whop-renewal.ts). failed/pending do ciclo só
    // ficam registrados na assinatura — acesso cortado por falta de pagamento
    // vem nos eventos membership.*.
    if (eventType.startsWith('payment.') && isWhopRenewalPayment(body?.data)) {
      if (eventType === 'payment.succeeded') return this.recordWhopRenewalPayment(accountId, body)
      return this.recordWhopRenewal(accountId, eventType, body)
    }

    const mapped = WHOP_EVENT_STATUS[eventType]
    if (!mapped) {
      console.log('[WebhookService] Whop: evento sem mapeamento, ignorado:', eventType)
      return { ignored: true, reason: 'unmapped event' }
    }

    // ── 5. Resolve a transação ──
    const tx = await this.resolveWhopTx(body)
    if (!tx && mapped === 'REFUNDED' && this.isWhopRenewalRefund(body?.data)) {
      // Estorno de uma renovação sem transação própria (cobrada antes da
      // contabilização de renovações, ou succeeded nunca processado): nunca foi
      // creditada, então não há saldo a reverter. 5xx aqui faria a Whop reenviar
      // para sempre — registra e responde 2xx.
      console.error(
        '[WebhookService] Whop: estorno de renovação sem transação — nada a reverter.',
        JSON.stringify({ accountId, eventType, data: body?.data ?? null }).slice(0, 1000),
      )
      return { ignored: true, reason: 'renewal refund without transaction' }
    }
    // Conta própria do seller: o webhook dela traz TODAS as vendas dele,
    // inclusive as que não passaram pela Koopfy. Sem transação nossa, ignora —
    // reentregar para sempre um evento que não é nosso só gera ruído.
    // (Vale também para as Whop extras do roteamento, `whopa_…`.)
    if (!tx && (isLinkedProviderAccountId(accountId) || isWhopExtraAccountId(accountId))) {
      return { ignored: true, reason: 'venda fora da Koopfy' }
    }
    if (!tx) {
      console.error(
        '[WebhookService] Whop: PAGAMENTO ÓRFÃO — nenhuma transação casou.',
        JSON.stringify({ accountId, eventType, data: body?.data ?? null }),
      )
      // THROW, não `ignored`. Responder 2xx aqui faz a Whop parar de tentar e o
      // pagamento morre órfão de vez. Com 5xx ela reentrega (a reserva de dedupe
      // é desfeita no catch de handleWhopWebhook), e a corrida "webhook chegou
      // antes da linha existir" se resolve sozinha na retentativa. Se esgotarem
      // as tentativas, aí é conciliação manual mesmo — mas com log, não silêncio.
      throw new Error(`Whop: transação não encontrada para o evento ${eventType} (${accountId})`)
    }

    // Falha de uma tentativa ANTERIOR da mesma transação (o comprador já está
    // tentando com outro cartão): o pagamento do evento não é mais o atual.
    // Aplicar marcaria como falha uma transação que ainda pode ser paga — o
    // comprador veria erro no meio do 3DS da nova tentativa.
    if (mapped === 'FAILED' && await this.isStaleWhopAttempt(tx.id, body?.data)) {
      return { ignored: true, reason: 'falha de tentativa anterior' }
    }

    // Confere o valor. Divergência aqui significa associação errada (metadata
    // reaproveitado, sessão reusada) — não bloqueia, mas tem que ser visível:
    // aprovar a transação errada é pior do que aprovar tarde.
    this.warnOnWhopAmountMismatch(tx, body?.data)

    // Guarda member + payment method (e o link de 3DS, se houver): é o que torna
    // a compra apta ao upsell de um clique. Roda ANTES da aprovação para o
    // checkout já enxergar a compra como elegível quando o postback chegar.
    // Falha aqui não pode travar a aprovação — o dinheiro já entrou.
    if (eventType.startsWith('payment.')) {
      await this.rememberWhopPaymentContext(tx.id, body?.data).catch((err: any) =>
        console.error('[WebhookService] Whop: não guardou o contexto do pagamento:', err?.message ?? err),
      )
    }

    if (mapped === 'REFUNDED') return this.refundTransaction(tx.id)

    return this.handleWebhookProvider({
      reference: tx.id,
      status: mapped,
      type: 'TRANSACTION',
      failure_message: body?.data?.failure_message ?? body?.data?.error?.message ?? null,
      // Código do banco (insufficient_funds…): vai no postback e a página de
      // resultado do checkout explica o motivo ao comprador.
      failure_code: whopDeclineCode(body?.data),
    })
  }

  // Ids da Whop que o pay não guardava: sem member + payment_method não existe
  // cobrança off-session. Mescla no metadata da transação (sem apagar o resto).
  private async rememberWhopPaymentContext(transactionId: string, data: any) {
    if (!data) return

    const patch: Record<string, string> = {}
    const put = (key: string, value: unknown) => {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text) patch[key] = text
    }
    put('whop_payment_id', data.id)
    put('whop_member_id', data.member?.id ?? data.member_id)
    put('whop_payment_method_id', data.payment_method?.id ?? data.payment_method_id)
    put('whop_user_id', data.user?.id ?? data.user_id)
    put('whop_recovery_url', data.recovery_url)
    // Nome digitado na cobrança do formulário da Whop. Produto digital no
    // checkout só pede e-mail: é daqui que o pedido tira o nome do cliente
    // (exposto em GET /payments/:id/status como customerName).
    put('whop_billing_name', data.billing_address?.name)
    // Bandeira e final do cartão: o cartão é digitado no componente da Whop, então
    // o checkout grava 'unknown'. Vão no postback (metadata) e em
    // GET /payments/:id/status, de onde o checkout grava no pedido.
    const card = whopCardOf(data)
    put('whop_card_brand', card.brand)
    put('whop_card_last4', card.last4)
    put('whop_payment_method_type', card.methodType)
    if (!Object.keys(patch).length) return

    const { data: current } = await supabase
      .from('transactions').select('metadata').eq('id', transactionId).maybeSingle()
    const { error } = await supabase
      .from('transactions')
      .update({
        metadata: { ...(current?.metadata ?? {}), ...patch },
        // Colunas que o painel do pay lê (ícone e final do cartão da transação).
        ...(card.brand ? { payment_brand: card.brand } : {}),
        ...(card.last4 ? { payment_last4: card.last4 } : {}),
      })
      .eq('id', transactionId)
    if (error) throw error
  }

  // ─── Renovação paga ───────────────────────────────────────────────────────
  //
  // Transação filha da compra original, com taxa da Koopfy e crédito do seller
  // pelo mesmo pipeline de PAID de uma venda. O checkout é avisado com
  // `subscription.renewed` (não payment.approved: lá não existe pedido com o id
  // da filha) e cria o pedido de renovação depois de conferir aqui no pay.
  private async recordWhopRenewalPayment(accountId: string, body: any) {
    const data = body?.data ?? {}
    const paymentId = whopPaymentId(data)
    if (!paymentId) throw new Error('Whop: renovação sem id de payment')

    // Idempotência pelo payment: depois de um 5xx a Whop reentrega com outro webhook-id.
    const { data: existing } = await supabase
      .from('transactions').select('id').eq('provider_transaction_id', paymentId).maybeSingle()
    let childId = existing?.id ?? null

    if (!childId) {
      const parent = await this.resolveWhopRenewalParent(data)
      if (!parent) {
        console.error(
          '[WebhookService] Whop: RENOVAÇÃO ÓRFÃ — compra original não encontrada.',
          JSON.stringify({ accountId, paymentId, membership: data?.membership?.id ?? data?.membership_id ?? null }),
        )
        // THROW: com 5xx a Whop reentrega (mesmo motivo do pagamento órfão).
        throw new Error(`Whop: compra original não encontrada para a renovação ${paymentId}`)
      }
      childId = await this.createWhopRenewalTransaction(accountId, parent, data, paymentId)
    }

    // Pending → approved + creditPending + KPI + markPaid. Idempotente.
    await this.handleWebhookProvider(
      { reference: childId, status: 'PAID', type: 'TRANSACTION' },
      { skipDispatch: true },
    )

    const { data: child } = await supabase.from('transactions').select('*').eq('id', childId).single()
    // O checkout cria o pedido de forma idempotente: reenviar é seguro.
    await this.dispatchToAll(child, 'subscription.renewed', {
      status: child.status,
      transactionId: child.id,
      parentTransactionId: child.metadata?.renewal_of_transaction_id ?? null,
      amount: child.amount,
      currency: child.currency,
      amountUsd: child.amount_usd_net_cents,
      netAmount: child.net_amount,
      fee: child.fee,
      availableAt: child.available_at,
    })

    await this.recordWhopRenewal(accountId, 'payment.succeeded', body).catch((err: any) =>
      console.warn('[WebhookService] Whop: last_renewal não registrado:', err?.message ?? err),
    )
    return { renewal: true, transactionId: child.id }
  }

  private isWhopRenewalRefund(data: any): boolean {
    const payment = data?.payment && typeof data.payment === 'object' ? data.payment : null
    return isWhopRenewalPayment(data) || isWhopRenewalPayment(payment)
  }

  // Compra original da renovação: pela membership (espelho em whop_subscriptions)
  // e, na falta dele, pelo metadata herdado. Nunca pela checkout configuration.
  private async resolveWhopRenewalParent(data: any): Promise<any | null> {
    const candidates: string[] = []
    const membershipId = data?.membership?.id ?? data?.membership_id ?? null
    if (membershipId) {
      const { data: row } = await supabase
        .from('whop_subscriptions').select('koopfy_transaction_id')
        .eq('whop_membership_id', String(membershipId)).maybeSingle()
      if (row?.koopfy_transaction_id) candidates.push(String(row.koopfy_transaction_id))
    }
    const fromMetadata = data?.metadata?.koopfy_transaction_id
    if (fromMetadata) candidates.push(String(fromMetadata))

    for (const id of candidates) {
      const { data: tx } = await supabase.from('transactions').select('*').eq('id', id).maybeSingle()
      // A original é a compra — nunca outra renovação.
      if (tx && !tx.metadata?.renewal_of_transaction_id && String(tx.provider ?? '').toLowerCase() === 'whop') {
        return tx
      }
    }
    return null
  }

  private async createWhopRenewalTransaction(accountId: string, parent: any, data: any, paymentId: string) {
    const amount = whopPaymentAmountMinor(data)
    const currency = String(data?.currency ?? parent.currency ?? '').toUpperCase()
    if (!amount || !currency) throw new Error(`Whop: renovação ${paymentId} sem valor ou moeda`)

    // Câmbio do dia da renovação — não o da compra original.
    const fx = await this.currencyService.convertToUSD(amount / 100, currency)
    const sellerFees = await getEffectiveSellerFees(parent.seller_id)
    const currencyConverted = currency !== 'USD'
    const { externalFeeDropped, breakdown, usd, ...fees } = renewalEconomics({
      grossUSDcents: Math.round(fx.grossUSD * 100),
      currencyConverted,
      sellerFees,
      parent,
    })
    const netUSDcents = usd.netCents
    if (externalFeeDropped) {
      console.error(
        `[WebhookService] renovação ${paymentId}: comissão do parceiro maior que o líquido — ` +
        `não aplicada (compra original ${parent.id})`,
      )
    }

    const { count } = await supabase
      .from('transactions').select('id', { count: 'exact', head: true })
      .eq('metadata->>renewal_of_transaction_id', parent.id)
    const cycle = (count ?? 0) + 2 // a compra original é o ciclo 1
    const membershipId = data?.membership?.id ?? data?.membership_id ?? null
    const now = new Date().toISOString()

    const { data: created, error } = await supabase
      .from('transactions')
      .insert({
        seller_id: parent.seller_id,
        offer_id: parent.offer_id ?? null,
        amount,
        currency,
        method: parent.method ?? 'card',
        amount_usd_net_cents: netUSDcents,
        amount_usd_gross_cents: usd.grossCents,
        fx_fee_cents: usd.fxFeeCents,
        fx_rate: currencyConverted ? fx.fxMarketRate * (1 - sellerFees.fxFeePct / 100) : 1,
        status: 'pending',
        provider: parent.provider ?? 'whop',
        provider_status: data?.status ?? null,
        provider_account_id: accountId,
        provider_transaction_id: paymentId,
        customer_name: parent.customer_name ?? null,
        customer_email: parent.customer_email ?? null,
        customer_phone: parent.customer_phone ?? 'N/A',
        customer_document: parent.customer_document ?? 'N/A',
        customer_country: parent.customer_country ?? null,
        payment_last4: parent.payment_last4 ?? null,
        payment_brand: parent.payment_brand ?? null,
        idempotency_key: `whop_renewal_${paymentId}`,
        external_reference: parent.external_reference ? `${parent.external_reference}-R${cycle}` : null,
        metadata: renewalMetadata(parent.metadata, { parentTransactionId: parent.id, paymentId, membershipId, cycle }),
        postback_url: parent.postback_url ?? null,
        risk_level: parent.risk_level ?? null,
        // Mesmo destino da taxa da plataforma que a compra original.
        ...('platform_partner' in parent ? { platform_partner: parent.platform_partner } : {}),
        webhook_sent: false,
        webhook_status: 'pending',
        webhook_attempts: 0,
        ...fees,
        processed_at: now,
        created_at: now,
      })
      .select('id')
      .single()

    if (error || !created) {
      // Duas entregas ao mesmo tempo: a outra já criou.
      const { data: raced } = await supabase
        .from('transactions').select('id').eq('provider_transaction_id', paymentId).maybeSingle()
      if (raced) return raced.id as string
      throw new Error(`Whop: falha ao criar a transação da renovação ${paymentId} (${error?.message})`)
    }
    // Detalhe das taxas à parte: sem a coluna (migration pendente) não derruba a renovação.
    supabase.from('transactions').update({ fee_breakdown: breakdown }).eq('id', created.id)
      .then(({ error: breakdownError }) => {
        if (breakdownError) console.error('[WebhookService] fee_breakdown da renovação:', breakdownError.message)
      })
    return created.id as string
  }

  // Última cobrança de renovação fica em whop_subscriptions.metadata.last_renewal.
  // Sem a linha da assinatura (membership.* ainda não chegou) só registra no log —
  // responder erro faria a Whop reenviar um evento que não aprova nada.
  private async recordWhopRenewal(accountId: string, eventType: string, body: any) {
    const data = body?.data ?? {}
    const membershipId = data?.membership?.id ?? data?.membership_id ?? null
    const renewal = {
      event: eventType,
      payment_id: data?.id ?? null,
      status: data?.status ?? null,
      substatus: data?.substatus ?? null,
      amount: data?.total ?? data?.final_amount ?? data?.subtotal ?? null,
      currency: data?.currency ?? null,
      at: new Date().toISOString(),
    }
    console.log('[WebhookService] Whop renovação:', JSON.stringify({ accountId, membershipId, ...renewal }))
    if (!membershipId) return { renewal: true, recorded: false, reason: 'membership id missing' }

    const { data: row } = await supabase
      .from('whop_subscriptions').select('metadata').eq('whop_membership_id', String(membershipId)).maybeSingle()
    if (!row) return { renewal: true, recorded: false, reason: 'subscription not found' }

    const { error } = await supabase
      .from('whop_subscriptions')
      .update({ metadata: { ...(row.metadata ?? {}), last_renewal: renewal }, updated_at: renewal.at })
      .eq('whop_membership_id', String(membershipId))
    if (error) throw new Error(`Whop: falha ao registrar renovação (${error.message})`)
    return { renewal: true, recorded: true }
  }

  private async persistWhopMembership(accountId: string, eventType: string, body: any) {
    const data = body?.data ?? {};
    const metadata = data?.metadata ?? body?.metadata ?? {};
    const membershipId = data?.id ?? data?.membership_id;
    if (!membershipId) {
      console.warn('[WebhookService] Whop membership sem id:', eventType);
      return { ignored: true, reason: 'membership id missing' };
    }

    const status = eventType === 'membership.deactivated'
      ? 'inactive'
      : (data?.status ?? 'active');
    const tx = await this.resolveWhopTx(body);
    const row = {
      whop_membership_id: String(membershipId),
      whop_account_id: accountId,
      whop_plan_id: String(data?.plan_id ?? data?.plan?.id ?? metadata?.koopfy_plan_id ?? '') || null,
      koopfy_product_id: String(metadata?.koopfy_product_id ?? '') || null,
      koopfy_transaction_id: tx?.id ?? metadata?.koopfy_transaction_id ?? null,
      customer_email: data?.user?.email ?? data?.customer?.email ?? null,
      status,
      cancel_at_period_end: Boolean(data?.cancel_at_period_end),
      current_period_end: data?.renewal_period_end ?? data?.current_period_end ?? data?.expires_at ?? null,
      metadata,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('whop_subscriptions')
      .upsert(row, { onConflict: 'whop_membership_id' });

    // O acesso (digital_access) e os pedidos moram no banco do CHECKOUT, não
    // neste — o update direto que havia aqui nunca chegava ao comprador. Avisa
    // pelo postback; o checkout ignora o corpo e consulta a assinatura no pay
    // com a chave do vendedor antes de mexer no acesso. Vai antes do throw: o
    // espelho local falhar não pode segurar o corte (ou a volta) do acesso.
    if (tx?.id) {
      const { data: fullTx } = await supabase
        .from('transactions')
        .select('id, seller_id, postback_url, external_reference, metadata')
        .eq('id', tx.id)
        .maybeSingle();
      if (fullTx) await this.dispatchToAll(fullTx, 'subscription.updated', { transactionId: fullTx.id });
    }

    if (error) throw new Error(`Whop: falha ao persistir membership (${error.message})`);
    return { received: true, membership: membershipId, status };
  }

  // Resolve transactions.id a partir do payload da Whop.
  //
  // Ordem importa: o metadata é o fio PRIMÁRIO (posto em WhopProvider.charge e
  // propagado pela Whop até o payment). Os demais são rede de segurança.
  /** O pagamento do evento é de uma tentativa que já foi substituída por outra? */
  private async isStaleWhopAttempt(transactionId: string, data: any): Promise<boolean> {
    const eventPaymentId = whopPaymentId(data)
    if (!eventPaymentId) return false
    const { data: row } = await supabase
      .from('transactions').select('provider_transaction_id').eq('id', transactionId).maybeSingle()
    const current = row?.provider_transaction_id
    return typeof current === 'string' && current.startsWith('pay_') && current !== eventPaymentId
  }

  private async resolveWhopTx(body: any): Promise<{ id: string } | null> {
    const data = body?.data ?? {}
    const metadata = data?.metadata ?? body?.metadata ?? {}

    // 0) Id do payment (pay_xxx) ANTES do metadata. Upsell de um clique e
    //    renovação de assinatura têm transação própria com esse id em
    //    provider_transaction_id, mas carregam o metadata da compra original:
    //    olhando o metadata primeiro, estorno e disputa de uma renovação cairiam
    //    na compra original. Em refund/dispute o payment vem aninhado.
    const nestedPayment = data?.payment && typeof data.payment === 'object' ? data.payment : null
    const paymentId = whopPaymentId(data) ?? whopPaymentId(nestedPayment) ?? whopPaymentId({ id: data?.payment_id })
    if (paymentId) {
      const { data: byPayment } = await supabase
        .from('transactions').select('id')
        .eq('provider_transaction_id', paymentId).maybeSingle()
      if (byPayment) return byPayment
    }
    // Renovação ainda sem transação própria: nunca cai na compra original.
    if (isWhopRenewalPayment(data) || isWhopRenewalPayment(nestedPayment)) return null

    // 1) Nosso transactions.id, ida e volta pelo metadata.
    const txId = metadata?.koopfy_transaction_id
    if (txId) {
      const { data: byId } = await supabase
        .from('transactions').select('id').eq('id', String(txId)).maybeSingle()
      if (byId) return byId
    }

    // 2) checkout configuration (ch_xxx) — gravado como provider_transaction_id.
    const sessionId =
      data?.checkout_configuration_id
      ?? data?.checkout_configuration?.id
      ?? data?.checkout_session_id
      ?? null

    if (sessionId) {
      const { data: bySession } = await supabase
        .from('transactions').select('id')
        .eq('provider_transaction_id', String(sessionId)).maybeSingle()
      if (bySession) return bySession
    }

    // 3) order_number → external_reference (mesmo fallback do Sentinel/Rox).
    const orderRef = metadata?.koopfy_order_ref
    if (orderRef) {
      const { data: byRef } = await supabase
        .from('transactions').select('id')
        .eq('external_reference', String(orderRef))
        .eq('provider', 'whop')
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle()
      if (byRef) return byRef
    }

    return null
  }

  // ─── Disputa da Whop ──────────────────────────────────────────────────────
  //
  // Antes era só um console.warn: ninguém ficava sabendo, o pedido não mostrava
  // nada e o prazo de resposta passava — disputa não contestada conta como
  // perdida. Agora:
  //   1. grava em stripe_risk_events (mesma tabela/estatística do Stripe);
  //   2. guarda o estado em transactions.metadata.whop_dispute — é o que o
  //      checkout confere em GET /payments/:id/status antes de aceitar o aviso;
  //   3. avisa o checkout (payment.disputed), que registra o chargeback no pedido
  //      e alerta vendedor e plataforma;
  //   4. reavalia o afiliado na hora (o limiar de corte depende de ver cedo).
  private async handleWhopDispute(
    accountId: string,
    account: { config?: Record<string, any> },
    eventType: string,
    body: any,
  ) {
    const data = body?.data ?? {}
    const payment = data?.payment && typeof data.payment === 'object' ? data.payment : null
    const paymentId: string | null = payment?.id ?? data?.payment_id ?? null

    // O payload da disputa pode trazer o payment aninhado (com o metadata que
    // pusemos na cobrança) ou só o id — tenta cada formato.
    const candidates = [
      payment ? { data: payment } : null,
      paymentId ? { data: { id: paymentId, metadata: data?.metadata ?? {} } } : null,
      body,
    ].filter(Boolean)
    let ref: { id: string } | null = null
    for (const candidate of candidates) {
      ref = await this.resolveWhopTx(candidate)
      if (ref) break
    }
    const { data: tx } = ref
      ? await supabase.from('transactions').select('*').eq('id', ref.id).maybeSingle()
      : { data: null as any }

    const disputeId = String(data?.id ?? `dp_whop_${Date.now()}`)
    const status = String(data?.status ?? (eventType === 'dispute.created' ? 'needs_response' : 'updated'))
    const amountMajor = Number(data?.amount ?? payment?.amount ?? NaN)
    const currency = data?.currency ?? payment?.currency ?? tx?.currency ?? null
    const dueBy = data?.due_by ?? data?.evidence_due_by ?? data?.response_due_at ?? null
    const reason = data?.reason ?? null

    await this.stripeRisk.recordRiskEvent({
      // created conta uma vez; cada mudança de status do updated vira um evento.
      id: eventType === 'dispute.created' ? disputeId : `${disputeId}:${status}`,
      accountId,
      kind: 'dispute',
      reason,
      amountCents: Number.isFinite(amountMajor) ? Math.round(amountMajor * 100) : null,
      currency: currency ? String(currency).toLowerCase() : null,
      paymentIntentId: paymentId,
      transactionId: tx?.id ?? null,
      payload: { provider: 'whop', eventType, status, dueBy },
    })

    console.error(
      `[WebhookService] 🚨 DISPUTA Whop em ${accountId} ` +
      `(${account.config?.legal_name ?? 'titular não identificado'}): status=${status} ` +
      `motivo="${reason ?? '?'}" tx=${tx?.id ?? 'não vinculada'} prazo=${dueBy ?? '?'}.`,
    )

    if (!tx) {
      console.warn('[WebhookService] disputa Whop sem transação vinculada:', JSON.stringify(data).slice(0, 500))
      return { received: true, disputed: true, linked: false }
    }

    const dispute = {
      id: disputeId,
      status,
      reason,
      due_by: dueBy,
      amount: Number.isFinite(amountMajor) ? amountMajor : null,
      currency,
      updated_at: new Date().toISOString(),
    }
    const metadata = { ...(tx.metadata ?? {}), whop_dispute: dispute }
    await supabase.from('transactions').update({ metadata }).eq('id', tx.id)

    await this.dispatchToAll({ ...tx, metadata }, 'payment.disputed', {
      transactionId: tx.id,
      status: tx.status,
      dispute,
    }).catch((e: any) => console.error('[WebhookService] dispatch payment.disputed:', e?.message))

    if (tx.seller_id) {
      await this.affiliateRisk.evaluateOne(tx.seller_id)
        .catch(err => console.error('[WebhookService] affiliateRisk (whop):', err?.message))
    }

    return { received: true, disputed: true, linked: true }
  }

  // Alerta antecipado de chargeback (Visa/Mastercard, via Whop). A Whop pode
  // estornar a venda sozinha para não virar chargeback — o estorno chega depois
  // em refund.created e segue o fluxo normal de reembolso. O alerta cobra do
  // seller a taxa de chargeback (seller_fees.chargeback_fee_usd, padrão US$ 30)
  // uma vez por venda: o ledger é idempotente por transação + tipo, e se a venda
  // ainda virar chargeback, acceptChargeback não cobra a taxa de novo.
  private async handleWhopDisputeAlert(
    accountId: string,
    account: { config?: Record<string, any> },
    body: any,
  ) {
    const data = body?.data ?? {}
    const payment = data?.payment && typeof data.payment === 'object' ? data.payment : null
    const paymentId: string | null = payment?.id ?? data?.payment_id ?? null

    const candidates = [
      payment ? { data: payment } : null,
      paymentId ? { data: { id: paymentId, metadata: data?.metadata ?? {} } } : null,
      body,
    ].filter(Boolean)
    let ref: { id: string } | null = null
    for (const candidate of candidates) {
      ref = await this.resolveWhopTx(candidate)
      if (ref) break
    }
    const { data: tx } = ref
      ? await supabase.from('transactions').select('*').eq('id', ref.id).maybeSingle()
      : { data: null as any }

    const alertId = String(data?.id ?? `da_whop_${Date.now()}`)
    const amountMajor = Number(data?.amount ?? payment?.amount ?? NaN)
    const currency = data?.currency ?? payment?.currency ?? tx?.currency ?? null
    const reason = data?.reason ?? data?.alert_type ?? data?.type ?? null

    await this.stripeRisk.recordRiskEvent({
      id: `alert:${alertId}`,
      accountId,
      kind: 'dispute',
      reason,
      amountCents: Number.isFinite(amountMajor) ? Math.round(amountMajor * 100) : null,
      currency: currency ? String(currency).toLowerCase() : null,
      paymentIntentId: paymentId,
      transactionId: tx?.id ?? null,
      payload: { provider: 'whop', eventType: 'dispute_alert.created', alert: true },
    })

    console.error(
      `[WebhookService] ⚠️ ALERTA DE CHARGEBACK Whop em ${accountId} ` +
      `(${account.config?.legal_name ?? 'titular não identificado'}): alerta=${alertId} ` +
      `motivo="${reason ?? '?'}" tx=${tx?.id ?? 'não vinculada'}.`,
    )

    if (!tx) {
      console.warn('[WebhookService] alerta de chargeback Whop sem transação vinculada:', JSON.stringify(data).slice(0, 500))
      return { received: true, alert: true, linked: false }
    }

    const alert = {
      id: alertId,
      reason,
      amount: Number.isFinite(amountMajor) ? amountMajor : null,
      currency,
      received_at: new Date().toISOString(),
    }
    await supabase.from('transactions')
      .update({ metadata: { ...(tx.metadata ?? {}), whop_dispute_alert: alert } })
      .eq('id', tx.id)

    let feeCents = 0
    if (tx.seller_id) {
      const sellerFees = await getEffectiveSellerFees(tx.seller_id)
      feeCents = Math.round(sellerFees.chargebackFeeUsd * 100)
      if (feeCents > 0) {
        await this.reverseBalance(tx.seller_id, 'available', feeCents, tx.id, 'chargeback_alert_fee')
      }
      await this.affiliateRisk.evaluateOne(tx.seller_id)
        .catch(err => console.error('[WebhookService] affiliateRisk (alerta whop):', err?.message))
    }

    return { received: true, alert: true, linked: true, feeCents }
  }

  private warnOnWhopAmountMismatch(tx: { id: string }, data: any) {
    const paid = Number(data?.amount ?? data?.total ?? NaN)
    if (!Number.isFinite(paid)) return

    // A Whop reporta em unidade principal (o mesmo formato de initial_price).
    supabase
      .from('transactions').select('amount, currency').eq('id', tx.id).maybeSingle()
      .then(({ data: row }) => {
        if (!row) return
        const expected = Number(row.amount) / 100
        if (Math.abs(expected - paid) > 0.01) {
          console.error(
            `[WebhookService] Whop: VALOR DIVERGENTE na transação ${tx.id} — ` +
            `esperado ${expected} ${row.currency}, recebido ${paid}`,
          )
        }
      })
  }

  // ─────────────────────────────────────────────
  // Standard Webhooks (a mesma spec do Svix, usada pela Whop).
  //
  // Headers: webhook-id, webhook-timestamp, webhook-signature.
  // Conteúdo assinado: `{id}.{timestamp}.{body-bruto}`.
  // O header pode trazer VÁRIAS assinaturas separadas por espaço (rotação de
  // segredo) — basta uma bater.
  //
  // ⚠️ A CHAVE DO HMAC. A spec padrão usa `whsec_<base64>` e manda base64-decodar
  // a parte depois do prefixo. A Whop NÃO segue isso: o segredo dela vem como
  // `ws_<64 hex>` (confirmado criando um webhook de verdade na API). O prefixo
  // não é `whsec_`, então o verificador padrão não corta nada — e o SDK deles
  // manda passar `btoa(secret)`, ou seja, base64 do segredo INTEIRO, que o
  // verificador decodifica de volta para os bytes literais da string.
  //
  // Resultado prático: a chave é a STRING CRUA do segredo, com prefixo e tudo.
  // Base64-decodar aqui (o que a spec sugeriria) produz lixo e a assinatura
  // nunca bate — o pagamento chega, é recusado por "signature mismatch" e a
  // transação fica pendente pra sempre.
  //
  // Testamos as duas derivações porque só uma entrega real prova qual está
  // valendo, e um formato futuro `whsec_` voltaria a exigir a outra. Ambas saem
  // do MESMO segredo, então aceitar as duas não amplia superfície de ataque.
  // ─────────────────────────────────────────────

  private verifyWhopSignature(
    rawBody: string,
    headers: Record<string, string>,
    secret: string,
  ): { valid: boolean; reason?: string } {
    const id = headers['webhook-id']
    const timestamp = headers['webhook-timestamp']
    const signatureHeader = headers['webhook-signature']

    if (!id || !timestamp || !signatureHeader) {
      return { valid: false, reason: 'missing signature headers' }
    }

    const ts = Number(timestamp)
    if (!Number.isFinite(ts)) return { valid: false, reason: 'invalid timestamp' }

    const skew = Math.abs(Math.floor(Date.now() / 1000) - ts)
    if (skew > WHOP_SIGNATURE_TOLERANCE_S) {
      return { valid: false, reason: `timestamp fora da tolerância (${skew}s)` }
    }

    const signedContent = `${id}.${timestamp}.${rawBody}`

    const keys: Buffer[] = [
      // Formato da Whop hoje: chave = bytes literais do segredo (`ws_<hex>`).
      Buffer.from(secret, 'utf8'),
    ]
    if (secret.startsWith('whsec_')) {
      // Formato Standard Webhooks canônico, caso a Whop migre pra ele.
      keys.push(Buffer.from(secret.slice('whsec_'.length), 'base64'))
    }

    const provided = signatureHeader
      .split(' ')
      .map(part => part.split(',')[1] ?? '')
      .filter(Boolean)

    if (provided.length === 0) return { valid: false, reason: 'no v1 signature' }

    for (const key of keys) {
      const expectedBuf = Buffer.from(
        crypto.createHmac('sha256', key).update(signedContent).digest('base64'),
      )

      for (const candidate of provided) {
        const candidateBuf = Buffer.from(candidate)
        if (candidateBuf.length !== expectedBuf.length) continue
        if (crypto.timingSafeEqual(candidateBuf, expectedBuf)) return { valid: true }
      }
    }

    return { valid: false, reason: 'signature mismatch' }
  }

  // Resolve o transactions.id interno a partir do payload do webhook do Sentinel.
  // ══════════════════════════════════════════════════════════════════════════
  // STRIPE — um endpoint por conta: /webhook/stripe/:accountId
  // ══════════════════════════════════════════════════════════════════════════
  //
  // A conta vai no PATH pela mesma razão da Whop: cada titular tem seu próprio
  // signing secret, e um endpoint único não teria como saber com qual validar.
  // Testar todos, além de lento, aceitaria um payload assinado pela conta
  // errada — o que abriria a porta para uma conta confirmar pagamento de outra.
  //
  // ⚠️ O CORPO TEM QUE SER O BRUTO. A assinatura é sobre os bytes exatos;
  // re-serializar o JSON parseado (ordem de chaves, escapes) invalida tudo.
  // Ver express.raw em main.ts, registrado em /webhook/stripe.

  async handleStripeWebhook(
    accountId: string,
    rawBody: string,
    headers: Record<string, string> = {},
  ) {
    // ── 1. Conta ──
    // getById NÃO filtra status nem quarentena de propósito: webhook de conta
    // restringida continua chegando e é dinheiro que já entrou. Aliás, é
    // justamente na conta quarentenada que os eventos mais importantes chegam.
    const account = await this.stripeAccounts.getById(accountId)
    if (!account) {
      console.warn('[WebhookService] Stripe: conta desconhecida no path:', accountId)
      return { ignored: true, reason: 'unknown account' }
    }

    // ── 2. Assinatura ──
    const secret = account.config?.webhook_secret
    if (!secret) {
      // Sem segredo, qualquer um que descubra a URL confirma pagamento.
      console.error(
        `[WebhookService] Stripe: conta ${accountId} sem webhook_secret — evento recusado. `
        + 'Cadastre o whsec_ do endpoint DESTA conta em stripe_accounts.webhook_secret.',
      )
      return { ignored: true, reason: 'missing webhook secret' }
    }

    const verification = this.verifyStripeSignature(rawBody, headers, secret)
    if (!verification.valid) {
      console.error(
        `[WebhookService] Stripe: ASSINATURA INVÁLIDA (${verification.reason}) em ${accountId}. `
        + 'Suspeita nº1: o body chegou re-serializado (confira express.raw em /webhook/stripe '
        + 'no main.ts — o prefixo é SINGULAR). Suspeita nº2: o whsec_ cadastrado é de outro '
        + 'endpoint/conta.',
      )
      // THROW, não 2xx. Responder 200 faz a Stripe marcar como entregue e o
      // evento se perde: dinheiro entrou e o pedido nunca confirma. Com 5xx ela
      // reentrega por até 3 dias, o que dá janela para corrigir o segredo sem
      // perder as primeiras vendas.
      throw new Error(`Stripe: assinatura inválida (${verification.reason}) em ${accountId}`)
    }

    let event: any = {}
    try { event = JSON.parse(rawBody || '{}') } catch { /* payload inválido */ }

    const eventId = String(event?.id ?? '')
    const eventType = String(event?.type ?? '')
    console.log('[Stripe webhook]', accountId, eventType, eventId)

    // ── 3. Dedupe ──
    // A Stripe entrega at-least-once e reentrega por até 3 dias. Sem isto, um
    // redelivery de payment_intent.succeeded roda o pipeline de crédito de novo.
    // A PK da tabela é a trava real — a corrida entre duas entregas simultâneas
    // morre no conflito, não no if.
    if (eventId) {
      const { error: dedupeError } = await supabase
        .from('stripe_webhook_events')
        .insert({ event_id: eventId, account_id: accountId, event_type: eventType })

      if (dedupeError) {
        if ((dedupeError as any).code === '23505') return { alreadyProcessed: true }
        console.error('[WebhookService] Stripe dedupe insert error:', dedupeError.message)
      }
    }

    // A marca acima é RESERVA, não "pronto". Se o processamento estourar, é
    // desfeita — senão o retry chegaria como duplicado e o pagamento ficaria
    // pendente para sempre por causa de um erro transitório.
    try {
      return await this.processStripeEvent(accountId, eventType, event)
    } catch (err) {
      if (eventId) {
        await supabase.from('stripe_webhook_events').delete().eq('event_id', eventId)
      }
      throw err
    }
  }

  private async processStripeEvent(accountId: string, eventType: string, event: any) {
    const object = event?.data?.object ?? {}

    // ── 4. Eventos de RISCO — não mexem em transação, alimentam o governador ──
    // Conta PRÓPRIA do seller: não é titular do pool, não há quarentena nem
    // governador a alimentar. Da disputa, só o aviso ao checkout.
    if (STRIPE_RISK_EVENTS.has(eventType)) {
      if (isStripeOwnAccountId(accountId)) {
        if (!eventType.startsWith('charge.dispute')) return { ignored: true, reason: 'conta própria' }
        const tx = await this.resolveStripeTx(object)
        const owned = tx ? this.ownStripeTxCheck(accountId, tx, object) : 'none'
        if (owned !== 'ok') return { ignored: true, reason: 'disputa fora da Koopfy' }
        await this.recordStripeDispute(tx!.id, eventType, object)
        return { received: true, disputed: true }
      }
      return this.processStripeRiskEvent(accountId, eventType, object)
    }

    const mapped = STRIPE_EVENT_STATUS[eventType]
    if (!mapped) {
      console.log('[WebhookService] Stripe: evento sem mapeamento, ignorado:', eventType)
      return { ignored: true, reason: 'unmapped event' }
    }

    // ── 5. Resolve a transação ──
    const tx = await this.resolveStripeTx(object)

    // Conta PRÓPRIA do seller: o webhook traz TODAS as vendas dele, inclusive
    // as de fora da Koopfy — e quem assina é ele. Só vale evento de transação
    // que NÓS mandamos para ESTA conta, com ESTE intent: senão um intent criado
    // à mão na conta dele, com o nosso metadata, aprovaria um pedido sem pagar.
    if (isStripeOwnAccountId(accountId)) {
      const owned = tx ? this.ownStripeTxCheck(accountId, tx, object) : 'none'
      if (owned === 'none') return { ignored: true, reason: 'venda fora da Koopfy' }
      if (owned === 'retry') {
        // A gravação da conta/intent na transação é assíncrona no createPayment:
        // 5xx faz a Stripe reentregar quando a linha já estiver completa.
        throw new Error(`Stripe: transação ${tx!.id} ainda sem conta/intent gravados (${accountId})`)
      }
      if (owned === 'mismatch') {
        console.error(
          `[WebhookService] 🚨 Stripe: evento da conta própria ${accountId} aponta para a transação ${tx!.id}, `
          + 'que não é desta conta/intent — ignorado.',
        )
        return { ignored: true, reason: 'transação de outra conta' }
      }
    }

    if (!tx) {
      console.error(
        '[WebhookService] Stripe: PAGAMENTO ÓRFÃO — nenhuma transação casou.',
        JSON.stringify({ accountId, eventType, objectId: object?.id ?? null }),
      )
      // THROW, não `ignored`. Responder 2xx faz a Stripe parar de tentar e o
      // pagamento morre órfão de vez. Com 5xx ela reentrega (a reserva de
      // dedupe é desfeita no catch), e a corrida "webhook chegou antes de a
      // linha existir" se resolve sozinha na retentativa.
      throw new Error(`Stripe: transação não encontrada para ${eventType} (${accountId})`)
    }

    if (mapped === 'REFUNDED') {
      // Reembolso conta como sinal de risco também: taxa de reembolso alta é o
      // que a Stripe olha ANTES de a disputa aparecer — e é o único indicador
      // em que agir cedo realmente muda o desfecho. (Conta própria não entra
      // no governador do pool.)
      if (!isStripeOwnAccountId(accountId)) await this.stripeRisk.recordRiskEvent({
        id: `rf_${object?.id ?? tx.id}`,
        accountId,
        kind: 'refund',
        amountCents: object?.amount_refunded ?? null,
        currency: object?.currency ?? null,
        chargeId: object?.id ?? null,
        transactionId: tx.id,
        payload: { eventType },
      }).catch(err => console.error('[WebhookService] recordRiskEvent(refund):', err?.message))

      return this.refundTransaction(tx.id)
    }

    // Divergência de valor significa associação errada (metadata reaproveitado,
    // intent reusado). Não bloqueia, mas tem que ser visível: aprovar a
    // transação errada é pior do que aprovar tarde.
    this.warnOnStripeAmountMismatch(tx, object)

    return this.handleWebhookProvider({
      reference: tx.id,
      status: mapped,
      type: 'TRANSACTION',
      failure_message:
        object?.last_payment_error?.message
        ?? object?.failure_message
        ?? null,
    })
  }

  // ─────────────────────────────────────────────
  // Eventos de risco → StripeRiskService
  //
  // O id do objeto na Stripe (dp_xxx, issfr_xxx, prv_xxx) vira a PK em
  // stripe_risk_events, então reentrega não infla o numerador das taxas.
  // ─────────────────────────────────────────────

  private async processStripeRiskEvent(accountId: string, eventType: string, object: any) {
    // Resolve uma vez: o id serve à atribuição do evento e o seller_id à
    // atribuição por AFILIADO — que é onde está a causa, no modelo de afiliação.
    const tx = await this.resolveStripeTx(object)
    const txId = object?.metadata?.koopfy_transaction_id ?? tx?.id ?? null
    const sellerId = tx?.seller_id ?? null

    if (eventType.startsWith('charge.dispute')) {
      await this.stripeRisk.recordRiskEvent({
        id: String(object?.id ?? `dp_${Date.now()}`),
        accountId,
        kind: 'dispute',
        reason: object?.reason ?? null,
        amountCents: object?.amount ?? null,
        currency: object?.currency ?? null,
        chargeId: object?.charge ?? null,
        paymentIntentId: object?.payment_intent ?? null,
        transactionId: txId,
        payload: { eventType, status: object?.status ?? null },
      })

      console.error(
        `[WebhookService] 🚨 DISPUTA em ${accountId}: motivo="${object?.reason ?? '?'}" `
        + `valor=${object?.amount ?? '?'} ${object?.currency ?? ''} `
        + `prazo=${object?.evidence_details?.due_by ?? '?'}. `
        + 'Responder com evidência de entrega é o que mantém a taxa sob controle — '
        + 'disputa não contestada conta igual a disputa perdida.',
      )

      // Mesmo caminho da disputa Whop: grava o estado na transação (é o que o
      // checkout confere em GET /payments/:id/status) e avisa o checkout, que
      // registra o chargeback no pedido e alerta o vendedor e a plataforma.
      // Antes a disputa Stripe só ia pro log — ninguém juntava evidência a tempo.
      if (txId) await this.recordStripeDispute(String(txId), eventType, object)

      // A conta é onde o sintoma aparece; o afiliado é onde está a causa.
      // Reavaliar na hora porque a decisão de cortar depende de ver a tendência
      // cedo — esperar o ciclo de 1h é aceitável para a estatística e não é
      // para o afiliado que acabou de cruzar o limiar.
      if (sellerId) {
        await this.affiliateRisk.evaluateOne(sellerId)
          .catch(err => console.error('[WebhookService] affiliateRisk:', err?.message))
      }

      return { received: true, disputed: true }
    }

    if (eventType === 'radar.early_fraud_warning.created') {
      await this.stripeRisk.recordRiskEvent({
        id: String(object?.id ?? `efw_${Date.now()}`),
        accountId,
        kind: 'early_fraud_warning',
        reason: object?.fraud_type ?? null,
        chargeId: object?.charge ?? null,
        paymentIntentId: object?.payment_intent ?? null,
        transactionId: txId,
        payload: { eventType },
      })

      console.error(
        `[WebhookService] ⚠️ EARLY FRAUD WARNING em ${accountId} (charge ${object?.charge ?? '?'}, `
        + `tipo=${object?.fraud_type ?? '?'}).`,
      )

      // Auto-reembolso na janela em que ainda muda o placar: EFW não conta para
      // o programa das bandeiras, disputa conta. Opt-in por conta — ver
      // StripeEfwService, que registra TODA decisão, inclusive as de não agir.
      const outcome = await this.stripeEfw.handle({
        efwId: String(object?.id ?? `efw_${Date.now()}`),
        accountId,
        chargeId: object?.charge ?? null,
        paymentIntentId: object?.payment_intent ?? null,
        fraudType: object?.fraud_type ?? null,
        transactionId: txId,
      })

      // O reembolso na Stripe já saiu; falta a contabilidade daqui (status da
      // transação, reversão do saldo do seller, postback). refundTransaction é
      // idempotente, então reentrega do webhook não reverte duas vezes.
      if (outcome.decision === 'refunded' && txId) {
        await this.refundTransaction(String(txId))
      }

      return { received: true, earlyFraudWarning: true, efw: outcome }
    }

    if (eventType.startsWith('review.')) {
      if (eventType === 'review.opened') {
        await this.stripeRisk.recordRiskEvent({
          id: String(object?.id ?? `prv_${Date.now()}`),
          accountId,
          kind: 'review',
          reason: object?.reason ?? null,
          chargeId: object?.charge ?? null,
          paymentIntentId: object?.payment_intent ?? null,
          transactionId: txId,
          payload: { eventType },
        })
      }
      return { received: true, review: true }
    }

    if (eventType === 'payout.failed') {
      await this.stripeRisk.recordRiskEvent({
        id: String(object?.id ?? `po_${Date.now()}`),
        accountId,
        kind: 'payout_failed',
        reason: object?.failure_message ?? object?.failure_code ?? null,
        amountCents: object?.amount ?? null,
        currency: object?.currency ?? null,
        payload: { eventType },
      })

      console.error(
        `[WebhookService] 🚨 PAYOUT FALHOU em ${accountId}: `
        + `${object?.failure_code ?? '?'} — ${object?.failure_message ?? 'sem mensagem'}. `
        + 'O dinheiro está preso. Confira os dados bancários do titular antes que '
        + 'a Stripe suspenda os payouts da conta.',
      )
      return { received: true, payoutFailed: true }
    }

    if (eventType === 'account.updated') {
      // Chega em conta Connect; em standalone o sinal confiável é o probe do
      // StripeRiskService. Quando chega, vale antecipar a avaliação em vez de
      // esperar os 5 min do ciclo.
      const row = await this.stripeAccounts.getRowById(accountId)
      if (row) {
        await this.stripeRisk.probeOne(row)
          .catch(err => console.error('[WebhookService] probeOne:', err?.message))
      }
      return { received: true, accountUpdated: true }
    }

    return { received: true }
  }

  // Grava a disputa na transação (é o que o checkout confere em
  // GET /payments/:id/status) e avisa o checkout com payment.disputed.
  private async recordStripeDispute(txId: string, eventType: string, object: any) {
    const { data: disputedTx } = await supabase
      .from('transactions').select('*').eq('id', txId).maybeSingle();
    if (!disputedTx) return
    const dueBy = object?.evidence_details?.due_by;
    const dispute = {
      id: String(object?.id ?? ''),
      source: 'stripe',
      status: String(object?.status ?? (eventType === 'charge.dispute.created' ? 'needs_response' : 'updated')),
      reason: object?.reason ?? null,
      due_by: typeof dueBy === 'number' ? new Date(dueBy * 1000).toISOString() : (dueBy ?? null),
      amount: Number.isFinite(Number(object?.amount)) ? Number(object.amount) / 100 : null,
      currency: object?.currency ? String(object.currency).toUpperCase() : null,
      updated_at: new Date().toISOString(),
    };
    const metadata = { ...(disputedTx.metadata ?? {}), stripe_dispute: dispute };
    await supabase.from('transactions').update({ metadata }).eq('id', disputedTx.id);
    await this.dispatchToAll({ ...disputedTx, metadata }, 'payment.disputed', {
      transactionId: disputedTx.id,
      status: disputedTx.status,
      dispute,
    }).catch((e: any) => console.error('[WebhookService] dispatch payment.disputed (stripe):', e?.message));
  }

  /**
   * O evento da conta Stripe PRÓPRIA é de uma transação que mandamos para ela?
   *   ok       → a transação é desta conta e do mesmo intent;
   *   retry    → casou pelo metadata, mas a conta/intent ainda não foi gravada;
   *   mismatch → a transação é de outra conta ou de outro intent;
   *   none     → nenhuma transação nossa (venda dele fora da Koopfy).
   */
  private ownStripeTxCheck(
    accountId: string,
    tx: { id: string; provider_account_id?: string | null; provider_transaction_id?: string | null },
    object: any,
  ): 'ok' | 'retry' | 'mismatch' | 'none' {
    if (!tx.provider_account_id || !tx.provider_transaction_id) return 'retry'
    if (tx.provider_account_id !== accountId) return 'mismatch'
    const intentId = typeof object?.payment_intent === 'string'
      ? object.payment_intent
      : (object?.payment_intent?.id ?? (String(object?.id ?? '').startsWith('pi_') ? object.id : null))
    if (intentId && intentId !== tx.provider_transaction_id) return 'mismatch'
    return 'ok'
  }

  // ─── PAYPAL (conta do próprio seller) ─────────────────────────────────────
  //
  // A conta vai no PATH (`/webhook/paypal/paypall_<id>`), como na Stripe: cada
  // app do seller tem o seu webhook_id, e é com ele que o PayPal verifica a
  // assinatura. Sem verificação SUCCESS nada é processado.
  //
  // A captura normalmente já aprovou pelo POST /payments/:id/paypal/capture;
  // aqui chegam a captura pendente que concluiu, a recusa, o reembolso e a
  // disputa. Tudo pelos mesmos caminhos idempotentes dos outros provedores.

  async handlePaypalWebhook(accountId: string, event: any, headers: Record<string, any> = {}) {
    if (!isPaypalOwnAccountId(accountId) || !this.sellerProviders) {
      return { ignored: true, reason: 'unknown account' }
    }
    const account = await this.sellerProviders.getProviderAccountById(accountId)
    if (!account) {
      console.warn('[WebhookService] PayPal: conta desconhecida no path:', accountId)
      return { ignored: true, reason: 'unknown account' }
    }

    const eventType = String(event?.event_type ?? '')
    const eventId = String(event?.id ?? '')

    // THROW, não 2xx, em assinatura inválida ou verificação indisponível: o
    // PayPal reentrega por dias, o que dá janela para corrigir sem perder a
    // venda. Evento forjado só custa retentativas ruidosas.
    const verified = await this.sellerProviders.verifyPaypalWebhook(account, headers, event)
    if (!verified) {
      console.error(`[WebhookService] PayPal: ASSINATURA NÃO VERIFICADA em ${accountId} (${eventType} ${eventId})`)
      throw new Error(`PayPal: assinatura não verificada em ${accountId}`)
    }
    console.log('[PayPal webhook]', accountId, eventType, eventId)

    if (eventId) {
      const { error: dedupeError } = await supabase
        .from('paypal_webhook_events')
        .insert({ event_id: eventId, account_id: accountId, event_type: eventType })
      if (dedupeError) {
        if ((dedupeError as any).code === '23505') return { alreadyProcessed: true }
        // Tabela ausente: os caminhos abaixo já são idempotentes, segue.
        console.error('[WebhookService] PayPal dedupe insert error:', dedupeError.message)
      }
    }

    try {
      return await this.processPaypalEvent(accountId, eventType, event?.resource ?? {})
    } catch (err) {
      if (eventId) await supabase.from('paypal_webhook_events').delete().eq('event_id', eventId)
      throw err
    }
  }

  private async processPaypalEvent(accountId: string, eventType: string, resource: any) {
    const tx = await this.resolvePaypalTx(eventType, resource)
    // O app dele recebe também as vendas de fora da Koopfy: sem transação
    // nossa, ou de outra conta, não é conosco.
    if (!tx) return { ignored: true, reason: 'venda fora da Koopfy' }
    if (!tx.provider_account_id) {
      // A conta é gravada de forma assíncrona no createPayment: 5xx faz o
      // PayPal reentregar quando a linha já estiver completa.
      throw new Error(`PayPal: transação ${tx.id} ainda sem conta gravada (${accountId})`)
    }
    if (tx.provider_account_id !== accountId) {
      console.error(`[WebhookService] 🚨 PayPal: evento de ${accountId} aponta para ${tx.id}, que é de outra conta — ignorado.`)
      return { ignored: true, reason: 'transação de outra conta' }
    }

    if (eventType === 'PAYMENT.CAPTURE.COMPLETED' || eventType === 'PAYMENT.CAPTURE.DENIED') {
      const orderId = resource?.supplementary_data?.related_ids?.order_id ?? null
      if (orderId && tx.provider_transaction_id && orderId !== tx.provider_transaction_id) {
        console.error(`[WebhookService] 🚨 PayPal: captura da order ${orderId} não é a order de ${tx.id} — ignorado.`)
        return { ignored: true, reason: 'order de outra transação' }
      }
      await this.rememberPaypalCapture(tx, resource?.id ?? null)

      if (eventType === 'PAYMENT.CAPTURE.DENIED') {
        return this.handleWebhookProvider({
          reference: tx.id,
          status: 'FAILED',
          type: 'TRANSACTION',
          failure_code: 'PAYPAL_CAPTURE_DENIED',
          failure_message: resource?.status_details?.reason ?? 'O PayPal recusou o pagamento.',
        })
      }

      // Nunca aprova valor ou moeda diferentes do pedido: fica pendente, com
      // alarme, para conciliação — aprovar a transação errada é pior.
      const currency = String(resource?.amount?.currency_code ?? '').toUpperCase()
      const expected = fromPaypalValue(toPaypalValue(tx.amount, tx.currency))
      const received = fromPaypalValue(resource?.amount?.value ?? NaN)
      if (currency !== String(tx.currency).toUpperCase() || received !== expected) {
        console.error(
          `[WebhookService] 🚨 PayPal: VALOR DIVERGENTE em ${tx.id} — esperado ${toPaypalValue(tx.amount, tx.currency)} `
          + `${tx.currency}, capturado ${resource?.amount?.value ?? '?'} ${currency || '?'}. Não aprovado.`,
        )
        return { ignored: true, reason: 'valor divergente' }
      }
      return this.handleWebhookProvider({ reference: tx.id, status: 'PAID', type: 'TRANSACTION' })
    }

    if (eventType === 'PAYMENT.CAPTURE.REFUNDED') {
      return this.refundTransaction(tx.id)
    }

    if (eventType === 'CUSTOMER.DISPUTE.CREATED') {
      const dispute = {
        id: String(resource?.dispute_id ?? ''),
        source: 'paypal',
        status: String(resource?.status ?? 'OPEN').toLowerCase(),
        reason: resource?.reason ?? null,
        due_by: resource?.seller_response_due_date ?? null,
        amount: Number.isFinite(Number(resource?.dispute_amount?.value)) ? Number(resource.dispute_amount.value) : null,
        currency: resource?.dispute_amount?.currency_code ?? null,
        updated_at: new Date().toISOString(),
      }
      const { data: disputedTx } = await supabase.from('transactions').select('*').eq('id', tx.id).maybeSingle()
      if (!disputedTx) return { ignored: true, reason: 'transaction not found' }
      const metadata = { ...(disputedTx.metadata ?? {}), paypal_dispute: dispute }
      await supabase.from('transactions').update({ metadata }).eq('id', disputedTx.id)
      await this.dispatchToAll({ ...disputedTx, metadata }, 'payment.disputed', {
        transactionId: disputedTx.id,
        status: disputedTx.status,
        dispute,
      }).catch((e: any) => console.error('[WebhookService] dispatch payment.disputed (paypal):', e?.message))
      return { received: true, disputed: true }
    }

    return { ignored: true, reason: 'unmapped event' }
  }

  /**
   * Transação do evento. `custom_id` (= transactions.id, posto na order) é o
   * fio primário; reembolso e disputa nem sempre o trazem, e aí vale o id da
   * captura que guardamos na aprovação.
   */
  private async resolvePaypalTx(eventType: string, resource: any): Promise<any | null> {
    const columns = 'id, amount, currency, seller_id, provider_account_id, provider_transaction_id, metadata'
    const disputed = Array.isArray(resource?.disputed_transactions) ? resource.disputed_transactions[0] : null
    const customId = resource?.custom_id ?? disputed?.custom ?? disputed?.custom_id ?? null
    if (customId && /^[0-9a-f-]{36}$/i.test(String(customId))) {
      const { data } = await supabase.from('transactions').select(columns).eq('id', String(customId)).maybeSingle()
      if (data) return data
    }

    // Reembolso: a captura é o link `up`. Disputa: seller_transaction_id.
    const upLink = Array.isArray(resource?.links)
      ? resource.links.find((link: any) => link?.rel === 'up' && /\/captures\//.test(String(link?.href ?? '')))
      : null
    const captureId = eventType === 'PAYMENT.CAPTURE.REFUNDED'
      ? (upLink ? String(upLink.href).split('/captures/')[1]?.split(/[/?]/)[0] : null)
      : eventType === 'CUSTOMER.DISPUTE.CREATED'
        ? disputed?.seller_transaction_id ?? null
        : resource?.id ?? null
    if (captureId) {
      const { data } = await supabase.from('transactions').select(columns)
        .eq('metadata->>paypal_capture_id', String(captureId)).maybeSingle()
      if (data) return data
    }
    return null
  }

  private async rememberPaypalCapture(tx: any, captureId: string | null) {
    if (!captureId || tx.metadata?.paypal_capture_id === captureId) return
    const metadata = { ...(tx.metadata ?? {}), paypal_capture_id: captureId }
    const { error } = await supabase.from('transactions').update({ metadata }).eq('id', tx.id)
    if (error) console.error('[WebhookService] PayPal: captura não guardada:', error.message)
    tx.metadata = metadata
  }

  // ─────────────────────────────────────────────
  // Resolve transactions.id a partir do objeto da Stripe.
  //
  // Ordem importa: o metadata é o fio PRIMÁRIO (posto em StripeProvider.charge
  // e devolvido em todo evento do intent). Os demais são rede de segurança —
  // eventos de Charge, por exemplo, nem sempre carregam o metadata do intent.
  // ─────────────────────────────────────────────

  private async resolveStripeTx(object: any): Promise<{
    id: string; amount?: number; currency?: string; seller_id?: string;
    provider_account_id?: string | null; provider_transaction_id?: string | null
  } | null> {
    // 1) PRIMÁRIO — nosso transactions.id, ida e volta pelo metadata.
    const txId = object?.metadata?.koopfy_transaction_id
    if (txId) {
      const { data } = await supabase
        .from('transactions')
        .select('id, amount, currency, seller_id, provider_account_id, provider_transaction_id')
        .eq('id', String(txId)).maybeSingle()
      if (data) return data
    }

    // 2) PaymentIntent id — gravado como provider_transaction_id no charge.
    const intentId = typeof object?.payment_intent === 'string'
      ? object.payment_intent
      : (object?.payment_intent?.id ?? (String(object?.id ?? '').startsWith('pi_') ? object.id : null))

    if (intentId) {
      const { data } = await supabase
        .from('transactions').select('id, amount, currency, provider_account_id, provider_transaction_id')
        .eq('provider_transaction_id', String(intentId)).maybeSingle()
      if (data) return data
    }

    return null
  }

  private warnOnStripeAmountMismatch(tx: { id: string; amount?: number; currency?: string }, object: any) {
    const raw = Number(object?.amount_received ?? object?.amount ?? NaN)
    if (!Number.isFinite(raw) || tx.amount == null) return

    // O valor volta na MENOR UNIDADE DA MOEDA, que não é centavo em toda moeda.
    // Sem desfazer a conversão do StripeProvider.toStripeAmount, JPY divergiria
    // por 100x em TODA venda — e um alerta que dispara sempre é um alerta que
    // ninguém lê no dia em que ele estiver certo.
    const currency = String(object?.currency ?? tx.currency ?? '').toUpperCase()
    const received = STRIPE_ZERO_DECIMAL.has(currency) ? raw * 100
      : STRIPE_THREE_DECIMAL.has(currency) ? raw / 10
        : raw

    if (Math.abs(received - Number(tx.amount)) > 1) {
      console.error(
        `[WebhookService] Stripe: VALOR DIVERGENTE na transação ${tx.id} — `
        + `esperado ${tx.amount} ${tx.currency ?? '?'}, recebido ${received} `
        + `${object?.currency?.toUpperCase() ?? '?'}. Provável associação errada `
        + '(metadata reaproveitado ou intent reusado). Não bloqueia, mas confira.',
      )
    }
  }

  // ─────────────────────────────────────────────
  // Assinatura da Stripe (header `stripe-signature`)
  //
  // Formato: t=<unix>,v1=<hex>[,v1=<hex>...]
  // Payload assinado: `${t}.${rawBody}`, HMAC-SHA256 com o whsec_ COMO STRING
  // (não decodificado de base64 — erro clássico, e o sintoma é "assinatura
  // inválida em TODO evento").
  //
  // Feito à mão em vez de stripe.webhooks.constructEvent de propósito: o
  // construtor do SDK exige uma secret key válida, e o webhook precisa
  // funcionar mesmo quando a chave da conta foi revogada pela Stripe — que é
  // exatamente o cenário em que os eventos importantes chegam.
  // ─────────────────────────────────────────────

  private verifyStripeSignature(
    rawBody: string,
    headers: Record<string, string>,
    secret: string,
  ): { valid: boolean; reason?: string } {
    const header = headers['stripe-signature'] ?? headers['Stripe-Signature']
    if (!header) return { valid: false, reason: 'header stripe-signature ausente' }

    let timestamp: string | null = null
    const signatures: string[] = []

    for (const part of String(header).split(',')) {
      const [k, v] = part.split('=', 2)
      if (k?.trim() === 't') timestamp = v?.trim() ?? null
      if (k?.trim() === 'v1' && v) signatures.push(v.trim())
    }

    if (!timestamp) return { valid: false, reason: 'timestamp ausente no header' }
    if (signatures.length === 0) return { valid: false, reason: 'nenhuma assinatura v1 no header' }

    // Janela de tolerância: é o que impede replay de um payload legítimo
    // capturado. Sem ela, quem gravar um payment_intent.succeeded pode
    // reenviá-lo para sempre.
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp))
    if (!Number.isFinite(age) || age > STRIPE_SIGNATURE_TOLERANCE_S) {
      return { valid: false, reason: `timestamp fora da tolerância (${age}s)` }
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex')

    const expectedBuf = Buffer.from(expected, 'hex')

    // timingSafeEqual em todas as v1 (a Stripe manda mais de uma durante a
    // rotação do segredo — comparar só a primeira quebra exatamente no
    // momento em que você está rotacionando).
    const match = signatures.some(sig => {
      const sigBuf = Buffer.from(sig, 'hex')
      return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)
    })

    return match ? { valid: true } : { valid: false, reason: 'HMAC não confere' }
  }

  private async resolveSentinelTxId(body: any): Promise<string | null> {
    // 1) PRIMÁRIO: provider_transaction_id == sentinel_transaction_id. É o id ÚNICO
    //    da Sentinel, gravado na criação do hosted (antes do redirect) — a associação
    //    mais confiável, sem depender do order_id (que é humano e pode colidir).
    const sentinelTxnId = body?.sentinel_transaction_id ?? body?.transaction_id ?? null
    if (sentinelTxnId) {
      const { data } = await supabase
        .from('transactions').select('id')
        .eq('provider_transaction_id', sentinelTxnId).maybeSingle()
      if (data) return data.id
    }

    // 2) Fallback por order_id (caso o webhook não traga o sentinel_transaction_id).
    const ref = body?.wc_order_id ?? body?.order_id ?? body?.reference ?? null
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (ref) {
      // 2a) Compat: fluxo antigo enviava order_id = transactions.id (UUID).
      if (UUID_RE.test(String(ref))) {
        const { data } = await supabase
          .from('transactions').select('id').eq('id', ref).maybeSingle()
        if (data) return data.id
      }
      // 2b) Fluxo atual: order_id = order_number (humano) → external_reference.
      //     Pega a transação mais recente (cobre retries com o mesmo número).
      const { data: byRef } = await supabase
        .from('transactions').select('id')
        .eq('external_reference', String(ref))
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle()
      if (byRef) return byRef.id
    }

    return null
  }

  // Verificação da assinatura do webhook do Sentinel.
  // Header: X-Sentinel-Signature: sha256=<hmac_hex>
  // HMAC-SHA256 do corpo BRUTO usando o Webhook Secret (env SENTINEL_WEBHOOK).
  private verifySentinelSignature(rawBody: string, headers: Record<string, string>): boolean {
    const secret = process.env.SENTINEL_WEBHOOK
    const signature = headers['x-sentinel-signature'] ?? null

    if (!secret) {
      console.error('[WebhookService] SENTINEL_WEBHOOK não configurado — rejeitando webhook')
      return false
    }
    if (!signature) return false

    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex')

    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    } catch {
      return false
    }
  }

  // ─── REFUND ───────────────────────────────────────────────────────────────
  // Reverte uma transação estornada. O estorno é dirigido pelas entradas REAIS
  // de crédito no ledger (credit_pending / credit_platform_fee /
  // credit_external_fee), revertendo cada uma do bucket onde o dinheiro está.
  // Assim só debitamos o que foi de fato creditado, no lugar certo.
  private async refundTransaction(reference: string) {
    const { data: tx } = await supabase
      .from('transactions').select('*').eq('id', reference).single()

    if (!tx) {
      console.warn('[WebhookService] refund: transação não encontrada:', reference)
      return { ignored: true, reason: 'transaction not found' }
    }
    if (tx.status === 'refunded') return { alreadyProcessed: true }

    const now = new Date().toISOString()

    // 1) Marca a transação como refunded (idempotente via .neq)
    const { data: updated } = await supabase
      .from('transactions')
      .update({
        status: 'refunded',
        provider_status: 'refunded',
        processed_at: now,
        webhook_sent: true,
        last_webhook_at: now,
        updated_at: new Date(),
      })
      .eq('id', tx.id)
      .neq('status', 'refunded')
      .select()

    if (!updated || updated.length === 0) return { alreadyProcessed: true }

    // 2) Reverte o net do seller e cobra dele a taxa da Koopfy, que não é
    //    reembolsável: o comprador recebe o bruto de volta, então o seller
    //    arca com o valor cheio (crédito + reserva + taxa). Ver refund-fee.ts.
    const { data: credits } = await supabase
      .from('wallet_ledger')
      .select('seller_id, type, amount, status')
      .eq('transaction_id', tx.id)
      .eq('type', 'credit_pending')

    // Lida ANTES do cancel_reserve_hold: reserva ainda presa fica com a Koopfy
    // e conta como parte do que o seller devolve.
    const { data: reserves } = await supabase
      .from('wallet_ledger')
      .select('amount')
      .eq('transaction_id', tx.id)
      .eq('type', 'reserve_hold')
      .eq('status', 'hold')

    let creditedCents = 0
    for (const c of credits ?? []) {
      if (!c.amount || c.amount <= 0) continue

      // credit_pending pode estar em pending (não liquidado) ou available (liquidado)
      const bucket = c.status === 'completed' ? 'available' : 'pending'
      await this.reverseBalance(c.seller_id, bucket, c.amount, tx.id, 'refund')
      creditedCents += Number(c.amount)

      // Sem crédito (conta Whop do próprio seller) não há taxa a cobrar aqui.
      const feeCents = refundFeeCents({
        grossUsdCents: tx.amount_usd_gross_cents,
        creditedCents,
        reserveHeldCents: (reserves ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0),
        feeCents: tx.fee,
        externalFeeCents: tx.external_fee_cents,
      })
      if (feeCents > 0) await this.reverseBalance(c.seller_id, bucket, feeCents, tx.id, 'refund_fee')

      // Estorno feito pela Whop cobra a taxa de chargeback do seller. Mesmo tipo
      // do alerta: reverseBalance é idempotente por transação + tipo e o aceite
      // de chargeback no CRM não cobra de novo — uma taxa por venda.
      if (isWhopInitiatedRefund(tx)) {
        const sellerFees = await getEffectiveSellerFees(c.seller_id)
        const chargebackFeeCents = Math.round(sellerFees.chargebackFeeUsd * 100)
        if (chargebackFeeCents > 0) {
          await this.reverseBalance(c.seller_id, bucket, chargebackFeeCents, tx.id, 'chargeback_alert_fee')
        }
      }
      break // um credit_pending por venda (unique transaction_id + type)
    }

    // Reserva da venda estornada não volta ao seller.
    const { error: reserveError } = await supabase.rpc('cancel_reserve_hold', { p_transaction_id: tx.id, p_reason: 'refunded' })
    if (reserveError) console.error('[WebhookService] refund: reserva não cancelada (reconciliar):', reserveError.message)

    // 3) Notifica o seller
    await this.dispatchToAll(tx, 'payment.refunded', {
      status: 'refunded',
      transactionId: tx.id,
      amount: tx.amount,
      currency: tx.currency,
      amountUsd: tx.amount_usd_net_cents,
    })

    return { refunded: true }
  }

  // Debita um bucket e registra o lançamento de estorno (idempotente por
  // transaction_id+type). Se o saldo for insuficiente, NÃO trava: marca o
  // lançamento para reconciliação manual e segue (retornamos 200 ao provider).
  private async reverseBalance(
    walletRef: string,
    bucket: string,
    amountCents: number,
    txId: string,
    ledgerType: string,
  ): Promise<void> {
    const { data: existing } = await supabase
      .from('wallet_ledger')
      .select('id')
      .eq('transaction_id', txId)
      .eq('type', ledgerType)
      .maybeSingle()

    if (existing) return // já revertido

    const { error: rpcError } = await supabase.rpc('debit_balance', {
      p_seller_id: walletRef,
      p_bucket: bucket,
      p_amount_cents: amountCents,
    })

    await supabase.from('wallet_ledger').insert({
      seller_id: walletRef,
      transaction_id: txId,
      type: ledgerType,
      amount: amountCents,
      currency: 'USD',
      status: rpcError ? 'failed' : 'completed',
      metadata: rpcError
        ? { bucket, reconciliation: true, error: rpcError.message }
        : { bucket },
      created_at: new Date().toISOString(),
    })

    if (rpcError) {
      console.error(
        `[WebhookService] refund debit falhou (${ledgerType}) wallet=${walletRef} ` +
        `bucket=${bucket} amount=${amountCents}: ${rpcError.message} — marcado p/ reconciliação`,
      )
    }
  }

  // ─── Dispatch para todas as URLs (inalterado) ─────────────────────────────

  private async dispatchToAll(tx: any, event: string, data: Record<string, any>): Promise<void> {
    const { data: profile } = await supabase
      .from('seller_profiles').select('metadata').eq('id', tx.seller_id).maybeSingle()

    const webhookSecret = profile?.metadata?.webhookSecret ?? null
    const sellerUrl = profile?.metadata?.webhookUrl ?? null
    const transactionUrl = tx.postback_url ?? null

    const urls = [...new Set([transactionUrl, sellerUrl].filter(Boolean) as string[])]
    if (urls.length === 0) return

    await Promise.allSettled(
      urls.map(url => this.dispatchPostback(tx, event, data, url, webhookSecret))
    )
  }

  // ─── Dispatch para URL específica (inalterado) ────────────────────────────

  private async dispatchPostback(
    tx: any,
    event: string,
    data: Record<string, any>,
    webhookUrl: string,
    webhookSecret: string | null,
  ): Promise<void> {

    const payload = {
      id: `evt_${Date.now()}`,
      event,
      created_at: new Date().toISOString(),
      data: {
        ...data,
        externalReference: tx.external_reference,
        metadata: tx.metadata ?? {},
      },
    }


    const body = JSON.stringify(payload)

    const signature = webhookSecret
      ? 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(body).digest('hex')
      : null

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Nexor-Webhooks/1.0',
    }
    if (signature) headers['X-Nexor-Signature'] = signature

    let lastError: string | null = null
    let delivered = false

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10_000)

        const res = await fetch(webhookUrl, { method: 'POST', headers, body, signal: controller.signal })
        clearTimeout(timeout)

        if (res.ok) { delivered = true; break }
        lastError = `HTTP ${res.status}`
      } catch (err: any) {
        lastError = err.message
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000))
      }
    }

    if (webhookUrl === tx.postback_url) {
      const now = new Date().toISOString()
      await supabase.from('transactions').update({
        webhook_status: delivered ? 'delivered' : 'failed',
        webhook_last_error: delivered ? null : lastError,
        webhook_delivered_at: delivered ? new Date() : null,
        last_webhook_at: now,
      }).eq('id', tx.id)

      await supabase.rpc('increment_webhook_attempts', { p_tx_id: tx.id }).then(() => { })
    }

    if (!delivered) {
      console.warn(`[WebhookService] Postback falhou → ${webhookUrl} (tx: ${tx.id}): ${lastError}`)
    }
  }

  async replayWaylinxWebhooks() {
    const POSTBACK_URL = 'https://api.koopfy.com/webhook/nexor';
    const PAGE_SIZE = 500;
    const CONCURRENCY = 5;  // disparos paralelos por lote

    let from = 0;
    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;

    console.log(`[ReplayWebhooks] Starting replay for postback_url=${POSTBACK_URL}`);

    while (true) {
      // 1) Busca lote paginado
      const { data: transactions, error } = await supabase
        .from('transactions')
        .select('id, status')
        .eq('postback_url', POSTBACK_URL)
        .order('created_at', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (error) {
        console.error(`[ReplayWebhooks] Query failed at offset=${from}: ${error.message}`);
        throw error;
      }

      if (!transactions || transactions.length === 0) {
        break;  // chegou ao fim
      }

      console.log(
        `[ReplayWebhooks] Fetched ${transactions.length} transactions ` +
        `(offset=${from})`
      );

      // 2) Dispara em chunks com concorrência limitada
      for (let i = 0; i < transactions.length; i += CONCURRENCY) {
        const chunk = transactions.slice(i, i + CONCURRENCY);

        const results = await Promise.allSettled(
          chunk.map(tx => {
            const body = {
              reference: tx.id,
              status: 'PAID',
              type: 'TRANSACTION',
            };
            return this.handleWebhookProvider(body);
          }),
        );

        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          const tx = chunk[j];
          totalProcessed++;

          if (r.status === 'fulfilled') {
            totalSucceeded++;
          } else {
            totalFailed++;
            console.error(
              `[ReplayWebhooks] Failed tx=${tx.id}: ` +
              `${(r.reason as any)?.message ?? r.reason}`
            );
          }
        }
      }

      // Se veio menos que o page size, chegou ao fim
      if (transactions.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    const summary = {
      processed: totalProcessed,
      succeeded: totalSucceeded,
      failed: totalFailed,
    };

    console.log(`[ReplayWebhooks] Done:`, summary);
    return summary;
  }
}

function sanitizedWebhookCorrelation(webhookId: string | undefined): string {
  if (!webhookId) return 'event-without-id'
  return `event-${crypto.createHash('sha256').update(webhookId).digest('hex').slice(0, 12)}`
}
