import { Injectable } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { WebhookService } from './webhook.service'
import { WhopConnectService } from '../orchestrator/whop/whop-connect.service'
import { WhopConnectedPayoutService } from '../orchestrator/whop/whop-connected-payout.service'
import {
  checkConnectedEventOwnership,
  connectedWebhookSecret,
  extractWhopEventAccountId,
  extractWhopEventMetadata,
  toConnectedProviderAccountId,
  verifyWhopWebhookSignature,
} from '../orchestrator/whop/whop-connected'

// ══════════════════════════════════════════════════════════════════════════
// WHOP — eventos das CONTAS CONECTADAS
// ══════════════════════════════════════════════════════════════════════════
//
// Padrão: o webhook da master com "eventos de contas conectadas" ligado. Os
// eventos chegam na mesma URL da master, com o mesmo segredo
// (WHOP_WEBHOOK_SECRET), e o controller desvia para cá os que vêm de uma
// conta conectada (isConnectedEvent). /webhook/whop/connected continua
// valendo para um webhook separado (WHOP_CONNECTED_WEBHOOK_SECRET). O
// envelope diz de qual conta veio (`account_id`, ou `company_id` se fixado
// antes de 2026-08-14).
//
// Pagamento, reembolso, disputa e assinatura seguem o MESMO pipeline das
// contas do pool (WebhookService.handleWhopWebhook), com a conta 'whopc_<biz>'.
// Antes disso, a posse: o evento só toca transação do seller dono da conta.
// ══════════════════════════════════════════════════════════════════════════

const ACCOUNT_SYNC_EVENTS = new Set([
  'account.updated',
  'verification.succeeded',
  'payout_account.status_updated',
])

const TRANSACTION_EVENT_PREFIXES = ['payment.', 'refund.', 'dispute.', 'membership.']

