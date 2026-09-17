import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { checkoutFailureMessage, checkoutInternal } from '../crm/checkout-internal'
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

interface AffiliateAccountRow {
  seller_id: string
  affiliate_id: string | null
  code: string | null
  link: string | null
  status: 'active' | 'inactive'
  commission_rate_pct: number
  activated_by: string | null
  activated_at: string
  deactivated_at: string | null
}

/** O que o checkout devolve de cada afiliado. */
interface CheckoutAffiliate {
  sellerId: string | null
  id: string
  email?: string | null
  name?: string | null
  code: string
  status: string
  commissionRatePct: number
  link: string
  clicks?: number
  signups?: number
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

  /**
   * Contas com o programa ativado, com funil (do checkout) e comissão (daqui).
   * Inativas também aparecem: ainda podem ter comissão a receber.
   */
  async list(limit = 200) {
    const { data, error } = await supabase
      .from('affiliate_accounts')
      .select('*')
      .order('activated_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 500))

    if (error) throw new BadRequestException('Falha ao listar afiliados: ' + error.message)

    const accounts = (data ?? []) as AffiliateAccountRow[]
    const ids = accounts.map(a => a.seller_id)

    // Ativados pelo CRM que ainda não têm Koopfy Payments: só existem no
    // checkout até ativarem. Aparecem na lista para o time acompanhar.
    const pendingRes = await checkoutInternal<{ affiliates: CheckoutAffiliate[] }>('affiliates/pending', {})
    const pending = (pendingRes?.affiliates ?? []).map(a => ({
      affiliateId: a.id,
      email: a.email ?? null,
      name: a.name ?? null,
      status: a.status,
      code: a.code,
      link: a.link,
      commissionRatePct: Number(a.commissionRatePct),
      clicks: a.clicks ?? null,
      signups: a.signups ?? null,
    }))

    if (ids.length === 0) return { funnelAvailable: pendingRes !== null, affiliates: [], pending }

    const [statsRes, sellersRes, cycles, funnel] = await Promise.all([
      supabase.from('v_crm_affiliates').select('*').in('affiliate_seller_id', ids),
      supabase.from('seller_profiles').select('id, name, user_id').in('id', ids),
      this.cyclesFor(ids),
      // Uma chamada para a lista inteira. Se o checkout oscilar, a lista sai
      // sem o funil em vez de não sair.
      checkoutInternal<{ affiliates: CheckoutAffiliate[] }>('affiliates/summary', { sellerIds: ids }),
    ])

    const stats = new Map(((statsRes.data ?? []) as CrmAffiliateRow[]).map(r => [r.affiliate_seller_id, r]))
    const names = new Map((sellersRes.data ?? []).map((r: any) => [String(r.id), r.name as string | null]))
    const clicks = new Map((funnel?.affiliates ?? []).map(a => [a.sellerId, a]))

    return {
      funnelAvailable: funnel !== null,
      pending,
      affiliates: accounts.map(acc => {
        const st = stats.get(acc.seller_id)
        const fn = clicks.get(acc.seller_id)
        return {
          sellerId: acc.seller_id,
          sellerName: names.get(acc.seller_id) ?? null,
          status: acc.status,
          code: acc.code,
          link: fn?.link ?? acc.link,
          commissionRatePct: Number(acc.commission_rate_pct),
          activatedAt: acc.activated_at,
          deactivatedAt: acc.deactivated_at,
          clicks: fn?.clicks ?? null,
          signups: fn?.signups ?? null,
          earningSellers: st?.earning_sellers ?? 0,
          totalCents: Number(st?.total_cents ?? 0),
          pendingCents: Number(st?.pending_cents ?? 0),
          availableCents: Number(st?.available_cents ?? 0),
          paidCents: Number(st?.paid_cents ?? 0),
          cycle: cycles.get(acc.seller_id) ?? DEFAULT_PAYOUT_CYCLE,
        }
      }),
    }
  }

  /**
   * Ativa o programa para uma conta e devolve o link.
   *
   * O código nasce no checkout, que é quem resolve o link no cadastro; aqui
   * fica o espelho que a lista usa.
   */
  async activate(ctx: AffiliateCrmContext, sellerId: string, input: { ratePct?: number } = {}) {
    const seller = await this.sellerOrThrow(sellerId)
    const rate = input.ratePct === undefined || input.ratePct === null ? undefined : Number(input.ratePct)
    if (rate !== undefined && (!Number.isFinite(rate) || rate <= 0 || rate >= 100)) {
      throw new BadRequestException('A alíquota deve estar entre 0 e 100.')
    }

    const res = await checkoutInternal<{ affiliate: CheckoutAffiliate }>('affiliates/activate', {
      sellerId,
      email: seller.email,
      commissionRatePct: rate,
    })
    if (!res?.affiliate) {
      throw new ServiceUnavailableException(checkoutFailureMessage('ativar o programa no checkout'))
    }

    const now = new Date().toISOString()
    const { error } = await supabase.from('affiliate_accounts').upsert({
      seller_id: sellerId,
      affiliate_id: res.affiliate.id,
      code: res.affiliate.code,
      link: res.affiliate.link,
      status: 'active',
      commission_rate_pct: res.affiliate.commissionRatePct,
      activated_by: ctx.managerId,
      activated_at: now,
      deactivated_by: null,
      deactivated_at: null,
      updated_at: now,
    }, { onConflict: 'seller_id' })
    if (error) throw new BadRequestException('Afiliado ativado no checkout, mas não registrado aqui: ' + error.message)

    await this.audit(ctx, 'affiliate.activated', sellerId, { code: res.affiliate.code, ratePct: res.affiliate.commissionRatePct })

    return { sellerId, code: res.affiliate.code, link: res.affiliate.link, commissionRatePct: res.affiliate.commissionRatePct }
  }

  /**
   * Ativa pelo e-mail do cadastro no checkout — para quem ainda não tem
   * Koopfy Payments. O link já sai; a comissão começa quando a pessoa ativar
   * o Koopfy Payments (o checkout liga a conta nesse momento).
   *
   * Se o e-mail já tem conta aqui, cai no fluxo normal por conta.
   */
  async activateByEmail(ctx: AffiliateCrmContext, rawEmail: string, input: { ratePct?: number } = {}) {
    const email = String(rawEmail ?? '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Informe um e-mail válido.')
    }
    const rate = this.optionalRate(input.ratePct)

    const existing = await this.sellerByEmail(email)
    if (existing) return this.activate(ctx, existing, { ratePct: rate })

    const res = await checkoutInternal<{ affiliate: CheckoutAffiliate }>('affiliates/activate', {
      email,
      commissionRatePct: rate,
    })
    if (!res?.affiliate) {
      throw new ServiceUnavailableException(checkoutFailureMessage('ativar o programa no checkout'))
    }

    await this.audit(ctx, 'affiliate.activated', email, {
      code: res.affiliate.code,
      ratePct: res.affiliate.commissionRatePct,
      withoutPayments: true,
    })

    return {
      sellerId: null,
      affiliateId: res.affiliate.id,
      code: res.affiliate.code,
      link: res.affiliate.link,
      commissionRatePct: res.affiliate.commissionRatePct,
      awaitingPayments: true,
    }
  }

