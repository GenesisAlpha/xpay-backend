import { Injectable, OnModuleInit } from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';

// ============================================================================
// RISCO POR AFILIADO — atribuir a disputa a quem a originou
// ----------------------------------------------------------------------------
// O StripeRiskService mede risco por CONTA, porque é a conta que responde
// perante a Stripe. Este serviço mede por AFILIADO, porque é o afiliado que
// causa — e são duas perguntas diferentes sobre o mesmo fato.
//
// NO MODELO DE AFILIAÇÃO A CONTA NÃO É A CAUSA. Produto da Koopfy, preço da
// Koopfy, afiliado trazendo tráfego: a conta é só onde o dinheiro entrou. Uma
// disputa nasce de tráfego incentivado, público errado, promessa que o produto
// não cumpre ou cartão testado — tudo do lado do afiliado.
//
// SEM ISTO, O REMÉDIO É O ERRADO. Um afiliado ruim empurra a conta para o
// limiar, o governador quarentena a conta, e o afiliado segue vendendo — agora
// envenenando a próxima conta do pool. Você tira do ar a parte saudável e
// mantém no ar a origem. Depois de duas ou três voltas, não sobra pool.
//
// ⚠️ ESTE SERVIÇO NÃO SUSPENDE NINGUÉM. Cortar afiliado é decisão comercial
// com contrato atrás — e um falso positivo custa um parceiro. Ele mede,
// classifica, registra e grita. A ação é humana, e o histórico em
// `affiliate_risk_snapshots` existe justamente para essa conversa: "há quanto
// tempo isso vem piorando?" é o que separa avisar de cortar.
// ============================================================================

// Limiares mais FROUXOS que os da conta, de propósito.
//
// A conta agrega muitos afiliados: quando ela cruza 0,65%, já há um problema
// distribuído. Um afiliado sozinho a 0,65% ainda pode ser diluído pelo resto —
// mas é exatamente ele que vai levar a conta lá. Por isso o alerta individual
// dispara antes: é a única janela em que dá para cortar a causa sem perder a
// conta junto.
const AFF_DISPUTE_WATCH     = 0.0060;  // 0,60%
const AFF_DISPUTE_CRITICAL  = 0.0120;  // 1,20%
const AFF_DISPUTE_SEVERE    = 0.0250;  // 2,50%

// Reembolso alto sem disputa é outro sinal, e chega ANTES: significa promessa
// desalinhada com entrega. O comprador pediu dinheiro de volta em vez de
// contestar — desta vez.
const AFF_REFUND_WATCH      = 0.1000;  // 10%
const AFF_REFUND_CRITICAL   = 0.2000;  // 20%

// Amostra mínima para a taxa significar algo. Abaixo disso, contagem absoluta.
const AFF_MIN_SAMPLE = 50;
const AFF_ABSOLUTE_DISPUTE_FLOOR = 3;

const AFF_WINDOW_DAYS = 30;

export type AffiliateTier = 'OK' | 'WATCH' | 'CRITICAL' | 'SEVERE';

export interface AffiliateRisk {
  sellerId: string;
  sellerName: string | null;
  paidCount: number;
  paidVolumeUsdCents: number;
  disputeCount: number;
  efwCount: number;
  refundCount: number;
  disputeRate: number;
  refundRate: number;
  tier: AffiliateTier;
  reason: string;
  lowSample: boolean;
}

@Injectable()
export class AffiliateRiskService implements OnModuleInit {

  private tiers = new Map<string, AffiliateRisk>();

  // Mais espaçado que o ciclo da conta (15 min): a decisão que sai daqui é
  // humana e comercial, e não melhora por ser recalculada quatro vezes por hora.
  private readonly INTERVAL_MS = 60 * 60 * 1000;

  onModuleInit() {
    setTimeout(() => void this.evaluateAll(), 90_000);
    setInterval(() => void this.evaluateAll(), this.INTERVAL_MS);
  }

  // ─────────────────────────────────────────────
  // Ciclo
  // ─────────────────────────────────────────────

