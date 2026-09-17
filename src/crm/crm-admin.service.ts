import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException,
} from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { getEffectiveSellerFees } from '../shared/fee.calculator'
import { providerCostCents, saleProfitCents } from '../orchestrator/fees/provider-fees'
import { notifySellerPayout, type PayoutEmailInfo } from '../utils/seller-mail'
import { WhopConnectedPayoutService } from '../orchestrator/whop/whop-connected-payout.service'
import { isWhopConnectedPayout } from '../orchestrator/whop/whop-connected-payout'

// Linha do ledger (debit_payout) → dados do e-mail de saque. O destino fica em
// metadata.destination (camelCase), igual ao que o CRM exibe.
function payoutEmailInfo(id: string, w: any): PayoutEmailInfo {
  return {
    amountCents: Number(w.amount),
    currency: w.currency,
    method: w.metadata?.method ?? w.method ?? null,
    payoutId: id,
    destination: w.metadata?.destination ?? null,
    feeCents: Number(w.fee) || null,
    requestedAt: w.created_at ?? null,
  }
}

/** Receita por tipo de taxa no período (função crm_revenue_breakdown). */
interface RevenueBreakdown {
  fx_fee_cents: number
  checkout_fee_cents: number
  processing_fee_cents: number
  orchestration_fee_cents: number
  fixed_fee_cents: number
  anticipation_fee_cents: number
  chargeback_fee_cents: number
  payout_fee_cents: number
  /** Custo do provider (modelo fixo, gravado na venda) das vendas que o têm. */
  provider_fee_cents: number
  provider_fee_sales: number
  /** Receita da Koopfy (taxa + câmbio) só das vendas com custo do provider. */
  provider_fee_revenue_cents: number
  negative_margin_sales: number
  sales_count: number
}

interface AdminContext {
  managerId: string
  role: string
  ip?: string
  userAgent?: string
}

// Converte cents (integer no banco) → USD (decimal pro frontend)
const c2u = (cents: number | string | null | undefined) => Number(cents ?? 0) / 100

// ─── Sellers excluídos das métricas agregadas ──────────────────────────────
// Estes sellers NÃO contam no overview (GMV, receita, timeseries, top sellers),
// mas continuam aparecendo nas listagens individuais (transactions, withdrawals,
// balances) para que admins possam gerenciá-los.
//
// Casos de uso: contas de teste, sellers internos da plataforma, demos.
const EXCLUDED_FROM_METRICS: string[] = [
  '2acec624-e115-4909-a578-1223b1155ee0',
]