  /** Desativa ou reativa quem ainda não tem Koopfy Payments (só existe no checkout). */
  async updatePending(ctx: AffiliateCrmContext, affiliateId: string, status: 'active' | 'inactive') {
    const res = await checkoutInternal<{ affiliate: CheckoutAffiliate }>('affiliates/update', { affiliateId, status })
    if (!res?.affiliate) {
      throw new ServiceUnavailableException(checkoutFailureMessage('atualizar o afiliado no checkout'))
    }
    await this.audit(ctx, status === 'active' ? 'affiliate.activated' : 'affiliate.deactivated', affiliateId, {
      withoutPayments: true,
    })
    return { affiliateId, status }
  }

  /**
   * Conta que acabou de ativar o Koopfy Payments sendo afiliada: o checkout
   * avisa, e ela entra na lista. Não sobrescreve quem ativou nem quando.
   */
  async upsertFromCheckout(input: {
    sellerId: string
    affiliateId: string | null
    code: string | null
    link: string | null
    status: 'active' | 'inactive'
    commissionRatePct: number
  }) {
    const rate = Number.isFinite(input.commissionRatePct) && input.commissionRatePct > 0 && input.commissionRatePct < 100
      ? input.commissionRatePct
      : 20
    const now = new Date().toISOString()

    const { data: current } = await supabase
      .from('affiliate_accounts').select('seller_id').eq('seller_id', input.sellerId).maybeSingle()

    const row = {
      seller_id: input.sellerId,
      affiliate_id: input.affiliateId,
      code: input.code,
      link: input.link,
      status: input.status,
      commission_rate_pct: rate,
      updated_at: now,
    }

    const { error } = current
      ? await supabase.from('affiliate_accounts').update(row).eq('seller_id', input.sellerId)
      : await supabase.from('affiliate_accounts').insert({ ...row, activated_by: 'checkout', activated_at: now })

    if (error) throw new BadRequestException('Falha ao registrar a conta do afiliado: ' + error.message)
    return { ok: true }
  }