  async evaluateAll(): Promise<AffiliateRisk[]> {
    const { data, error } = await supabase.rpc('affiliate_pool_risk_window', {
      p_days: AFF_WINDOW_DAYS,
      p_min_paid: 1,
    });

    if (error) {
      console.error('[AffiliateRisk] affiliate_pool_risk_window error:', error.message);
      return [];
    }

    const flagged: AffiliateRisk[] = [];

    for (const row of (data ?? []) as any[]) {
      const risk = this.classify({
        sellerId: String(row.seller_id),
        sellerName: row.seller_name ?? null,
        paidCount: Number(row.paid_count ?? 0),
        paidVolumeUsdCents: Number(row.paid_volume_usd_cents ?? 0),
        disputeCount: Number(row.dispute_count ?? 0),
        efwCount: Number(row.efw_count ?? 0),
        refundCount: Number(row.refund_count ?? 0),
      });

      this.tiers.set(risk.sellerId, risk);

      if (risk.tier !== 'OK') {
        flagged.push(risk);
        await this.report(risk);
      }
    }

    if (flagged.length > 0) {
      // O resumo importa tanto quanto as linhas individuais: um afiliado ruim é
      // um afiliado ruim; dez ao mesmo tempo é um problema de oferta, de
      // política de aprovação ou de criativo aprovado — e a ação é outra.
      const severe = flagged.filter(f => f.tier === 'SEVERE').length;
      const critical = flagged.filter(f => f.tier === 'CRITICAL').length;
      console.error(
        `[AffiliateRisk] ${flagged.length} afiliado(s) fora do padrão em ${AFF_WINDOW_DAYS}d `
        + `(${severe} severo, ${critical} crítico). `
        + (flagged.length >= 5
          ? 'Vários ao mesmo tempo raramente é coincidência — olhe a oferta e o '
            + 'criativo aprovado antes de olhar os afiliados um a um.'
          : 'Cortar a causa aqui evita a quarentena da conta lá na frente.'),
      );
    }

    return flagged;
  }

