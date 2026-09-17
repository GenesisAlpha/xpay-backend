import { Injectable, Logger } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { DEFAULT_PAYOUT_CYCLE, nextPayoutDate, normalizeCycle, type PayoutCycle } from './payout-cycle'

/**
 * Comissão de afiliado sobre o platform_fee.
 *
 * Sai da fatia da Koopfy, não do net do seller indicado — que paga exatamente o
 * mesmo que pagaria sem ter sido indicado. Por isso não usa `external_fee`, que
 * desconta do seller.
 *
 * A identidade do afiliado vive no checkout (bancos separados). Aqui só existe
 * o vínculo já resolvido, em `seller_referrals`.
 */

// A carência não é risco de reembolso: num refund a Koopfy mantém as taxas,
// então a comissão sobre elas também se mantém. Ela existe pelo risco do
// *indicado* — seller que entra, gera volume e some, deixando chargeback na
// conta master. O prazo dá tempo desse sinal aparecer antes do dinheiro sair.
//
// O afiliado recebe em data fixa do mês, não a cada venda: ver payout-cycle.ts.

export interface ReferralRow {
  seller_id: string
  affiliate_seller_id: string
  affiliate_id: string | null
  affiliate_code: string | null
  commission_rate_pct: number
  expires_at: string
}

interface CycleRow {
  affiliate_seller_id: string
  payout_day: number
  hold_days: number
}

export interface AffiliateCommissionPlan {
  affiliateSellerId: string
  commissionCents: number
  ratePct: number
  availableAt: Date
}

@Injectable()
export class AffiliateCommissionService {
  private readonly logger = new Logger(AffiliateCommissionService.name)

  /**
   * Quanto o afiliado do seller ganha nesta transação, ou null.
   *
   * Nunca lança: uma falha aqui não pode derrubar o crédito de uma venda que
   * já foi aprovada pelo provider.
   */
  async planFor(sellerId: string, platformFeeCents: number, saleAvailableAt: Date): Promise<AffiliateCommissionPlan | null> {
    if (!sellerId || platformFeeCents <= 0) return null

    try {
      const referral = await this.activeReferral(sellerId)
      if (!referral) return null

      const ratePct = Number(referral.commission_rate_pct)
      const commissionCents = Math.floor((platformFeeCents * ratePct) / 100)

      // Arredondamento pra baixo pode zerar em transação pequena. Sem centavo
      // não há o que creditar, e uma linha de 0 só suja o extrato.
      if (commissionCents <= 0) return null

      // Cai na carteira na data de ciclo do afiliado, nunca antes da própria
      // venda liquidar — a Koopfy não paga sobre receita que não recebeu.
      const cycle = await this.cycleFor(referral.affiliate_seller_id)
      const availableAt = nextPayoutDate(new Date(), saleAvailableAt, cycle)

      return {
        affiliateSellerId: referral.affiliate_seller_id,
        commissionCents,
        ratePct,
        availableAt,
      }
    } catch (err: any) {
      this.logger.error(`planFor(${sellerId}): ${err?.message ?? err}`)
      return null
    }
  }

  /** Ciclo de pagamento do afiliado, ou o padrão da plataforma. */
  private async cycleFor(affiliateSellerId: string): Promise<PayoutCycle> {
    const { data } = await supabase
      .from('affiliate_payout_cycles')
      .select('payout_day, hold_days')
      .eq('affiliate_seller_id', affiliateSellerId)
      .maybeSingle()

    if (!data) return DEFAULT_PAYOUT_CYCLE

    const row = data as CycleRow
    return normalizeCycle({ payoutDay: row.payout_day, holdDays: row.hold_days })
  }

  /** Vínculo do seller, se ainda dentro da janela de comissionamento. */
  private async activeReferral(sellerId: string): Promise<ReferralRow | null> {
    const { data } = await supabase
      .from('seller_referrals')
      .select('*')
      .eq('seller_id', sellerId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()

    return (data as ReferralRow) ?? null
  }

  /**
   * Registra a comissão apurada. O crédito na wallet é do WalletService, junto
   * com o resto do ledger da transação — isto aqui é o espelho consultável, com
   * a base de cálculo preservada para o extrato e a auditoria.
   */
  async record(input: {
    transactionId: string
    affiliateSellerId: string
    sourceSellerId: string
    platformFeeCents: number
    plan: AffiliateCommissionPlan
  }): Promise<void> {
    const { error } = await supabase.from('affiliate_commissions').insert({
      transaction_id: input.transactionId,
      affiliate_seller_id: input.affiliateSellerId,
      source_seller_id: input.sourceSellerId,
      platform_fee_cents: input.platformFeeCents,
      commission_rate_pct: input.plan.ratePct,
      commission_cents: input.plan.commissionCents,
      status: 'pending',
      available_at: input.plan.availableAt.toISOString(),
    })

    // 23505 = a transação já tinha comissão. Webhook reentregue, nada a fazer.
    if (error && (error as any).code !== '23505') {
      this.logger.error(`record(${input.transactionId}): ${error.message}`)
    }
  }

  /** Vínculo empurrado pelo checkout quando o workspace ativa o pagamento. */
  async upsertReferral(input: {
    sellerId: string
    affiliateSellerId: string
    affiliateId?: string | null
    affiliateCode?: string | null
    commissionRatePct: number
    expiresAt: string
  }) {
    if (input.sellerId === input.affiliateSellerId) {
      // O check da tabela barraria de qualquer jeito; aqui o erro é legível.
      return { ignored: true, reason: 'self_referral' }
    }

    const { error } = await supabase
      .from('seller_referrals')
      .upsert({
        seller_id: input.sellerId,
        affiliate_seller_id: input.affiliateSellerId,
        affiliate_id: input.affiliateId ?? null,
        affiliate_code: input.affiliateCode ?? null,
        commission_rate_pct: input.commissionRatePct,
        expires_at: input.expiresAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'seller_id' })

    if (error) throw new Error('Falha ao gravar o vínculo de afiliado: ' + error.message)

    return { ok: true }
  }
}
