// dashboard/dashboard.service.ts
import { Injectable } from '@nestjs/common'
import { supabase } from '../../lib/supabase.client'

export type Period = 'today' | 'yesterday' | '7d' | '30d' | '90d'

// Converte centavos (INT do banco) → USD real
const c = (v: any): number => Math.round(Number(v ?? 0)) / 100


@Injectable()
export class DashboardService {

  async getData(sellerId: string, period: Period = '30d') {
    const isDay = period === 'today' || period === 'yesterday'

    // ─── Datas do período atual ────────────────────────────────────────────────
    const today = new Date()
    const yesterday = new Date(Date.now() - 864e5)

    let dateFrom: string
    let dateTo: string
    let prevFrom: string
    let prevTo: string

    if (period === 'today') {
      dateFrom = today.toISOString().split('T')[0]
      dateTo = dateFrom
      prevFrom = yesterday.toISOString().split('T')[0]
      prevTo = prevFrom
    } else if (period === 'yesterday') {
      dateFrom = yesterday.toISOString().split('T')[0]
      dateTo = dateFrom
      const twoDaysAgo = new Date(Date.now() - 2 * 864e5)
      prevFrom = twoDaysAgo.toISOString().split('T')[0]
      prevTo = prevFrom
    } else {
      const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
      const from = new Date()
      from.setDate(from.getDate() - days)
      dateFrom = from.toISOString().split('T')[0]
      dateTo = today.toISOString().split('T')[0]
      const pFrom = new Date(from)
      pFrom.setDate(pFrom.getDate() - days)
      prevFrom = pFrom.toISOString().split('T')[0]
      prevTo = dateFrom
    }

    const [kpis, volumeChart, methodsDistribution, recentActivity, topPlayers] = await Promise.all([
      this.getKPIs(sellerId, dateFrom, dateTo, prevFrom, prevTo, isDay),
      isDay ? Promise.resolve([]) : this.getVolumeChart(sellerId, period as '7d' | '30d' | '90d'),
      this.getMethodsDistribution(sellerId, dateFrom, dateTo),
      this.getRecentActivity(sellerId, isDay ? dateFrom : undefined),
      this.getTopPlayers(),
    ])

    return { kpis, volumeChart, methodsDistribution, recentActivity, topPlayers }
  }

  // ─── KPIs ─────────────────────────────────────────────────────────────────────

  private async getKPIs(
    sellerId: string,
    dateFrom: string,
    dateTo: string,
    prevFrom: string,
    prevTo: string,
    isDay: boolean,
  ) {
    const [current, previous] = await Promise.all([
      supabase
        .from('seller_kpis')
        .select('total_volume, approved_volume, total_transactions, approved_transactions, fee_volume, net_volume')
        .eq('seller_id', sellerId)
        .gte('date_key', dateFrom)
        .lte('date_key', dateTo),
      supabase
        .from('seller_kpis')
        .select('total_volume, approved_volume, total_transactions, approved_transactions')
        .eq('seller_id', sellerId)
        .gte('date_key', prevFrom)
        .lte('date_key', prevTo),
    ])

    const sumRaw = (rows: any[], field: string) =>
      (rows ?? []).reduce((acc, r) => acc + Math.round(Number(r[field]) || 0), 0)

    const currVolumeRaw = sumRaw(current.data ?? [], 'approved_volume')
    const prevVolumeRaw = sumRaw(previous.data ?? [], 'approved_volume')
    const currTx = sumRaw(current.data ?? [], 'approved_transactions')
    const prevTx = sumRaw(previous.data ?? [], 'approved_transactions')
    const currApproved = sumRaw(current.data ?? [], 'approved_transactions')
    const currTotal = sumRaw(current.data ?? [], 'total_transactions')
    const prevApproved = sumRaw(previous.data ?? [], 'approved_transactions')
    const prevTotal = sumRaw(previous.data ?? [], 'total_transactions')
    const currNetRaw = sumRaw(current.data ?? [], 'net_volume')
    const prevNetRaw = sumRaw(previous.data ?? [], 'net_volume')

    const pct = (curr: number, prev: number) =>
      prev === 0 ? 0 : Math.round(((curr - prev) / prev) * 1000) / 10

    const approvalRate = currTotal > 0 ? Math.round((currApproved / currTotal) * 1000) / 10 : 0
    const prevApprovalRate = prevTotal > 0 ? Math.round((prevApproved / prevTotal) * 1000) / 10 : 0

    const periodLabel = isDay
      ? (dateFrom === new Date().toISOString().split('T')[0] ? 'vs ontem' : 'vs anteontem')
      : `vs período anterior`

    // Sparklines só para períodos ≥ 7d
    const sparklines = isDay ? null : await this.getSparklines(sellerId)

    return {
      volume: {
        value: c(currVolumeRaw),
        change: pct(currVolumeRaw, prevVolumeRaw),
        isPositive: currVolumeRaw >= prevVolumeRaw,
        period: periodLabel,
        sparkline: sparklines?.volume ?? [],
      },
      transactions: {
        value: currTx,
        change: pct(currTx, prevTx),
        isPositive: currTx >= prevTx,
        period: periodLabel,
        sparkline: sparklines?.transactions ?? [],
      },
      approvalRate: {
        value: approvalRate,
        change: pct(approvalRate, prevApprovalRate),
        isPositive: approvalRate >= prevApprovalRate,
        period: periodLabel,
        sparkline: sparklines?.approvalRate ?? [],
      },
      settled: {
        value: c(currNetRaw),
        change: pct(currNetRaw, prevNetRaw),
        isPositive: currNetRaw >= prevNetRaw,
        period: periodLabel,
        progress: prevNetRaw > 0
          ? Math.min(100, Math.round((currNetRaw / prevNetRaw) * 100))
          : 0,
      },
    }
  }

