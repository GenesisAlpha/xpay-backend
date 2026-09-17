import { Injectable } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { DEFAULT_PAYOUT_CYCLE, normalizeCycle } from './payout-cycle'

/**
 * Leitura das comissões de um afiliado.
 *
 * A fonte é `affiliate_commissions`, que espelha o wallet_ledger guardando a
 * base de cálculo — sem ela o afiliado não consegue responder "por que recebi
 * este valor".
 */
@Injectable()
export class AffiliateEarningsService {

  /** Totais por estágio, em centavos de USD, mais o ciclo de pagamento. */
  async summary(affiliateSellerId: string) {
    const cycle = await this.cycleOf(affiliateSellerId)

    const { data } = await supabase
      .from('affiliate_commissions')
      .select('commission_cents, status, source_seller_id, available_at')
      .eq('affiliate_seller_id', affiliateSellerId)

    const rows = (data ?? []) as Array<{
      commission_cents: number
      status: string
      source_seller_id: string
      available_at: string
    }>

    const sum = (status: string) =>
      rows.filter(r => r.status === status).reduce((t, r) => t + Number(r.commission_cents ?? 0), 0)

    // Próxima data em que algo pendente vira sacável — é o que o afiliado
    // quer saber quando vê saldo travado.
    const nextRelease = rows
      .filter(r => r.status === 'pending')
      .map(r => r.available_at)
      .sort()[0] ?? null

    return {
      currency: 'USD',
      pendingCents: sum('pending'),
      availableCents: sum('available'),
      paidCents: sum('paid'),
      // Indicados que já geraram pelo menos uma comissão.
      earningSellers: new Set(rows.map(r => r.source_seller_id)).size,
      commissionCount: rows.length,
      nextReleaseAt: nextRelease,
      // O afiliado precisa saber a regra, não só a próxima data: sem isso
      // "por que meu saldo não caiu ainda" vira ticket.
      cycle,
    }
  }

  /** Ciclo do afiliado, ou o padrão da plataforma. */
  private async cycleOf(affiliateSellerId: string) {
    const { data } = await supabase
      .from('affiliate_payout_cycles')
      .select('payout_day, hold_days')
      .eq('affiliate_seller_id', affiliateSellerId)
      .maybeSingle()

    if (!data) return DEFAULT_PAYOUT_CYCLE

    return normalizeCycle({ payoutDay: data.payout_day, holdDays: data.hold_days })
  }

  /** Extrato, do mais recente para o mais antigo. */
  async list(affiliateSellerId: string, limit = 50) {
    const { data } = await supabase
      .from('affiliate_commissions')
      .select('id, transaction_id, source_seller_id, platform_fee_cents, commission_rate_pct, commission_cents, currency, status, available_at, created_at')
      .eq('affiliate_seller_id', affiliateSellerId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 200))

    return { commissions: data ?? [] }
  }
}