// Normaliza destination camelCase do banco → snake_case que o frontend espera
function normalizeDestination(metadata: any) {
  const dest = metadata?.destination ?? {}
  const method = metadata?.method ?? 'unknown'

  // Frontend espera: pix_key, pix_key_type, iban, swift, bank_name, account_holder, wallet_address, network
  // Banco usa: pixKey, pixKeyType, pixHolder, cryptoAddress, cryptoNetwork
  return {
    // PIX
    pix_key: dest.pixKey ?? dest.pix_key,
    pix_key_type: dest.pixKeyType ?? dest.pix_key_type,
    pix_holder: dest.pixHolder ?? dest.pix_holder,
    // Crypto
    wallet_address: dest.cryptoAddress ?? dest.wallet_address,
    network: dest.cryptoNetwork ?? dest.network,
    // IBAN (SEPA/internacional) — método ativo hoje
    iban: dest.iban,
    swift: dest.swift,
    // ACH (bancos EUA) — método ativo hoje
    ach_routing_number: dest.achRoutingNumber ?? dest.ach_routing_number,
    ach_account_number: dest.achAccountNumber ?? dest.ach_account_number,
    ach_account_type: dest.achAccountType ?? dest.ach_account_type,
    // Comuns às contas bancárias
    bank_name: dest.bankName ?? dest.bank_name,
    account_holder: dest.accountHolder ?? dest.account_holder,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CRM ADMIN SERVICE — ledger-based withdrawals
// ═══════════════════════════════════════════════════════════════════════════

@Injectable()
export class CrmAdminService {
  constructor(private readonly connectedPayouts: WhopConnectedPayoutService) { }

  // ─── Guard: admin (rw) ou supervisor (ro) ────────────────────────────
  private assertAdmin(role: string, writeOp = false) {
    const isAdmin = role === 'admin'
    const isSupervisor = role === 'supervisor'
    if (!isAdmin && !(isSupervisor && !writeOp)) {
      throw new ForbiddenException('Acesso restrito a administradores')
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // OVERVIEW
  // ════════════════════════════════════════════════════════════════════════

  async getOverview(ctx: AdminContext, range: string = '30d') {
    this.assertAdmin(ctx.role)
    const { from, to, prevFrom, prevTo } = this.parseRange(range)

    const [gmvCurr, gmvPrev] = await Promise.all([
      this.aggregateKpis(from, to),
      this.aggregateKpis(prevFrom, prevTo),
    ])

    const [activeSellers, newSellers, pendingKyc, suspendedSellers] = await Promise.all([
      this.countSellers({ status: 'active' }),
      this.countSellers({ status: 'active', createdAfter: from }),
      this.countSellers({ status: 'pending_review' }),
      this.countSellers({ status: 'suspended' }),
    ])

    // ── Saques pendentes (status='pending' do wallet_ledger)
    let pendingQ = supabase
      .from('wallet_ledger')
      .select('amount')
      .eq('type', 'debit_payout')
      .eq('status', 'pending')

    if (EXCLUDED_FROM_METRICS.length > 0) {
      pendingQ = pendingQ.not('seller_id', 'in', `(${EXCLUDED_FROM_METRICS.join(',')})`)
    }

    const { data: pendingPayouts } = await pendingQ

    const pendingCount = pendingPayouts?.length ?? 0
    const pendingCents = (pendingPayouts ?? []).reduce(
      (s, w) => s + Number(w.amount ?? 0), 0,
    )

    // "Hoje" no timezone UTC (consistente com parseRange)
    const nowUtc = new Date()
    const startOfTodayUtc = new Date(Date.UTC(
      nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(),
      0, 0, 0, 0,
    ))

    let completedQ = supabase
      .from('wallet_ledger')
      .select('amount')
      .eq('type', 'debit_payout')
      .eq('status', 'completed')
      .gte('completed_at', startOfTodayUtc.toISOString())

    if (EXCLUDED_FROM_METRICS.length > 0) {
      completedQ = completedQ.not('seller_id', 'in', `(${EXCLUDED_FROM_METRICS.join(',')})`)
    }

    const { data: completedToday } = await completedQ

    const processedTodayCents = (completedToday ?? []).reduce(
      (s, w) => s + Number(w.amount ?? 0), 0,
    )

    let failedQ = supabase
      .from('wallet_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'debit_payout')
      .eq('status', 'failed')
      .gte('created_at', from.toISOString())

    if (EXCLUDED_FROM_METRICS.length > 0) {
      failedQ = failedQ.not('seller_id', 'in', `(${EXCLUDED_FROM_METRICS.join(',')})`)
    }

    const { count: failedCount } = await failedQ

    // ── Disputas abertas (fila de trabalho do painel)
    const { data: openDisputes } = await supabase
      .from('chargebacks')
      .select('amount_cents, deadline_at')
      .in('status', ['open', 'evidence_required'])

    const disputeDeadlines = (openDisputes ?? [])
      .map(d => d.deadline_at)
      .filter(Boolean)
      .sort()

    // ── Saldos consolidados (Float da plataforma)
    const [totals, revenueCurr, revenuePrev, timeseries, topSellers] = await Promise.all([
      this.balanceTotals(),
      this.revenueBreakdown(from, to),
      this.revenueBreakdown(prevFrom, prevTo),
      this.getTimeseries(from, to),
      this.getTopSellers(from, to, 10),
    ])

    // Receita da Koopfy: taxas da venda (seller_kpis) + câmbio, antecipação,
    // chargeback e saque. Sem a função no banco, fica só a taxa da venda.
    const extraRevenue = (r: RevenueBreakdown | null) =>
      r ? r.fx_fee_cents + r.anticipation_fee_cents + r.chargeback_fee_cents + r.payout_fee_cents : 0

    return {
      range,
      gmv: {
        total_usd: c2u(gmvCurr.totalCents),
        prev_total_usd: c2u(gmvPrev.totalCents),
        approved_count: gmvCurr.approvedCount,
        refunded_count: gmvCurr.refundedCount,
        chargeback_count: gmvCurr.chargebackCount,
      },
      revenue: {
        platform_fees_usd: c2u(gmvCurr.platformFeesCents),
        platform_fixed_usd: c2u(revenueCurr?.fixed_fee_cents ?? 0),
        anticipation_fees_usd: c2u(revenueCurr?.anticipation_fee_cents ?? 0),
        total_usd: c2u(gmvCurr.platformFeesCents + extraRevenue(revenueCurr)),
        prev_total_usd: c2u(gmvPrev.platformFeesCents + extraRevenue(revenuePrev)),
        breakdown_usd: revenueCurr && {
          fx: c2u(revenueCurr.fx_fee_cents),
          checkout: c2u(revenueCurr.checkout_fee_cents),
          processing: c2u(revenueCurr.processing_fee_cents),
          orchestration: c2u(revenueCurr.orchestration_fee_cents),
          fixed: c2u(revenueCurr.fixed_fee_cents),
          anticipation: c2u(revenueCurr.anticipation_fee_cents),
          chargeback: c2u(revenueCurr.chargeback_fee_cents),
          payout: c2u(revenueCurr.payout_fee_cents),
        },
        // Lucro: receita e custo das MESMAS vendas (as que têm o custo do provider
        // gravado). `sales_with_cost` / `sales_total` diz a cobertura.
        provider: revenueCurr && {
          cost_usd: c2u(revenueCurr.provider_fee_cents),
          revenue_usd: c2u(revenueCurr.provider_fee_revenue_cents),
          profit_usd: c2u(revenueCurr.provider_fee_revenue_cents - revenueCurr.provider_fee_cents),
          margin_pct: revenueCurr.provider_fee_revenue_cents > 0
            ? Math.round(((revenueCurr.provider_fee_revenue_cents - revenueCurr.provider_fee_cents) / revenueCurr.provider_fee_revenue_cents) * 1000) / 10
            : null,
          sales_with_cost: revenueCurr.provider_fee_sales,
          sales_total: revenueCurr.sales_count,
          negative_margin_sales: revenueCurr.negative_margin_sales,
        },
      },
      sellers: {
        active: activeSellers,
        new_this_period: newSellers,
        pending_kyc: pendingKyc,
        suspended: suspendedSellers,
      },
      withdrawals: {
        pending_count: pendingCount,
        pending_usd: c2u(pendingCents),
        processed_today_usd: c2u(processedTodayCents),
        failed_count: failedCount ?? 0,
      },
      disputes: {
        open_count: openDisputes?.length ?? 0,
        open_usd: c2u((openDisputes ?? []).reduce((sum, d) => sum + Number(d.amount_cents ?? 0), 0)),
        next_deadline_at: disputeDeadlines[0] ?? null,
      },
      balances: {
        total_available_usd: c2u(totals.available),
        total_pending_usd: c2u(totals.pending + totals.reserved),
        total_reserved_usd: c2u(totals.reserved),
        total_withdrawing_usd: c2u(totals.withdrawing),
        platform_float_usd: c2u(totals.available + totals.pending + totals.reserved + totals.withdrawing),
      },
      timeseries,
      top_sellers: topSellers,
    }
  }

  // ─── parseRange ────────────────────────────────────────────────────────
  // Retorna { from, to, prevFrom, prevTo } em UTC com bordas corretas:
  //   from: início do primeiro dia incluído (00:00:00 UTC)
  //   to:   fim do dia atual (23:59:59.999 UTC)
  //   prev*: mesmo tamanho de período, imediatamente anterior
  //
  // Convenções:
  //   '7d'  → últimos 7 dias incluindo hoje (de 6 dias atrás 00:00 até hoje 23:59)
  //   '30d' → últimos 30 dias
  //   '90d' → últimos 90 dias
  //   'mtd' → dia 1 do mês atual até hoje, comparado com mesmo período do mês anterior
  //   'ytd' → 1/jan do ano atual até hoje, comparado com mesmo período do ano anterior
  private parseRange(range: string) {
    const now = new Date()

    // Hoje 23:59:59.999 UTC (final do dia em curso)
    const todayEnd = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      23, 59, 59, 999,
    ))
    // Hoje 00:00:00 UTC
    const todayStart = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      0, 0, 0, 0,
    ))

    const subtractDays = (d: Date, n: number) => {
      const x = new Date(d)
      x.setUTCDate(x.getUTCDate() - n)
      return x
    }

    let from: Date, to: Date, prevFrom: Date, prevTo: Date

    switch (range) {
      case 'today': {
        // Hoje: 00:00 até 23:59 de hoje. Compara com ontem.
        from = todayStart
        to = todayEnd
        prevFrom = subtractDays(todayStart, 1)
        prevTo = new Date(Date.UTC(
          prevFrom.getUTCFullYear(), prevFrom.getUTCMonth(), prevFrom.getUTCDate(),
          23, 59, 59, 999,
        ))
        return { from, to, prevFrom, prevTo }
      }

      case '7d':
      case '30d':
      case '90d': {
        const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
        from = subtractDays(todayStart, days - 1)  // inclui hoje
        to = todayEnd
        prevTo = subtractDays(from, 1)             // dia anterior ao 'from'
        // prevTo ainda está em 00:00 — empurra pro fim do dia
        prevTo = new Date(Date.UTC(
          prevTo.getUTCFullYear(), prevTo.getUTCMonth(), prevTo.getUTCDate(),
          23, 59, 59, 999,
        ))
        prevFrom = subtractDays(prevTo, days - 1)
        prevFrom = new Date(Date.UTC(
          prevFrom.getUTCFullYear(), prevFrom.getUTCMonth(), prevFrom.getUTCDate(),
          0, 0, 0, 0,
        ))
        return { from, to, prevFrom, prevTo }
      }

      case 'mtd': {
        from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0))
        to = todayEnd
        // Mesmos N dias do mês anterior (ex: 1-27/mai vs 1-27/abr)
        const day = now.getUTCDate()
        prevFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0))
        prevTo = new Date(Date.UTC(
          now.getUTCFullYear(), now.getUTCMonth() - 1, day,
          23, 59, 59, 999,
        ))
        return { from, to, prevFrom, prevTo }
      }

      case 'ytd': {
        from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0))
        to = todayEnd
        // Mesmos N dias do ano anterior
        prevFrom = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1, 0, 0, 0))
        prevTo = new Date(Date.UTC(
          now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate(),
          23, 59, 59, 999,
        ))
        return { from, to, prevFrom, prevTo }
      }

      default: {
        // Fallback: 30 dias
        from = subtractDays(todayStart, 29)
        to = todayEnd
        prevTo = new Date(Date.UTC(
          subtractDays(from, 1).getUTCFullYear(),
          subtractDays(from, 1).getUTCMonth(),
          subtractDays(from, 1).getUTCDate(),
          23, 59, 59, 999,
        ))
        prevFrom = subtractDays(prevTo, 29)
        prevFrom = new Date(Date.UTC(
          prevFrom.getUTCFullYear(), prevFrom.getUTCMonth(), prevFrom.getUTCDate(),
          0, 0, 0, 0,
        ))
        return { from, to, prevFrom, prevTo }
      }
    }
  }

  // ─── Agregação via seller_kpis (tabela pré-computada) ──────────────────
  // Muito mais eficiente que varrer transactions: ler N rows agregadas em
  // vez de milhares. Granularidade diária (hour IS NULL).
  //
  // Mapeamento:
  //   approved_volume → GMV (volume bruto aprovado)
  //   fee_volume      → receita da plataforma
  //   approved_transactions → count de aprovadas
  //
  // ⚠️ refunded_count e chargeback_count não estão no seller_kpis hoje.
  // Para isso ainda vamos no transactions (queries pequenas, só count).
  private async aggregateKpis(from: Date, to: Date) {
    const fromKey = from.toISOString().slice(0, 10)
    const toKey = to.toISOString().slice(0, 10)

    let q = supabase
      .from('seller_kpis')
      .select('approved_volume, fee_volume, approved_transactions')
      .is('hour', null)              // só rows diárias agregadas
      .gte('date_key', fromKey)
      .lte('date_key', toKey)

    // Exclui sellers que não contam pras métricas
    if (EXCLUDED_FROM_METRICS.length > 0) {
      q = q.not('seller_id', 'in', `(${EXCLUDED_FROM_METRICS.join(',')})`)
    }

    const { data } = await q

    let totalCents = 0
    let platformFeesCents = 0
    let approvedCount = 0

    for (const k of data ?? []) {
      totalCents += Number(k.approved_volume ?? 0)
      platformFeesCents += Number(k.fee_volume ?? 0)
      approvedCount += Number(k.approved_transactions ?? 0)
    }

    // Refunds e chargebacks vêm separados (não estão no kpis)
    const [refundedCount, chargebackCount] = await Promise.all([
      this.countTransactionsByStatus(from, to, ['refunded', 'partial_refund']),
      this.countTransactionsByStatus(from, to, ['chargeback', 'disputed']),
    ])

    return { totalCents, platformFeesCents, approvedCount, refundedCount, chargebackCount }
  }

  private async countTransactionsByStatus(from: Date, to: Date, statuses: string[]) {
    let q = supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .in('status', statuses)
      .gte('created_at', from.toISOString())
      .lte('created_at', to.toISOString())

    if (EXCLUDED_FROM_METRICS.length > 0) {
      q = q.not('seller_id', 'in', `(${EXCLUDED_FROM_METRICS.join(',')})`)
    }

    const { count } = await q
    return count ?? 0
  }

  // Mantido por compatibilidade — agora delega para aggregateKpis
  private async aggregateTransactions(from: Date, to: Date) {
    return this.aggregateKpis(from, to)
  }

  private async countSellers(filter: { status?: string; createdAfter?: Date }) {
    let q = supabase.from('seller_profiles').select('id', { count: 'exact', head: true })
    if (filter.status) q = q.eq('status', filter.status)
    if (filter.createdAfter) q = q.gte('created_at', filter.createdAfter.toISOString())
    if (EXCLUDED_FROM_METRICS.length > 0) {
      q = q.not('id', 'in', `(${EXCLUDED_FROM_METRICS.join(',')})`)
    }
    const { count } = await q
    return count ?? 0
  }

  // ─── Timeseries via seller_kpis ────────────────────────────────────────
  // Já vem agregado por dia. Só precisamos somar todos os sellers/methods
  // de um mesmo date_key e gerar o array com dias contínuos (preenche zeros
  // nos dias sem movimento).
  private async getTimeseries(from: Date, to: Date) {
    const fromKey = from.toISOString().slice(0, 10)
    const toKey = to.toISOString().slice(0, 10)

    let q = supabase
      .from('seller_kpis')
      .select('date_key, approved_volume, fee_volume, approved_transactions')
      .is('hour', null)
      .gte('date_key', fromKey)
      .lte('date_key', toKey)
      .order('date_key', { ascending: true })

    if (EXCLUDED_FROM_METRICS.length > 0) {
      q = q.not('seller_id', 'in', `(${EXCLUDED_FROM_METRICS.join(',')})`)
    }

    const { data } = await q

    // Agrega por dia (somando todos os sellers + methods)
    const buckets = new Map<string, { gmv: number; rev: number; n: number }>()
    for (const k of data ?? []) {
      const day = k.date_key as string
      const b = buckets.get(day) ?? { gmv: 0, rev: 0, n: 0 }
      b.gmv += Number(k.approved_volume ?? 0)
      b.rev += Number(k.fee_volume ?? 0)
      b.n += Number(k.approved_transactions ?? 0)
      buckets.set(day, b)
    }

    // Preenche dias sem movimento com zeros (gráfico contínuo)
    const result: any[] = []
    const cur = new Date(from); cur.setHours(0, 0, 0, 0)
    const end = new Date(to); end.setHours(0, 0, 0, 0)
    while (cur <= end) {
      const key = cur.toISOString().slice(0, 10)
      const b = buckets.get(key) ?? { gmv: 0, rev: 0, n: 0 }
      result.push({
        date: key,
        gmv_usd: c2u(b.gmv),
        revenue_usd: c2u(b.rev),
        tx_count: b.n,
      })
      cur.setDate(cur.getDate() + 1)
    }
    return result
  }

  // ─── Top sellers via seller_kpis ───────────────────────────────────────
  private async getTopSellers(from: Date, to: Date, limit: number) {
    const fromKey = from.toISOString().slice(0, 10)
    const toKey = to.toISOString().slice(0, 10)

    let q = supabase
      .from('seller_kpis')
      .select('seller_id, approved_volume, approved_transactions')
      .is('hour', null)
      .gte('date_key', fromKey)
      .lte('date_key', toKey)

    if (EXCLUDED_FROM_METRICS.length > 0) {
      q = q.not('seller_id', 'in', `(${EXCLUDED_FROM_METRICS.join(',')})`)
    }

    const { data } = await q

    // Agrega por seller
    const map = new Map<string, { gmv: number; n: number }>()
    for (const k of data ?? []) {
      if (!k.seller_id) continue
      const cur = map.get(k.seller_id) ?? { gmv: 0, n: 0 }
      cur.gmv += Number(k.approved_volume ?? 0)
      cur.n += Number(k.approved_transactions ?? 0)
      map.set(k.seller_id, cur)
    }

    const top = Array.from(map.entries())
      .sort((a, b) => b[1].gmv - a[1].gmv)
      .slice(0, limit)

    if (top.length === 0) return []

    const ids = top.map(([id]) => id)
    const { data: sellers } = await supabase
      .from('seller_profiles')
      .select('id, name, risk_level, user_id')
      .in('id', ids)

    // Busca avatares dos users em batch (evita embed)
    const userIds = [...new Set((sellers ?? []).map(s => s.user_id).filter(Boolean))]
    const avatarMap = new Map<string, string | null>()
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, avatar_url')
        .in('id', userIds)
      ;(users ?? []).forEach(u => avatarMap.set(u.id, u.avatar_url ?? null))
    }

    const sellerMap = new Map((sellers ?? []).map((s: any) => [s.id, s]))

    return top.map(([id, agg]) => {
      const s: any = sellerMap.get(id)
      return {
        seller_id: id,
        name: s?.name ?? 'Seller',
        avatar_url: s?.user_id ? avatarMap.get(s.user_id) ?? null : null,
        gmv_usd: c2u(agg.gmv),
        tx_count: agg.n,
        risk_level: (s?.risk_level ?? 'WHITE').toUpperCase(),
      }
    })
  }

  // ════════════════════════════════════════════════════════════════════════
  // WITHDRAWALS (= wallet_ledger entries com type='debit_payout')
  // ════════════════════════════════════════════════════════════════════════

  async listWithdrawals(ctx: AdminContext, params: {
    status?: string
    search?: string
    page?: number
    pageSize?: number
  }) {
    this.assertAdmin(ctx.role)
    const { status, search, page = 1, pageSize = 20 } = params
    const from = (page - 1) * pageSize

    let q = supabase
      .from('v_admin_withdrawals')
      .select('*', { count: 'exact' })
      .order('requested_at', { ascending: false })
      .range(from, from + pageSize - 1)

    // Mapeia status do frontend para os do ledger
    if (status && status !== 'all') {
      const dbStatus = status === 'pending_review' ? 'pending' : status
      q = q.eq('status', dbStatus)
    }

    if (search) {
      q = q.or(`seller_name.ilike.%${search}%,seller_email.ilike.%${search}%`)
    }

    const { data, count, error } = await q
    if (error) throw new BadRequestException(error.message)

    return {
      data: (data ?? []).map(w => this.formatWithdrawalRow(w)),
      total: count ?? 0,
      page,
      totalPages: Math.ceil((count ?? 0) / pageSize),
    }
  }

  async getWithdrawal(ctx: AdminContext, id: string) {
    this.assertAdmin(ctx.role)
    const { data, error } = await supabase
      .from('v_admin_withdrawals')
      .select('*')
      .eq('id', id)
      .single()

    if (error || !data) throw new NotFoundException('Saque não encontrado')
    const ledger = await this.fetchLedgerPayout(id)
    return {
      ...this.formatWithdrawalRow(data),
      // Seller com conta conectada: em que perna o envio está.
      whop_payout: this.connectedPayouts.describe(ledger),
    }
  }

  private formatWithdrawalRow(w: any) {
    // Frontend mapeia 'pending' → mostrar como 'pending_review'
    const displayStatus = w.status === 'pending' ? 'pending_review' : w.status

    // metadata.destination está em camelCase → normalizar
    const destination = normalizeDestination({
      method: w.method,
      destination: w.destination,
    })

    return {
      id: w.id,
      seller_id: w.seller_id,
      seller_name: w.seller_name,
      seller_avatar: w.seller_avatar,
      seller_risk: (w.seller_risk ?? 'WHITE').toUpperCase(),
      seller_email: w.seller_email,

      amount_usd: c2u(w.amount_cents),
      fee_usd: c2u(w.fee_cents),
      net_amount_usd: c2u(w.net_amount_cents),
      currency: w.destination_currency ?? 'USD',
      fx_rate: null,

      method: w.method,
      destination,

      status: displayStatus,
      requested_at: w.requested_at,
      reviewed_at: w.reviewed_at,
      reviewed_by: w.reviewed_by,
      reviewer_name: w.reviewer_name,
      processed_at: w.processed_at,
      completed_at: w.completed_at,
      rejection_reason: w.rejection_reason,
      failure_reason: w.failure_reason,
      notes: w.notes,

      seller_balance_at_request_usd: c2u(w.seller_balance_at_request_cents),
      seller_30d_gmv_usd: c2u(w.seller_30d_gmv_cents),
      seller_chargeback_rate: Number(w.seller_chargeback_rate ?? 0),

      risk_flags: w.risk_flags ?? {},
      provider: w.provider,
      provider_payout_id: w.provider_payout_id,
    }
  }

  // ─── Approve: pending → approved (DEBITA withdrawing) ────────────────
  // No Modelo A, o saldo já saiu de available→withdrawing na solicitação.
  // Ao aprovar, debitamos withdrawing de vez (dinheiro sai do sistema).
  async approveWithdrawal(ctx: AdminContext, id: string, dto: { notes?: string }) {
    this.assertAdmin(ctx.role, true)
    const w = await this.fetchLedgerPayout(id)

    if (w.status !== 'pending') {
      throw new BadRequestException(`Saque está com status ${w.status}, não pode ser aprovado`)
    }

    // Seller com conta conectada ativa: o envio é automático (master → conta
    // conectada → banco). Sem ela, o saque segue manual como antes.
    const whopAccountId = await this.connectedPayouts.eligibleAccount(w.seller_id)

    // Debita withdrawing (sem destino = sai do sistema)
    await this.transferBalance(w.seller_id, 'withdrawing', null, Number(w.amount))

    const { error } = await supabase
      .from('wallet_ledger')
      .update({
        status: 'approved',
        reviewed_at: new Date(),
        reviewed_by: ctx.managerId,
        processed_at: new Date(),
        admin_notes: dto.notes ?? null,
      })
      .eq('id', id)
      .eq('type', 'debit_payout')
      .eq('status', 'pending')  // CAS — protege de concorrência

    if (error) {
      // Rollback do saldo se o update falhar (devolve pra withdrawing)
      await this.transferBalance(w.seller_id, 'available', 'withdrawing', Number(w.amount))
        .catch(() => { /* best-effort */ })
      throw new BadRequestException(error.message)
    }

    await this.audit(ctx, 'withdrawal.approved', 'withdrawal', id, {
      amount_cents: w.amount,
      seller_id: w.seller_id,
      notes: dto.notes,
    })

    void notifySellerPayout(w.seller_id, 'approved', payoutEmailInfo(id, w))

    if (whopAccountId) {
      try {
        await this.connectedPayouts.queue(id, whopAccountId)
      } catch (err: any) {
        // Aprovado e sem execução: fica no fluxo manual. Melhor avisar do que
        // desfazer uma aprovação que já debitou e notificou.
        console.error(`[CrmAdmin] saque ${id} aprovado, envio automático não enfileirado:`, err?.message ?? err)
        return { message: 'Saque aprovado, mas o envio automático não foi iniciado — conclua manualmente', automatic: false }
      }
      return { message: 'Saque aprovado — envio automático para a conta conectada iniciado', automatic: true }
    }

    return { message: 'Saque aprovado e saldo debitado', automatic: false }
  }

  // ─── Reject: só pending → rejected (devolve withdrawing → available) ──
  // Atenção: no Modelo A, um saque 'approved' JÁ teve o saldo debitado.
  // Por isso só permitimos rejeitar saques 'pending' (que ainda têm saldo
  // em withdrawing pra devolver). Saque aprovado errado → usar mark-failed.
  async rejectWithdrawal(ctx: AdminContext, id: string, dto: { reason: string }) {
    this.assertAdmin(ctx.role, true)
    if (!dto.reason?.trim()) throw new BadRequestException('Motivo é obrigatório')

    const w = await this.fetchLedgerPayout(id)

    if (w.status !== 'pending') {
      throw new BadRequestException(
        `Saque ${w.status} não pode ser rejeitado. ` +
        (w.status === 'approved'
          ? 'Saques aprovados já tiveram saldo debitado — use "Marcar como falhou" para reverter.'
          : 'Apenas saques pendentes podem ser rejeitados.')
      )
    }

    // Devolve saldo: withdrawing → available (atômico via RPC)
    await this.transferBalance(w.seller_id, 'withdrawing', 'available', Number(w.amount))

    const { error } = await supabase
      .from('wallet_ledger')
      .update({
        status: 'rejected',
        reviewed_at: new Date(),
        reviewed_by: ctx.managerId,
        rejection_reason: dto.reason.trim(),
      })
      .eq('id', id)
      .eq('type', 'debit_payout')
      .eq('status', 'pending')  // CAS

    if (error) {
      // Rollback: re-trava o saldo
      await this.transferBalance(w.seller_id, 'available', 'withdrawing', Number(w.amount))
        .catch(() => { /* best-effort */ })
      throw new BadRequestException(error.message)
    }

    await this.audit(ctx, 'withdrawal.rejected', 'withdrawal', id, {
      reason: dto.reason,
      amount_cents: w.amount,
      seller_id: w.seller_id,
    })

    void notifySellerPayout(w.seller_id, 'rejected', { ...payoutEmailInfo(id, w), reason: dto.reason.trim() })

    return { message: 'Saque rejeitado e saldo devolvido' }
  }

  // ─── Mark Completed: approved|processing → completed ─────────────────
  // No Modelo A o saldo JÁ foi debitado na aprovação. Aqui só confirmamos
  // que o dinheiro saiu efetivamente no provider — NÃO mexe em saldo.
  async markWithdrawalCompleted(ctx: AdminContext, id: string, dto: {
    provider_tx_id: string
    notes?: string
  }) {
    this.assertAdmin(ctx.role, true)
    if (!dto.provider_tx_id?.trim()) {
      throw new BadRequestException('provider_tx_id é obrigatório')
    }

    const w = await this.fetchLedgerPayout(id)

    if (!['approved', 'processing'].includes(w.status)) {
      throw new BadRequestException(`Saque ${w.status} não pode ser concluído`)
    }
    if (isWhopConnectedPayout(w.metadata)) {
      throw new BadRequestException('Este saque é enviado automaticamente pela conta conectada e é concluído quando o banco confirma.')
    }

    // ⚠️ NÃO debita saldo aqui — já foi debitado na aprovação (Modelo A)

    const { error } = await supabase
      .from('wallet_ledger')
      .update({
        status: 'completed',
        completed_at: new Date(),
        provider_payout_id: dto.provider_tx_id.trim(),
        admin_notes: dto.notes ?? w.admin_notes,
      })
      .eq('id', id)
      .eq('type', 'debit_payout')
      .in('status', ['approved', 'processing'])

    if (error) throw new BadRequestException(error.message)

    await this.audit(ctx, 'withdrawal.completed', 'withdrawal', id, {
      provider_tx_id: dto.provider_tx_id,
      amount_cents: w.amount,
      seller_id: w.seller_id,
    })

    void notifySellerPayout(w.seller_id, 'completed', {
      ...payoutEmailInfo(id, w),
      providerPayoutId: dto.provider_tx_id.trim(),
    })

    return { message: 'Saque concluído' }
  }

  // ─── Mark Failed: approved|processing → failed (DEVOLVE saldo) ────────
  // O dinheiro foi debitado na aprovação mas o provider falhou em enviar.
  // Devolvemos o saldo para available (o seller pode tentar de novo).
  async markWithdrawalFailed(ctx: AdminContext, id: string, dto: { reason: string }) {
    this.assertAdmin(ctx.role, true)
    if (!dto.reason?.trim()) throw new BadRequestException('Motivo é obrigatório')

    const w = await this.fetchLedgerPayout(id)

    if (!['approved', 'processing'].includes(w.status)) {
      throw new BadRequestException(`Saque ${w.status} não pode ser marcado como falhou`)
    }

    if (isWhopConnectedPayout(w.metadata)) {
      return this.cancelConnectedPayout(ctx, id, w, dto.reason.trim())
    }

    // Devolve direto pra available (saldo foi debitado de withdrawing no approve)
    await this.creditAvailable(w.seller_id, Number(w.amount))

    const { error } = await supabase
      .from('wallet_ledger')
      .update({
        status: 'failed',
        failure_reason: dto.reason.trim(),
      })
      .eq('id', id)
      .eq('type', 'debit_payout')
      .in('status', ['approved', 'processing'])

    if (error) {
      // Rollback: re-debita o que acabamos de creditar
      await this.debitAvailable(w.seller_id, Number(w.amount))
        .catch(() => { /* best-effort */ })
      throw new BadRequestException(error.message)
    }

    await this.audit(ctx, 'withdrawal.failed', 'withdrawal', id, {
      reason: dto.reason,
      amount_cents: w.amount,
      seller_id: w.seller_id,
    })

    void notifySellerPayout(w.seller_id, 'failed', { ...payoutEmailInfo(id, w), reason: dto.reason.trim() })

    return { message: 'Saque marcado como falhou e saldo devolvido' }
  }

  // ─── Envio automático (conta conectada) ───────────────────────────────

  // Cancelar só enquanto nada saiu da master: com o saque ainda 'approved', o
  // ciclo não o pegou. O CAS vem ANTES do crédito — se o ciclo pegar primeiro,
  // nenhum saldo é devolvido (o dinheiro pode estar indo para o seller).
  private async cancelConnectedPayout(ctx: AdminContext, id: string, w: any, reason: string) {
    if (w.status !== 'approved') {
      throw new BadRequestException(
        'O envio para a conta conectada já começou. Se o banco recusar, reenvie pelo CRM — não dá para devolver o saldo, o dinheiro já é do seller na conta dele.',
      )
    }

    const { data: cancelled, error } = await supabase
      .from('wallet_ledger')
      .update({
        status: 'failed',
        failure_reason: reason,
        metadata: {
          ...(w.metadata ?? {}),
          execution: { ...w.metadata.execution, stage: 'transfer_failed', last_error: `cancelado no CRM: ${reason}` },
        },
      })
      .eq('id', id)
      .eq('type', 'debit_payout')
      .eq('status', 'approved')
      .select('id')
      .maybeSingle()

    if (error) throw new BadRequestException(error.message)
    if (!cancelled) {
      throw new BadRequestException('O envio para a conta conectada começou agora — o saque não pode mais ser cancelado.')
    }

    await this.creditAvailable(w.seller_id, Number(w.amount))

    await this.audit(ctx, 'withdrawal.failed', 'withdrawal', id, {
      reason,
      amount_cents: w.amount,
      seller_id: w.seller_id,
      whop_connected: true,
    })

    void notifySellerPayout(w.seller_id, 'failed', { ...payoutEmailInfo(id, w), reason })

    return { message: 'Envio cancelado e saldo devolvido' }
  }

  // Saque recusado pelo banco: o dinheiro está na conta conectada. Reenvia
  // (opcionalmente para outra conta bancária cadastrada pelo seller).
  async retryConnectedPayout(ctx: AdminContext, id: string, dto: { payout_method_id?: string }) {
    this.assertAdmin(ctx.role, true)
    const w = await this.fetchLedgerPayout(id)
    if (!isWhopConnectedPayout(w.metadata)) {
      throw new BadRequestException('Este saque não é enviado pela conta conectada.')
    }

    const state = await this.connectedPayouts.retryWithdrawal(id, dto.payout_method_id ?? null)

    await this.audit(ctx, 'withdrawal.payout_retried', 'withdrawal', id, {
      seller_id: w.seller_id,
      payout_method_id: dto.payout_method_id ?? null,
      stage: state?.stage ?? null,
    })

    return { message: 'Saque reenviado para o banco', whop_payout: state }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private async fetchLedgerPayout(id: string) {
    const { data, error } = await supabase
      .from('wallet_ledger')
      .select('*')
      .eq('id', id)
      .eq('type', 'debit_payout')
      .single()

    if (error || !data) throw new NotFoundException('Saque não encontrado')
    return data
  }

  // Transferência atômica de saldo via RPC (lock + valida + move).
  // toBucket=null → débito final (sai do sistema, ex: aprovar saque).
  private async transferBalance(
    sellerId: string,
    fromBucket: 'available' | 'pending' | 'reserved' | 'withdrawing',
    toBucket: 'available' | 'pending' | 'reserved' | 'withdrawing' | null,
    amountCents: number,
  ) {
    const { error } = await supabase.rpc('transfer_balance', {
      p_seller_id: sellerId,
      p_from_bucket: fromBucket,
      p_to_bucket: toBucket,
      p_amount_cents: amountCents,
    })
    if (error) {
      throw new BadRequestException(`Erro de saldo: ${error.message}`)
    }
  }

  // Crédito puro num bucket (sem origem) — usado quando o saldo já saiu do
  // sistema e precisa ser devolvido (ex: saque aprovado que falhou no provider).
  private async creditAvailable(sellerId: string, amountCents: number) {
    const { error } = await supabase.rpc('credit_balance', {
      p_seller_id: sellerId,
      p_bucket: 'available',
      p_amount_cents: amountCents,
    })
    if (error) throw new BadRequestException(`Erro ao creditar saldo: ${error.message}`)
  }

  // Débito puro num bucket (sem destino) — usado em rollbacks.
  private async debitAvailable(sellerId: string, amountCents: number) {
    const { error } = await supabase.rpc('debit_balance', {
      p_seller_id: sellerId,
      p_bucket: 'available',
      p_amount_cents: amountCents,
    })
    if (error) throw new BadRequestException(`Erro ao debitar saldo: ${error.message}`)
  }

  // ════════════════════════════════════════════════════════════════════════
  // BALANCES
  // ════════════════════════════════════════════════════════════════════════

  // Somas no banco (crm_balance_totals). Sem a função aplicada, soma no Node
  // o que vier — pode faltar seller acima de 1000 linhas.
  private async balanceTotals() {
    const { data, error } = await supabase.rpc('crm_balance_totals', { p_excluded: EXCLUDED_FROM_METRICS })
    const row = Array.isArray(data) ? data[0] : data
    if (!error && row) {
      return {
        available: Number(row.available_cents ?? 0),
        pending: Number(row.pending_cents ?? 0),
        reserved: Number(row.reserved_cents ?? 0),
        withdrawing: Number(row.withdrawing_cents ?? 0),
      }
    }
    console.error('[crm-admin] crm_balance_totals indisponível, somando no service:', error?.message)
    let q = supabase
      .from('wallet_balance')
      .select('available_balance, pending_balance, reserved_balance, withdrawing_balance')
    if (EXCLUDED_FROM_METRICS.length > 0) {
      q = q.not('seller_id', 'in', `(${EXCLUDED_FROM_METRICS.join(',')})`)
    }
    const { data: rows } = await q
    return (rows ?? []).reduce((acc, b) => ({
      available: acc.available + Number(b.available_balance ?? 0),
      pending: acc.pending + Number(b.pending_balance ?? 0),
      reserved: acc.reserved + Number(b.reserved_balance ?? 0),
      withdrawing: acc.withdrawing + Number(b.withdrawing_balance ?? 0),
    }), { available: 0, pending: 0, reserved: 0, withdrawing: 0 })
  }

  private async revenueBreakdown(from: Date, to: Date): Promise<RevenueBreakdown | null> {
    const { data, error } = await supabase.rpc('crm_revenue_breakdown', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_excluded: EXCLUDED_FROM_METRICS,
    })
    const row = Array.isArray(data) ? data[0] : data
    if (error || !row) {
      if (error) console.error('[crm-admin] crm_revenue_breakdown indisponível:', error.message)
      return null
    }
    const n = (v: unknown) => Number(v ?? 0)
    return {
      fx_fee_cents: n(row.fx_fee_cents),
      checkout_fee_cents: n(row.checkout_fee_cents),
      processing_fee_cents: n(row.processing_fee_cents),
      orchestration_fee_cents: n(row.orchestration_fee_cents),
      fixed_fee_cents: n(row.fixed_fee_cents),
      anticipation_fee_cents: n(row.anticipation_fee_cents),
      chargeback_fee_cents: n(row.chargeback_fee_cents),
      payout_fee_cents: n(row.payout_fee_cents),
      // Antes da migration do custo do provider essas colunas não existem: zero.
      provider_fee_cents: n(row.provider_fee_cents),
      provider_fee_sales: n(row.provider_fee_sales),
      provider_fee_revenue_cents: n(row.provider_fee_revenue_cents),
      negative_margin_sales: n(row.negative_margin_sales),
      sales_count: n(row.sales_count),
    }
  }

  async listBalances(ctx: AdminContext, params: { search?: string; sort?: string; page?: number; pageSize?: number }) {
    this.assertAdmin(ctx.role)
    const { search, sort = 'available_desc', page } = params
    // Chamada sem página = tela antiga: devolve só a lista (até 200), como antes.
    const legacy = page === undefined
    const pageSize = legacy ? 200 : (params.pageSize ?? 50)

    let q = supabase.from('v_admin_seller_balances').select('*', { count: 'exact' })
    // Vírgula e parênteses quebram o filtro `or` do PostgREST.
    const term = (search ?? '').replace(/[,()%*\\]/g, ' ').trim()
    if (term) q = q.or(`name.ilike.%${term}%,email.ilike.%${term}%`)

    const sortMap: Record<string, [string, boolean]> = {
      available_desc: ['available_cents', false],
      pending_desc: ['pending_cents', false],
      gmv_desc: ['gmv_30d_cents', false],
      on_hold_desc: ['on_hold_cents', false],
    }
    const [col, asc] = sortMap[sort] ?? sortMap.available_desc
    q = q.order(col, { ascending: asc })

    const safePage = Math.max(1, page ?? 1)
    const start = (safePage - 1) * pageSize
    const [{ data, error, count }, totals] = await Promise.all([
      q.range(start, start + pageSize - 1),
      legacy ? Promise.resolve(null) : this.balanceTotals(),
    ])
    if (error) throw new BadRequestException(error.message)

    const rows = (data ?? []).map(b => ({
      seller_id: b.seller_id,
      name: b.name,
      avatar_url: b.avatar_url,
      email: b.email,
      risk_level: (b.risk_level ?? 'WHITE').toUpperCase(),
      status: b.status,
      available_usd: c2u(b.available_cents),
      pending_usd: c2u(b.pending_cents) + c2u(b.withdrawing_cents),
      reserve_usd: c2u(b.reserve_cents),
      on_hold_usd: c2u(b.on_hold_cents),
      total_usd: c2u(b.total_cents),
      gmv_30d_usd: c2u(b.gmv_30d_cents),
      refunds_30d_usd: 0,
      chargebacks_30d_count: Number(b.chargebacks_30d_count ?? 0),
      last_withdrawal_at: b.last_withdrawal_at,
    }))

    if (legacy || !totals) return rows

    return {
      data: rows,
      total: count ?? 0,
      page: safePage,
      totalPages: Math.ceil((count ?? 0) / pageSize),
      // Totais da plataforma inteira, não só da página.
      totals: {
        available_usd: c2u(totals.available),
        pending_usd: c2u(totals.pending),
        reserve_usd: c2u(totals.reserved),
        withdrawing_usd: c2u(totals.withdrawing),
      },
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // TRANSACTIONS
  // ════════════════════════════════════════════════════════════════════════

  async listTransactions(ctx: AdminContext, params: {
    status?: string
    provider?: string
    search?: string
    sellerId?: string
    dateFrom?: string
    dateTo?: string
    page?: number
    pageSize?: number
  }) {
    this.assertAdmin(ctx.role)
    const { status, provider, search, sellerId, dateFrom, dateTo, page = 1, pageSize = 30 } = params
    const from = (page - 1) * pageSize

    // ── 1. Busca as transações (sem embed) ─────────────────────────────
    let q = supabase
      .from('transactions')
      .select(`
        id, created_at, seller_id, offer_id, customer_email, customer_name, customer_country,
        amount_usd_gross_cents, amount_usd_net_cents, fee, fee_breakdown,
        method, provider, status, risk_score
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1)

    if (status && status !== 'all') {
      if (status === 'pending') {
        // O front rotula 'requires_action' como "Pendente" (venda iniciada,
        // hosted/redirect aguardando o cliente). Então o filtro "Pendente" cobre
        // AMBOS: 'pending' e 'requires_action' — senão essas vendas somem da lista.
        q = q.in('status', ['pending', 'requires_action'])
      } else {
        const dbStatus = status === 'succeeded' ? 'approved' : status
        q = q.eq('status', dbStatus)
      }
    }
    if (provider && provider !== 'all') q = q.eq('provider', provider)
    if (sellerId) q = q.eq('seller_id', sellerId)
    if (dateFrom) q = q.gte('created_at', dateFrom)
    if (dateTo) q = q.lte('created_at', dateTo)
    if (search) {
      q = q.or(`customer_email.ilike.%${search}%,customer_name.ilike.%${search}%`)
    }

    const { data: txs, count, error } = await q
    if (error) throw new BadRequestException(error.message)

    if (!txs || txs.length === 0) {
      return { data: [], total: count ?? 0, page, totalPages: 0 }
    }

    // ── 2. Busca os sellers das transações em batch ────────────────────
    const sellerIds = [...new Set(txs.map(t => t.seller_id).filter(Boolean))]
    const { data: sellers } = await supabase
      .from('seller_profiles')
      .select('id, name')
      .in('id', sellerIds)
    const sellerMap = new Map((sellers ?? []).map(s => [s.id, s.name]))

    // ── 3. Busca os offers em batch (se houver) ────────────────────────
    const offerIds = [...new Set(txs.map(t => t.offer_id).filter(Boolean))]
    const offerMap = new Map<string, string>()
    if (offerIds.length > 0) {
      const { data: offers } = await supabase
        .from('offers')
        .select('id, name')
        .in('id', offerIds)
      ;(offers ?? []).forEach(o => offerMap.set(o.id, o.name))
    }

    return {
      data: txs.map((tx: any) => ({
        id: tx.id,
        created_at: tx.created_at,
        seller_id: tx.seller_id,
        seller_name: sellerMap.get(tx.seller_id) ?? 'Seller',
        offer_name: tx.offer_id ? offerMap.get(tx.offer_id) : undefined,
        customer_email: tx.customer_email,
        customer_name: tx.customer_name,
        amount_usd: c2u(tx.amount_usd_gross_cents),
        fee_usd: c2u(tx.fee),
        // Custo do provider e lucro da Koopfy na venda (nulo em venda anterior ao modelo).
        provider_fee_usd: providerCostCents(tx.fee_breakdown) == null ? null : c2u(providerCostCents(tx.fee_breakdown)),
        profit_usd: saleProfitCents(tx) == null ? null : c2u(saleProfitCents(tx)),
        net_usd: c2u(tx.amount_usd_net_cents),
        method: tx.method,
        provider: tx.provider,
        status: tx.status === 'approved' ? 'succeeded' : tx.status,
        country: tx.customer_country,
        risk_score: tx.risk_score ? Number(tx.risk_score) : null,
      })),
      total: count ?? 0,
      page,
      totalPages: Math.ceil((count ?? 0) / pageSize),
    }
  }

  async refundTransaction(ctx: AdminContext, txId: string, dto: {
    amount_usd?: number
    reason: string
  }) {
    this.assertAdmin(ctx.role, true)
    if (!dto.reason?.trim()) throw new BadRequestException('Motivo é obrigatório')

    const { data: tx } = await supabase
      .from('transactions').select('*').eq('id', txId).single()

    if (!tx) throw new NotFoundException('Transação não encontrada')
    if (tx.status !== 'approved') {
      throw new BadRequestException(`Transação ${tx.status} não pode ser reembolsada`)
    }

    const amountCents = dto.amount_usd
      ? Math.round(dto.amount_usd * 100)
      : Number(tx.amount_usd_gross_cents)

    if (amountCents <= 0 || amountCents > Number(tx.amount_usd_gross_cents)) {
      throw new BadRequestException('Valor inválido')
    }

    // ⚠️ TODO: Aqui precisa chamar o provider real (Stripe/Viva/SIBS) para
    // executar o refund. Por enquanto só registramos no banco.

    const isPartial = amountCents < Number(tx.amount_usd_gross_cents)
    const newStatus = isPartial ? 'partial_refund' : 'refunded'

    const { error } = await supabase
      .from('transactions')
      .update({
        status: newStatus,
        metadata: {
          ...(tx.metadata ?? {}),
          refund_reason: dto.reason,
          refunded_amount_cents: amountCents,
          refunded_by: ctx.managerId,
          refunded_at: new Date().toISOString(),
        },
      })
      .eq('id', txId)

    if (error) throw new BadRequestException(error.message)

    // Cria entry de refund no ledger (negativa)
    await supabase.from('wallet_ledger').insert({
      seller_id: tx.seller_id,
      transaction_id: txId,
      type: 'refund',
      amount: -amountCents,
      currency: 'USD',
      status: 'completed',
      metadata: { reason: dto.reason, refunded_by: ctx.managerId },
      created_at: new Date(),
    })

    await this.audit(ctx, isPartial ? 'transaction.partial_refund' : 'transaction.refunded',
      'transaction', txId, {
      amount_cents: amountCents,
      reason: dto.reason,
      seller_id: tx.seller_id,
    })

    return { message: 'Reembolso registrado' }
  }

  // ════════════════════════════════════════════════════════════════════════
  // CHARGEBACKS
  // ════════════════════════════════════════════════════════════════════════

  async listChargebacks(ctx: AdminContext, params: { status?: string }) {
    this.assertAdmin(ctx.role)
    const { status } = params

    // ── 1. Busca os chargebacks (sem embed) ────────────────────────────
    let q = supabase
      .from('chargebacks')
      .select('*')
      .order('opened_at', { ascending: false })

    if (status && status !== 'all') q = q.eq('status', status)

    const { data: cbs, error } = await q.limit(200)
    if (error) throw new BadRequestException(error.message)

    if (!cbs || cbs.length === 0) return []

    // ── 2. Busca sellers em batch ──────────────────────────────────────
    const sellerIds = [...new Set(cbs.map(c => c.seller_id).filter(Boolean))]
    const { data: sellers } = await supabase
      .from('seller_profiles')
      .select('id, name')
      .in('id', sellerIds)
    const sellerMap = new Map((sellers ?? []).map(s => [s.id, s.name]))

    // ── 3. Busca transações em batch ───────────────────────────────────
    const txIds = [...new Set(cbs.map(c => c.transaction_id).filter(Boolean))]
    const txMap = new Map<string, any>()
    if (txIds.length > 0) {
      const { data: txs } = await supabase
        .from('transactions')
        .select('id, customer_email, amount_usd_gross_cents')
        .in('id', txIds)
      ;(txs ?? []).forEach(t => txMap.set(t.id, t))
    }

    return cbs.map((cb: any) => ({
      id: cb.id,
      transaction_id: cb.transaction_id,
      seller_id: cb.seller_id,
      seller_name: sellerMap.get(cb.seller_id) ?? '—',
      customer_email: txMap.get(cb.transaction_id)?.customer_email,
      amount_usd: c2u(cb.amount_cents),
      reason_code: cb.reason_code,
      reason_description: cb.reason_description,
      status: cb.status,
      opened_at: cb.opened_at,
      deadline_at: cb.deadline_at,
      resolved_at: cb.resolved_at,
      evidence_submitted: cb.evidence_submitted,
    }))
  }

  async acceptChargeback(ctx: AdminContext, id: string, dto: { notes?: string }) {
    this.assertAdmin(ctx.role, true)
    const { data: cb } = await supabase.from('chargebacks').select('*').eq('id', id).single()
    if (!cb) throw new NotFoundException('Chargeback não encontrado')
    if (!['open', 'evidence_required'].includes(cb.status)) {
      throw new BadRequestException(`Status ${cb.status} não pode aceitar`)
    }

    await supabase.from('chargebacks').update({
      status: 'accepted',
      resolved_at: new Date(),
      resolved_by: ctx.managerId,
      resolution_notes: dto.notes ?? null,
    }).eq('id', id)

    // Reserva da venda com chargeback não volta ao seller.
    if (cb.transaction_id) {
      const { error: reserveError } = await supabase.rpc('cancel_reserve_hold', { p_transaction_id: cb.transaction_id, p_reason: 'chargeback' })
      if (reserveError) console.error('[crm-admin] chargeback: reserva não cancelada (reconciliar):', reserveError.message)
    }

    // ── Debita o seller: valor do chargeback + taxa de chargeback do seller ───
    // Não trava se faltar saldo — registra para reconciliação manual. Se a venda
    // já pagou a taxa num alerta de chargeback (Whop), não cobra de novo.
    const now = new Date().toISOString()
    const sellerFees = await getEffectiveSellerFees(cb.seller_id)
    const { data: alertFee } = cb.transaction_id
      ? await supabase.from('wallet_ledger').select('id')
        .eq('transaction_id', cb.transaction_id).eq('type', 'chargeback_alert_fee').maybeSingle()
      : { data: null }
    const feeCents = alertFee ? 0 : Math.round(sellerFees.chargebackFeeUsd * 100)
    const amountCents = Number(cb.amount_cents ?? 0)
    const totalCents = amountCents + feeCents

    const { error: debitErr } = await supabase.rpc('debit_balance', {
      p_seller_id: cb.seller_id,
      p_bucket: 'available',
      p_amount_cents: totalCents,
    })

    const ledgerStatus = debitErr ? 'failed' : 'completed'
    const meta = (kind: string) => ({
      chargeback_id: cb.id,
      reconciliation: !!debitErr,
      ...(debitErr ? { error: debitErr.message } : {}),
      kind,
    })

    await supabase.from('wallet_ledger').insert([
      ...(amountCents > 0 ? [{
        seller_id: cb.seller_id,
        transaction_id: cb.transaction_id ?? cb.id,
        type: 'chargeback_debit',
        amount: amountCents,
        currency: 'USD',
        status: ledgerStatus,
        metadata: meta('amount'),
        created_at: now,
      }] : []),
      ...(feeCents > 0 ? [{
        seller_id: cb.seller_id,
        transaction_id: cb.id,
        type: 'chargeback_fee',
        amount: feeCents,
        currency: 'USD',
        status: ledgerStatus,
        metadata: meta('fee'),
        created_at: now,
      }] : []),
    ])

    if (debitErr) {
      console.error(
        `[crm-admin] chargeback debit falhou seller=${cb.seller_id} ` +
        `total=${totalCents}: ${debitErr.message} — marcado p/ reconciliação`,
      )
    }

    await this.audit(ctx, 'chargeback.accepted', 'chargeback', id, {
      seller_id: cb.seller_id,
      amount_cents: cb.amount_cents,
      chargeback_fee_cents: feeCents,
      total_debited_cents: totalCents,
      debit_failed: !!debitErr,
      notes: dto.notes,
    })

    return { message: 'Chargeback aceito' }
  }

  async contestChargeback(ctx: AdminContext, id: string, dto: {
    evidence_urls: string[]
    notes: string
  }) {
    this.assertAdmin(ctx.role, true)
    if (!dto.evidence_urls?.length) throw new BadRequestException('Envie ao menos uma evidência')

    await supabase.from('chargebacks').update({
      status: 'under_review',
      evidence_submitted: true,
      evidence_urls: dto.evidence_urls,
      evidence_notes: dto.notes,
    }).eq('id', id)

    await this.audit(ctx, 'chargeback.contested', 'chargeback', id, {
      evidence_count: dto.evidence_urls.length,
    })

    return { message: 'Contestação registrada' }
  }

  // ════════════════════════════════════════════════════════════════════════
  // AUDIT LOG
  // ════════════════════════════════════════════════════════════════════════

  async listAudit(ctx: AdminContext, params: {
    action?: string
    resourceType?: string
    search?: string
    dateFrom?: string
    dateTo?: string
    limit?: number
  }) {
    this.assertAdmin(ctx.role)
    const { action, resourceType, search, dateFrom, dateTo, limit = 100 } = params

    let q = supabase
      .from('crm_action_log')
      .select(`
        id, created_at, manager_id, action, resource_type, resource_id,
        payload, ip_address, user_agent,
        crm_managers(name, role)
      `)
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 500))

    if (action && action !== 'all') q = q.ilike('action', `${action}%`)
    if (resourceType) q = q.eq('resource_type', resourceType)
    if (dateFrom) q = q.gte('created_at', dateFrom)
    if (dateTo) q = q.lte('created_at', dateTo)
    if (search) q = q.ilike('action', `%${search}%`)

    const { data, error } = await q
    if (error) throw new BadRequestException(error.message)

    return (data ?? []).map((e: any) => ({
      id: e.id,
      created_at: e.created_at,
      actor_id: e.manager_id,
      actor_name: e.crm_managers?.name ?? '—',
      actor_role: e.crm_managers?.role ?? '—',
      action: e.action,
      resource_type: e.resource_type ?? 'seller',
      resource_id: e.resource_id ?? null,
      metadata: e.payload ?? {},
      ip_address: e.ip_address,
      user_agent: e.user_agent,
    }))
  }

  // ════════════════════════════════════════════════════════════════════════
  // AUDIT LOGGER (uso interno)
  // ════════════════════════════════════════════════════════════════════════

  private async audit(
    ctx: AdminContext,
    action: string,
    resourceType: 'withdrawal' | 'transaction' | 'chargeback' | 'seller',
    resourceId: string,
    payload: Record<string, any>,
  ) {
    await supabase.from('crm_action_log').insert({
      seller_id: payload.seller_id ?? null,
      manager_id: ctx.managerId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      payload,
      ip_address: ctx.ip ?? null,
      user_agent: ctx.userAgent ?? null,
      created_at: new Date(),
    }).then(() => { })
  }
}