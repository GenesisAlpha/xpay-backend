import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { DEFAULT_PAYOUT_CYCLE, normalizeCycle } from './payout-cycle'

/**
 * Operação do programa de indicação, para o CRM.
 *
 * Aqui mora o que o time precisa para rodar o programa: quem está gerando
 * comissão, quanto já saiu, e o sinal de risco de cada afiliado.
 */

export interface AffiliateCrmContext {
  managerId: string
  ip?: string
  userAgent?: string
}

interface CrmAffiliateRow {
  affiliate_seller_id: string
  commission_count: number
  earning_sellers: number
  total_cents: number
  pending_cents: number
  available_cents: number
  paid_cents: number
  first_commission_at: string
  last_commission_at: string
}

@Injectable()
export class AffiliateCrmService {
  private readonly logger = new Logger(AffiliateCrmService.name)

  /** Afiliados que já geraram comissão, do maior volume para o menor. */
  async list(limit = 100) {
    const { data, error } = await supabase
      .from('v_crm_affiliates')
      .select('*')
      .order('total_cents', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 500))

    if (error) throw new BadRequestException('Falha ao listar afiliados: ' + error.message)

    const rows = (data ?? []) as CrmAffiliateRow[]
    const cycles = await this.cyclesFor(rows.map(r => r.affiliate_seller_id))