  private async getSparklines(sellerId: string) {
    const { data } = await supabase
      .from('seller_kpis')
      .select('date_key, approved_volume, approved_transactions, total_transactions')
      .eq('seller_id', sellerId)
      .order('date_key', { ascending: false })
      .limit(7)

    const rows = (data ?? []).reverse()

    return {
      days: rows.length,
      volume: rows.map(r => ({ value: c(r.approved_volume) })),
      transactions: rows.map(r => ({ value: Math.round(Number(r.approved_transactions)) || 0 })),
      approvalRate: rows.map(r => ({
        value: Number(r.total_transactions) > 0
          ? Math.round((Number(r.approved_transactions) / Number(r.total_transactions)) * 1000) / 10
          : 0,
      })),
    }
  }

  // ─── Volume Chart (só para 7d / 30d / 90d) ───────────────────────────────────

  private async getVolumeChart(sellerId: string, period: '7d' | '30d' | '90d') {
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
    const dateFrom = new Date()
    dateFrom.setDate(dateFrom.getDate() - days)

    const { data } = await supabase
      .from('seller_kpis')
      .select('date_key, approved_volume')
      .eq('seller_id', sellerId)
      .gte('date_key', dateFrom.toISOString().split('T')[0])
      .order('date_key', { ascending: true })

    const byDay: Record<string, number> = {}
    for (const row of data ?? []) {
      byDay[row.date_key] = (byDay[row.date_key] || 0) + Math.round(Number(row.approved_volume) || 0)
    }

    return Object.entries(byDay).map(([date, volumeCents]) => ({
      day: date.slice(8),
      volume: c(volumeCents),
    }))
  }

  // ─── Methods Distribution ─────────────────────────────────────────────────────

