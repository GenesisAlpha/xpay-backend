// Bandeira do cartão nas transações Whop antigas.
//
// Até o webhook passar a gravar card_brand/card_last4 (webhooks/whop-card.ts),
// toda compra pela Whop ficou com a bandeira 'unknown' que o checkout manda.
// Aqui cada pagamento é buscado na API da Whop e a bandeira vai para a
// transação — daí o checkout copia para o pedido (/internal/orders/backfill-card
// de lá, que lê GET /payments/:id/status).
//
// Idempotente: transação conferida ganha whop_card_checked_at e não volta a ser
// buscada, tenha cartão ou não (Pix, Cash App…).

import { Injectable } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { WhopProvider } from '../orchestrator/providers/whop.provider'
import { AccountRouterService } from '../orchestrator/router/account-router.service'
import { whopCardOf } from '../webhooks/whop-card'

export interface WhopCardBackfillResult {
  scanned: number
  updated: number
  withoutCard: number
  failed: number
  /** Ainda há transações a conferir: rode de novo. */
  more: boolean
}

@Injectable()
export class WhopCardBackfillService {
  constructor(private readonly accountRouter: AccountRouterService) {}

  async run(opts: { limit?: number; sinceDays?: number } = {}): Promise<WhopCardBackfillResult> {
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500)
    const since = new Date(Date.now() - (Math.min(Math.max(Number(opts.sinceDays) || 365, 1), 730) * 86_400_000)).toISOString()

    const { data: rows, error } = await supabase
      .from('transactions')
      .select('id, provider, provider_account_id, metadata')
      .ilike('provider', '%whop%')
      .in('status', ['approved', 'refunded'])
      .not('metadata->>whop_payment_id', 'is', null)
      .is('metadata->>whop_card_checked_at', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw error

    const result: WhopCardBackfillResult = { scanned: rows?.length ?? 0, updated: 0, withoutCard: 0, failed: 0, more: (rows?.length ?? 0) === limit }
    const whop = new WhopProvider()
    const accounts = new Map<string, any>()

    for (const tx of rows ?? []) {
      try {
        const accountId = String(tx.provider_account_id ?? '')
        if (!accounts.has(accountId)) accounts.set(accountId, accountId ? await this.accountRouter.resolveAccountById(accountId) : null)
        const account = accounts.get(accountId)
        if (!account?.apiKey) {
          result.failed += 1
          continue
        }

        const { raw } = await whop.getPaymentStatus(String(tx.metadata.whop_payment_id), account)
        const card = whopCardOf(raw)
        const patch: Record<string, unknown> = { whop_card_checked_at: new Date().toISOString() }
        if (card.brand) patch.whop_card_brand = card.brand
        if (card.last4) patch.whop_card_last4 = card.last4
        if (card.methodType) patch.whop_payment_method_type = card.methodType

        const { error: updateError } = await supabase
          .from('transactions')
          .update({
            metadata: { ...(tx.metadata ?? {}), ...patch },
            ...(card.brand ? { payment_brand: card.brand } : {}),
            ...(card.last4 ? { payment_last4: card.last4 } : {}),
          })
          .eq('id', tx.id)
        if (updateError) throw updateError

        if (card.brand) result.updated += 1
        else result.withoutCard += 1
      } catch (err: any) {
        // Falha pontual (Whop fora, pagamento apagado): fica sem marca e volta na próxima rodada.
        result.failed += 1
        console.error(`[WhopCardBackfill] tx ${tx.id}:`, err?.message ?? err)
      }
    }
    return result
  }
}