    return {
      affiliates: rows.map(row => ({
        affiliateSellerId: row.affiliate_seller_id,
        commissionCount: row.commission_count,
        earningSellers: row.earning_sellers,
        totalCents: row.total_cents,
        pendingCents: row.pending_cents,
        availableCents: row.available_cents,
        paidCents: row.paid_cents,
        firstCommissionAt: row.first_commission_at,
        lastCommissionAt: row.last_commission_at,
        cycle: cycles.get(row.affiliate_seller_id) ?? DEFAULT_PAYOUT_CYCLE,
      })),
    }
  }

  /**
   * Detalhe de um afiliado, com o sinal que importa para fraude: a saúde das
   * contas que ele indicou.
   *
   * Um afiliado que traz volume mas cujos indicados vivem em disputa está
   * custando dinheiro, não gerando — e isso só aparece olhando os indicados.
   */
  async detail(affiliateSellerId: string) {
    const [{ data: referrals }, { data: commissions }] = await Promise.all([
      supabase
        .from('seller_referrals')
        .select('seller_id, affiliate_code, commission_rate_pct, expires_at, created_at')
        .eq('affiliate_seller_id', affiliateSellerId),
      supabase
        .from('affiliate_commissions')
        .select('source_seller_id, commission_cents, status, created_at')
        .eq('affiliate_seller_id', affiliateSellerId),
    ])

    const referredSellerIds = (referrals ?? []).map(r => r.seller_id)
    const risk = await this.riskOf(referredSellerIds)

    return {
      affiliateSellerId,
      cycle: (await this.cyclesFor([affiliateSellerId])).get(affiliateSellerId) ?? DEFAULT_PAYOUT_CYCLE,
      referrals: referrals ?? [],
      commissions: commissions ?? [],
      risk,
    }
  }

  /** Define o ciclo de pagamento do afiliado. */
  async setCycle(
    ctx: AffiliateCrmContext,
    affiliateSellerId: string,
    input: { payoutDay?: number; holdDays?: number },
  ) {
    // Sanitiza antes de gravar: isto vira data de pagamento de dinheiro real.
    const cycle = normalizeCycle(input)

    const { error } = await supabase
      .from('affiliate_payout_cycles')
      .upsert({
        affiliate_seller_id: affiliateSellerId,
        payout_day: cycle.payoutDay,
        hold_days: cycle.holdDays,
        updated_by: ctx.managerId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'affiliate_seller_id' })

    if (error) throw new BadRequestException('Falha ao gravar o ciclo: ' + error.message)

    await this.audit(ctx, 'affiliate.cycle_updated', affiliateSellerId, cycle)

    // Só vale para comissões novas — as já apuradas mantêm a data prometida.
    return { ...cycle, appliesTo: 'new_commissions' }
  }

  /**
   * Muda a alíquota do afiliado sobre o platform_fee.
   *
   * Vale para comissões futuras. As já apuradas guardam a alíquota usada, então
   * o extrato antigo continua conferindo.
   */
  async setRate(ctx: AffiliateCrmContext, affiliateSellerId: string, ratePct: number) {
    if (!Number.isFinite(ratePct) || ratePct <= 0 || ratePct >= 100) {
      throw new BadRequestException('A alíquota deve estar entre 0 e 100.')
    }

    const { error } = await supabase
      .from('seller_referrals')
      .update({ commission_rate_pct: ratePct, updated_at: new Date().toISOString() })
      .eq('affiliate_seller_id', affiliateSellerId)

    if (error) throw new BadRequestException('Falha ao gravar a alíquota: ' + error.message)

    await this.audit(ctx, 'affiliate.rate_updated', affiliateSellerId, { ratePct })

    return { ratePct, appliesTo: 'new_commissions' }
  }

  /**
   * Encerra os vínculos do afiliado.
   *
   * Não apaga nada: fecha a janela agora, então para de acumular daqui pra
   * frente e o que já foi apurado continua devido. Suspensão que confisca
   * comissão já ganha é decisão jurídica, não de botão.
   */
  async suspend(ctx: AffiliateCrmContext, affiliateSellerId: string, reason?: string) {
    const now = new Date().toISOString()

    const { error } = await supabase
      .from('seller_referrals')
      .update({ expires_at: now, updated_at: now })
      .eq('affiliate_seller_id', affiliateSellerId)
      .gt('expires_at', now)

    if (error) throw new BadRequestException('Falha ao encerrar os vínculos: ' + error.message)

    await this.audit(ctx, 'affiliate.suspended', affiliateSellerId, { reason: reason ?? null })

    return { suspended: true }
  }

  // ─── Internos ──────────────────────────────────────────────────────────────

  private async cyclesFor(ids: string[]) {
    const map = new Map<string, { payoutDay: number; holdDays: number }>()
    if (ids.length === 0) return map

    const { data } = await supabase
      .from('affiliate_payout_cycles')
      .select('affiliate_seller_id, payout_day, hold_days')
      .in('affiliate_seller_id', ids)

    for (const row of data ?? []) {
      map.set(row.affiliate_seller_id, normalizeCycle({
        payoutDay: row.payout_day,
        holdDays: row.hold_days,
      }))
    }

    return map
  }

  /** Disputas e reembolsos das contas indicadas por este afiliado. */
  private async riskOf(referredSellerIds: string[]) {
    const empty = { referredSellers: 0, paidTransactions: 0, refunded: 0, disputed: 0, disputeRate: 0 }
    if (referredSellerIds.length === 0) return empty

    const { data } = await supabase
      .from('transactions')
      .select('status, seller_id')
      .in('seller_id', referredSellerIds)

    const rows = (data ?? []) as Array<{ status: string }>
    const paid = rows.filter(r => ['paid', 'approved', 'refunded', 'chargeback'].includes(r.status)).length
    const refunded = rows.filter(r => r.status === 'refunded').length
    const disputed = rows.filter(r => r.status === 'chargeback').length

    return {
      referredSellers: referredSellerIds.length,
      paidTransactions: paid,
      refunded,
      disputed,
      // O número que o time olha: indicação boa não vira disputa.
      disputeRate: paid > 0 ? Number(((disputed / paid) * 100).toFixed(2)) : 0,
    }
  }

  private async audit(ctx: AffiliateCrmContext, action: string, resourceId: string, payload: Record<string, any>) {
    await supabase.from('crm_action_log').insert({
      manager_id: ctx.managerId,
      action,
      resource_type: 'seller',
      resource_id: resourceId,
      payload,
      ip_address: ctx.ip ?? null,
      user_agent: ctx.userAgent ?? null,
      created_at: new Date(),
    }).then(() => {}, (err: any) => this.logger.error(`audit(${action}): ${err?.message}`))
  }
}