@Injectable()
export class WhopConnectedWebhookService {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly connect: WhopConnectService,
    // Opcional só para os testes antigos; em produção o módulo sempre injeta.
    private readonly payouts?: WhopConnectedPayoutService,
  ) { }

  /**
   * O evento que chegou na URL da master é de uma conta conectada da Koopfy?
   * Sem account_id, ou com o id da própria master, segue o fluxo da master.
   * Só olha o envelope e a tabela; a assinatura é conferida em handle.
   */
  async isConnectedEvent(body: any): Promise<boolean> {
    const whopAccountId = extractWhopEventAccountId(body)
    if (!whopAccountId) return false
    if (whopAccountId === process.env.WHOP_COMPANY_ID?.trim()) return false
    const row = await this.connect.getRowByWhopAccount(whopAccountId).catch(() => null)
    return Boolean(row)
  }

  async handle(body: any, rawBody: string, headers: Record<string, string>) {
    const secret = connectedWebhookSecret()
    if (!secret) {
      // THROW (5xx): com 2xx a Whop dá o evento por entregue e ele se perde.
      console.error('[WhopConnectedWebhook] WHOP_WEBHOOK_SECRET (ou WHOP_CONNECTED_WEBHOOK_SECRET) ausente — evento recusado')
      throw new Error('Whop: WHOP_WEBHOOK_SECRET / WHOP_CONNECTED_WEBHOOK_SECRET ausente')
    }

    const verification = verifyWhopWebhookSignature(rawBody, headers, secret)
    if (!verification.valid) {
      console.error(`[WhopConnectedWebhook] assinatura inválida: ${verification.reason}`)
      throw new Error(`Whop: assinatura inválida (${verification.reason})`)
    }

    const eventType = String(body?.type ?? '')
    const whopAccountId = extractWhopEventAccountId(body)
    if (!whopAccountId) {
      console.warn('[WhopConnectedWebhook] evento sem account_id:', eventType)
      return { ignored: true, reason: 'no account' }
    }

    const row = await this.connect.getRowByWhopAccount(whopAccountId)
    if (!row) {
      console.warn(`[WhopConnectedWebhook] conta ${whopAccountId} não é conectada da Koopfy (${eventType})`)
      return { ignored: true, reason: 'unknown account' }
    }

    const providerAccountId = toConnectedProviderAccountId(whopAccountId)

    if (ACCOUNT_SYNC_EVENTS.has(eventType) || eventType.startsWith('identity_profile.')) {
      await this.connect.sync(row.seller_id)
      return { synced: true }
    }

    // Saque da conta conectada: adianta o que está em andamento e pega o
    // estorno de um saque já pago (payout.reversed). Precisa da família
    // `payout.*` assinada no webhook da Whop.
    if (eventType.startsWith('payout.')) {
      if (!this.payouts) return { ignored: true, reason: 'saque automático indisponível' }
      return this.payouts.handlePayoutEvent(eventType, body?.data ?? {}, whopAccountId)
    }

    if (eventType === 'dispute_alert.created') {
      const data = body?.data ?? {}
      await this.connect.recordRiskSignal({
        eventId: String(data?.id ?? body?.id ?? `alert_${Date.now()}`),
        sellerId: row.seller_id,
        whopAccountId,
        kind: 'dispute_alert',
        amountCents: this.minorUnits(data?.amount),
        currency: data?.currency ?? null,
        reason: data?.reason ?? data?.alert_type ?? null,
        payload: { eventType, status: data?.status ?? null },
      })
      return { received: true, alert: true }
    }

    if (!TRANSACTION_EVENT_PREFIXES.some(prefix => eventType.startsWith(prefix))) {
      return { ignored: true, reason: `evento não tratado: ${eventType}` }
    }

    const metadata = extractWhopEventMetadata(body)
    const transactionId = metadata?.koopfy_transaction_id ? String(metadata.koopfy_transaction_id) : null
    const { data: transaction } = transactionId
      ? await supabase.from('transactions').select('id, seller_id, provider_account_id').eq('id', transactionId).maybeSingle()
      : { data: null as any }

    const ownership = checkConnectedEventOwnership({
      connectedSellerId: row.seller_id,
      providerAccountId,
      metadata,
      transaction,
    })
    // `'reason' in`, não `!ownership.ok`: sem strictNullChecks o TS não
    // estreita união por literal booleano.
    if ('reason' in ownership) {
      // 2xx de propósito: reentregar não muda a posse, e o evento não pode
      // aprovar nem estornar transação de outro seller.
      console.error(
        `[WhopConnectedWebhook] 🚨 evento ${eventType} da conta ${whopAccountId} (seller ${row.seller_id}) `
        + `RECUSADO: ${ownership.reason}`,
      )
      return { ignored: true, reason: 'ownership mismatch' }
    }

    const result = await this.webhooks.handleWhopWebhook(providerAccountId, body, rawBody, headers)

    if (eventType === 'dispute.created' || eventType === 'refund.created') {
      const data = body?.data ?? {}
      const eventId = String(data?.id ?? body?.id)
      await this.connect.recordRiskSignal({
        eventId,
        sellerId: row.seller_id,
        whopAccountId,
        kind: eventType === 'dispute.created' ? 'dispute' : 'refund',
        transactionId: transaction?.id ?? null,
        amountCents: this.minorUnits(data?.amount ?? data?.payment?.amount),
        currency: data?.currency ?? data?.payment?.currency ?? null,
        reason: data?.reason ?? null,
        payload: { eventType, status: data?.status ?? null },
      })

      // A conta do seller fica zerada: o reembolso/chargeback a deixa
      // negativa. Cobre com a master agora; se o débito ainda não caiu, o
      // ciclo de 30 min pega depois. Falhar aqui não pode derrubar o evento.
      await this.connect.coverNegativeBalance(row.seller_id, eventId).catch((err: any) =>
        console.error(`[WhopConnectedWebhook] cobertura do negativo do seller ${row.seller_id}:`, err?.message))
    }

    return result
  }

  // A Whop reporta em unidade principal (o mesmo formato de initial_price).
  private minorUnits(amount: any): number | null {
    const value = Number(amount)
    return Number.isFinite(value) ? Math.round(value * 100) : null
  }
}