  private async getMethodsDistribution(sellerId: string, dateFrom: string, dateTo: string) {
    const { data } = await supabase
      .from('seller_kpis')
      .select('method, approved_volume')
      .eq('seller_id', sellerId)
      .gte('date_key', dateFrom)
      .lte('date_key', dateTo)

    const byMethod: Record<string, number> = {}
    for (const row of data ?? []) {
      byMethod[row.method] = (byMethod[row.method] || 0) + Math.round(Number(row.approved_volume) || 0)
    }

    const totalCents = Object.values(byMethod).reduce((a, b) => a + b, 0)
    const colors = ['#10b981', '#059669', '#047857', '#065f46', '#064e3b']

    return Object.entries(byMethod)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([method, amountCents], i) => ({
        name: this.formatMethodName(method),
        value: totalCents > 0 ? Math.round((amountCents / totalCents) * 100) : 0,
        amount: c(amountCents),
        color: colors[i] ?? '#374151',
      }))
  }

  // ─── Recent Activity ──────────────────────────────────────────────────────────

  private async getRecentActivity(sellerId: string, dateFilter?: string) {
    let q = supabase
      .from('transactions')
      .select('id, customer_name, method, amount_usd_gross_cents, status, created_at, payment_brand')
      .eq('seller_id', sellerId)
      .in('status', ['approved', 'pending', 'failed'])
      .order('created_at', { ascending: false })
      .limit(8)

    // 🔥 Para hoje/ontem, filtra só transações do dia
    if (dateFilter) {
      q = q
        .gte('created_at', `${dateFilter}T00:00:00`)
        .lte('created_at', `${dateFilter}T23:59:59`)
    }

    const { data } = await q

    return (data ?? []).map(tx => ({
      id: tx.id,
      company: tx.customer_name ?? 'Cliente',
      description: `Pagamento recebido - ${this.formatMethodName(tx.method)}`,
      amount: c(tx.amount_usd_gross_cents),
      time: new Date(tx.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      status: tx.status === 'approved' ? 'approved' : tx.status === 'pending' ? 'pending' : 'completed',
      icon: this.resolveIcon(tx.method, tx.payment_brand),
    }))
  }

  // ─── Top Players ──────────────────────────────────────────────────────────────
  private async getTopPlayers() {
    // 🔥 usar horário local
    const now = new Date();

    const today = `${now.getFullYear()}-${String(
      now.getMonth() + 1,
    ).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;

    const monthStartStr = `${now.getFullYear()}-${String(
      now.getMonth() + 1,
    ).padStart(2, '0')}-01`;

    const [monthlyData, dailyData] = await Promise.all([
      supabase
        .from('seller_kpis')
        .select(
          'seller_id, approved_volume, approved_transactions',
        )
        .gte('date_key', monthStartStr),

      supabase
        .from('seller_kpis')
        .select(
          'seller_id, approved_volume, approved_transactions',
        )
        .eq('date_key', today),
    ]);

    // 🔥 consolidação mensal
    const monthly: Record<
      string,
      { volume: number; transactions: number }
    > = {};

    for (const row of monthlyData.data ?? []) {
      const sellerId = row.seller_id;

      if (!sellerId) continue;

      monthly[sellerId] ??= {
        volume: 0,
        transactions: 0,
      };

      monthly[sellerId].volume += Number(
        row.approved_volume ?? 0,
      );

      monthly[sellerId].transactions += Number(
        row.approved_transactions ?? 0,
      );
    }

    // 🔥 consolidação diária
    const daily: Record<
      string,
      { volume: number; transactions: number }
    > = {};

    for (const row of dailyData.data ?? []) {
      const sellerId = row.seller_id;

      if (!sellerId) continue;

      daily[sellerId] ??= {
        volume: 0,
        transactions: 0,
      };

      daily[sellerId].volume += Number(
        row.approved_volume ?? 0,
      );

      daily[sellerId].transactions += Number(
        row.approved_transactions ?? 0,
      );
    }

    // 🔥 pega todos sellers dos dois rankings
    const allSellerIds = [
      ...new Set([
        ...Object.keys(monthly),
        ...Object.keys(daily),
      ]),
    ];

    if (allSellerIds.length === 0) {
      return {
        monthlyTop: [],
        dailyTop: [],
      };
    }

    const { data: profiles } = await supabase
      .from('seller_profiles')
      .select(
        'id, name, country, instagram, users!inner(avatar_url)',
      )
      .in('id', allSellerIds);

    const profileMap = Object.fromEntries(
      (profiles ?? []).map((p) => [p.id, p]),
    );

    // 🔥 builder genérico
    const buildRanking = (
      source: Record<
        string,
        { volume: number; transactions: number }
      >,
    ) => {
      return Object.entries(source)
        .sort(([, a], [, b]) => b.volume - a.volume)
        .slice(0, 7)
        .map(([id, stats], index) => {
          const profile = profileMap[id];

          const rank = index + 1;

          return {
            rank,

            sellerId: id,

            name: profile?.name ?? 'Vendedor',

            avatar: (
              profile?.name ?? 'VD'
            )
              .slice(0, 2)
              .toUpperCase(),

            avatarUrl:
              (profile as any)?.users?.avatar_url ?? null,

            instagram: profile?.instagram ?? null,

            volume: c(stats.volume),

            transactions: stats.transactions,

            growth: 0,

            badge:
              rank === 1
                ? 'diamond'
                : rank <= 3
                  ? 'gold'
                  : 'silver',

            country: profile?.country ?? 'BR',
          };
        });
    };

    return {
      // 🔥 ranking mensal
      monthlyTop: buildRanking(monthly),

      // 🔥 ranking diário
      dailyTop: buildRanking(daily),
    };
  }
  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private formatMethodName(method: string): string {
    const map: Record<string, string> = {
      card: 'Cartão', credit_card: 'Cartão de Crédito', debit_card: 'Cartão de Débito',
      pix: 'PIX', mbway: 'MB Way', multibanco: 'Multibanco', ideal: 'iDEAL',
      bancontact: 'Bancontact', apple_pay: 'Apple Pay', google_pay: 'Google Pay',
      boleto: 'Boleto', sepa: 'SEPA', oxxo: 'OXXO', spei: 'SPEI', eps: 'EPS', p24: 'P24',
    }
    return map[method] ?? method
  }

  private resolveIcon(method: string, brand?: string | null): string {
    if (['card', 'credit_card', 'debit_card', 'apple_pay', 'google_pay'].includes(method)) {
      return brand?.toLowerCase().includes('visa') ? 'visa'
        : brand?.toLowerCase().includes('master') ? 'mastercard'
          : 'card'
    }
    if (method === 'pix') return 'pix'
    return 'exchange'
  }
}