  async evaluateOne(sellerId: string): Promise<AffiliateRisk | null> {
    const { data, error } = await supabase.rpc('affiliate_risk_window', {
      p_seller_id: sellerId,
      p_days: AFF_WINDOW_DAYS,
    });

    if (error) {
      console.error('[AffiliateRisk] affiliate_risk_window error:', error.message);
      return null;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;

    const risk = this.classify({
      sellerId,
      sellerName: null,
      paidCount: Number(row.paid_count ?? 0),
      paidVolumeUsdCents: Number(row.paid_volume_usd_cents ?? 0),
      disputeCount: Number(row.dispute_count ?? 0),
      efwCount: Number(row.efw_count ?? 0),
      refundCount: Number(row.refund_count ?? 0),
    });

    this.tiers.set(sellerId, risk);
    if (risk.tier !== 'OK') await this.report(risk);
    return risk;
  }

  // ─────────────────────────────────────────────
  // Classificação
  // ─────────────────────────────────────────────

  private classify(m: {
    sellerId: string;
    sellerName: string | null;
    paidCount: number;
    paidVolumeUsdCents: number;
    disputeCount: number;
    efwCount: number;
    refundCount: number;
  }): AffiliateRisk {
    const denom = Math.max(m.paidCount, 1);
    const disputeRate = m.disputeCount / denom;
    const refundRate = m.refundCount / denom;
    const lowSample = m.paidCount < AFF_MIN_SAMPLE;

    let tier: AffiliateTier = 'OK';
    let reason = 'dentro do padrão';

    if (lowSample) {
      // Afiliado novo com três disputas nas primeiras dezenas de vendas não é
      // ruído estatístico — é o padrão de quem está mandando tráfego ruim de
      // propósito, e quanto antes for visto, menos custa.
      if (m.disputeCount >= AFF_ABSOLUTE_DISPUTE_FLOOR) {
        tier = 'CRITICAL';
        reason = `${m.disputeCount} disputas nas primeiras ${m.paidCount} vendas `
          + '(afiliado novo — contagem absoluta, não taxa)';
      } else if (m.disputeCount > 0 || m.efwCount > 0) {
        tier = 'WATCH';
        reason = `${m.disputeCount} disputa(s) e ${m.efwCount} EFW em ${m.paidCount} vendas `
          + `(amostra abaixo de ${AFF_MIN_SAMPLE})`;
      }
      return { ...m, disputeRate, refundRate, tier, reason, lowSample };
    }

    if (disputeRate >= AFF_DISPUTE_SEVERE) {
      tier = 'SEVERE';
      reason = `disputa em ${(disputeRate * 100).toFixed(2)}% — sozinho, este afiliado `
        + 'é capaz de levar a conta ao limiar das bandeiras';
    } else if (disputeRate >= AFF_DISPUTE_CRITICAL || refundRate >= AFF_REFUND_CRITICAL) {
      tier = 'CRITICAL';
      reason = `disputa ${(disputeRate * 100).toFixed(2)}% / reembolso `
        + `${(refundRate * 100).toFixed(1)}% muito acima do padrão`;
    } else if (disputeRate >= AFF_DISPUTE_WATCH || refundRate >= AFF_REFUND_WATCH) {
      tier = 'WATCH';
      reason = `disputa ${(disputeRate * 100).toFixed(2)}% / reembolso `
        + `${(refundRate * 100).toFixed(1)}% em tendência de alta`;
    }

    return { ...m, disputeRate, refundRate, tier, reason, lowSample };
  }

  // ─────────────────────────────────────────────
  // Registro e alerta
  // ─────────────────────────────────────────────

  private async report(risk: AffiliateRisk): Promise<void> {
    const { error } = await supabase.from('affiliate_risk_snapshots').insert({
      seller_id: risk.sellerId,
      tier: risk.tier,
      reason: risk.reason,
      paid_count: risk.paidCount,
      dispute_count: risk.disputeCount,
      efw_count: risk.efwCount,
      refund_count: risk.refundCount,
      dispute_rate: Number(risk.disputeRate.toFixed(6)),
      refund_rate: Number(risk.refundRate.toFixed(6)),
    });

    if (error) console.error('[AffiliateRisk] snapshot insert error:', error.message);

    const nome = risk.sellerName ? `${risk.sellerName} (${risk.sellerId})` : risk.sellerId;
    const linha =
      `[AffiliateRisk] ${risk.tier}: ${nome} — ${risk.reason} `
      + `(${risk.disputeCount} disputas / ${risk.refundCount} reembolsos / `
      + `${risk.paidCount} vendas em ${AFF_WINDOW_DAYS}d)`;

    if (risk.tier === 'SEVERE') {
      console.error(
        linha + '\n'
        + '  → Ação no AFILIADO, não na conta. Quarentenar a conta aqui tira do ar a '
        + 'parte saudável e deixa a causa vendendo — que passa a envenenar a próxima '
        + 'conta do pool. Como merchant, o criativo dele também é a sua exposição: '
        + 'revise o que ele está anunciando antes de decidir.',
      );
      return;
    }

    console.warn(linha);
  }

  // ─────────────────────────────────────────────
  // Consulta
  // ─────────────────────────────────────────────

  tierOf(sellerId: string): AffiliateTier {
    return this.tiers.get(sellerId)?.tier ?? 'OK';
  }

  riskOf(sellerId: string): AffiliateRisk | null {
    return this.tiers.get(sellerId) ?? null;
  }

  // Piores primeiro — é a ordem em que a lista é útil.
  snapshot(): AffiliateRisk[] {
    return [...this.tiers.values()]
      .filter(r => r.tier !== 'OK')
      .sort((a, b) => b.disputeRate - a.disputeRate);
  }

  // Histórico de um afiliado: responde "há quanto tempo isso vem piorando?",
  // que é o que separa avisar de cortar.
  async history(sellerId: string, limit = 30) {
    const { data, error } = await supabase
      .from('affiliate_risk_snapshots')
      .select('tier, reason, paid_count, dispute_count, dispute_rate, refund_rate, evaluated_at')
      .eq('seller_id', sellerId)
      .order('evaluated_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[AffiliateRisk] history error:', error.message);
      return [];
    }
    return data ?? [];
  }
}
