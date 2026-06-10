// nexor/src/webhooks/webhook.service.ts

import { Injectable } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { WalletService } from '../wallets/wallet.service'
import { AccountRouterService } from '../orchestrator/router/account-router.service'
import * as crypto from 'crypto'

@Injectable()
export class WebhookService {

  constructor(
    private readonly walletService: WalletService,
    private readonly router: AccountRouterService,
  ) { }

  async handleWebhookProvider(body: any) {

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

      const { error: updateError } = await supabase
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

      // ── Side effects ─────────────────────────────────────────────────

      // 1) Crédito pendente na wallet (com external_fee se houver)
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
      await this.dispatchToAll(tx, 'payment.approved', {
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

      await this.dispatchToAll(tx, 'payment.failed', {
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
    const POSTBACK_URL = 'https://api.waylinxpay.com/webhook/nexor';
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