  private optionalRate(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined
    const rate = Number(value)
    if (!Number.isFinite(rate) || rate <= 0 || rate >= 100) {
      throw new BadRequestException('A alíquota deve estar entre 0 e 100.')
    }
    return rate
  }

  /** Conta do Koopfy Payments do e-mail, se existir. */
  private async sellerByEmail(email: string): Promise<string | null> {
    const { data: user } = await supabase.from('users').select('id').ilike('email', email).maybeSingle()
    if (!user?.id) return null
    const { data: seller } = await supabase
      .from('seller_profiles').select('id').eq('user_id', user.id).maybeSingle()
    return seller?.id ? String(seller.id) : null
  }

  /**
   * Tira o link do ar: cliques e cadastros novos deixam de ser atribuídos.
   *
   * Com `closeReferrals`, também encerra a comissão dos indicados que ele já
   * trouxe. Sem isso, os indicados atuais seguem gerando até a janela fechar —
   * desativar o convite não é o mesmo que cortar o que já foi combinado.
   */
  async deactivate(ctx: AffiliateCrmContext, sellerId: string, input: { closeReferrals?: boolean; reason?: string } = {}) {
    const res = await checkoutInternal<{ affiliate: CheckoutAffiliate }>('affiliates/update', { sellerId, status: 'inactive' })
    if (!res?.affiliate) {
      throw new ServiceUnavailableException(checkoutFailureMessage('desativar o link no checkout'))
    }

    const now = new Date().toISOString()
    await supabase.from('affiliate_accounts')
      .update({ status: 'inactive', deactivated_by: ctx.managerId, deactivated_at: now, updated_at: now })
      .eq('seller_id', sellerId)

    if (input.closeReferrals) {
      await this.suspend(ctx, sellerId, input.reason)
    }

    await this.audit(ctx, 'affiliate.deactivated', sellerId, {
      closeReferrals: !!input.closeReferrals,
      reason: input.reason ?? null,
    })

    return { sellerId, status: 'inactive', referralsClosed: !!input.closeReferrals }
  }

  /** Conta do pay com o e-mail do dono — é o elo com o checkout. */
  private async sellerOrThrow(sellerId: string) {
    const { data: seller } = await supabase
      .from('seller_profiles').select('id, user_id, name').eq('id', sellerId).maybeSingle()
    if (!seller) throw new NotFoundException('Seller não encontrado.')

    const { data: user } = seller.user_id
      ? await supabase.from('users').select('email').eq('id', seller.user_id).maybeSingle()
      : { data: null as any }

    return { id: String(seller.id), name: seller.name as string | null, email: (user?.email as string | undefined) ?? undefined }
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

    // Checkout primeiro: é de lá que saem os vínculos novos. Se falhar, nada
    // muda aqui e a tela mostra o motivo — sem alíquota pela metade.
    const synced = await checkoutInternal('affiliates/update', { sellerId: affiliateSellerId, commissionRatePct: ratePct })
    if (!synced) {
      throw new ServiceUnavailableException(checkoutFailureMessage('atualizar a alíquota no checkout'))
    }

    const now = new Date().toISOString()
    const { error } = await supabase
      .from('seller_referrals')
      .update({ commission_rate_pct: ratePct, updated_at: now })
      .eq('affiliate_seller_id', affiliateSellerId)
    if (error) throw new BadRequestException('Falha ao gravar a alíquota: ' + error.message)

    await supabase.from('affiliate_accounts')
      .update({ commission_rate_pct: ratePct, updated_at: now })
      .eq('seller_id', affiliateSellerId)

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
