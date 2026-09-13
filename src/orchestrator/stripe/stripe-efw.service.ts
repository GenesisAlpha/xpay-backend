import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { supabase } from '../../lib/supabase.client';
import { StripeAccountsService } from './stripe-accounts.service';

// ============================================================================
// EARLY FRAUD WARNING — auto-reembolso na janela que ainda muda o placar
// ----------------------------------------------------------------------------
// O QUE É. O emissor reporta a cobrança como fraude (TC40 da Visa, SAFE da
// Mastercard) e a Stripe repassa como `radar.early_fraud_warning.created`. Isso
// chega ANTES de o portador abrir disputa — tipicamente dias antes.
//
// POR QUE REEMBOLSAR AQUI É A ÚNICA JOGADA QUE MUDA ALGO. EFW não entra no
// denominador dos programas de monitoramento das bandeiras (VDMP, ECP).
// Disputa entra. Reembolsar dentro da janela converte um evento que contaria
// contra a conta num evento que não conta — é a diferença entre uma conta que
// se recupera e uma que cruza o limiar.
//
// ⚠️ MAS NÃO CONFUNDA COM PROTEÇÃO. Isto trata o SINTOMA. EFW em volume
// significa que a operação está atraindo cartão fraudado, e a causa está antes
// do checkout: criativo, público, ausência de 3DS, produto que atrai teste de
// cartão. Se o EFW subir, a resposta certa é olhar a origem — reembolsar mais
// rápido só compra tempo, e compra cada vez menos.
//
// ⚠️ ESTE SERVIÇO DEVOLVE DINHEIRO REAL SEM APROVAÇÃO HUMANA. Por isso é
// opt-in por conta (`efw_auto_refund`), tem teto (`efw_auto_refund_max_usd_cents`)
// e registra toda decisão em `stripe_efw_decisions` — inclusive as de NÃO
// reembolsar, que são as que ninguém pensa em registrar e são justamente as
// que você vai querer explicar depois.
// ============================================================================

export type EfwDecision =
  | 'refunded'
  | 'skipped_above_cap'
  | 'skipped_disabled'
  | 'skipped_already_settled'
  | 'skipped_disputed'
  | 'skipped_orphan'
  | 'failed';

export interface EfwOutcome {
  decision: EfwDecision;
  reason: string;
  refundId?: string;
}

@Injectable()
export class StripeEfwService {
  constructor(private readonly accounts: StripeAccountsService) { }

  // ─────────────────────────────────────────────
  // Decide e executa. Nunca lança: uma falha aqui não pode derrubar o
  // processamento do webhook — o registro do evento de risco (que alimenta a
  // quarentena automática) importa mais que o reembolso, e já aconteceu antes
  // desta chamada.
  // ─────────────────────────────────────────────

  async handle(args: {
    efwId: string;
    accountId: string;
    chargeId?: string | null;
    paymentIntentId?: string | null;
    fraudType?: string | null;
    transactionId?: string | null;
  }): Promise<EfwOutcome> {
    try {
      return await this.decide(args);
    } catch (err: any) {
      console.error(`[StripeEfw] falha ao tratar ${args.efwId}:`, err?.message);
      await this.record(args, 'failed', err?.message ?? 'erro desconhecido');
      return { decision: 'failed', reason: err?.message ?? 'erro desconhecido' };
    }
  }

  private async decide(args: {
    efwId: string;
    accountId: string;
    chargeId?: string | null;
    paymentIntentId?: string | null;
    fraudType?: string | null;
    transactionId?: string | null;
  }): Promise<EfwOutcome> {
    const row = await this.accounts.getRowById(args.accountId);

    if (!row) {
      const reason = `conta ${args.accountId} não encontrada`;
      await this.record(args, 'skipped_orphan', reason);
      return { decision: 'skipped_orphan', reason };
    }

    // ── Chave liga/desliga por conta ──
    if (!row.efw_auto_refund) {
      const reason =
        'auto-reembolso desligado nesta conta (stripe_accounts.efw_auto_refund=false)';
      await this.record(args, 'skipped_disabled', reason);
      console.warn(
        `[StripeEfw] ⚠️ EFW ${args.efwId} em ${args.accountId} NÃO reembolsado: ${reason}. `
        + 'Reembolse à mão nas próximas horas — depois que virar disputa, não dá mais '
        + 'para tirar do denominador das bandeiras.',
      );
      return { decision: 'skipped_disabled', reason };
    }

    if (!args.chargeId && !args.paymentIntentId) {
      const reason = 'EFW sem charge nem payment_intent — nada para reembolsar';
      await this.record(args, 'skipped_orphan', reason);
      return { decision: 'skipped_orphan', reason };
    }

    const secret = await this.accounts.getSecretKey(args.accountId);
    if (!secret) {
      const reason = `conta ${args.accountId} sem secret_key utilizável`;
      await this.record(args, 'failed', reason);
      return { decision: 'failed', reason };
    }

    const stripe = new Stripe(secret, {
      apiVersion: '2023-10-16',
      maxNetworkRetries: 2,
      timeout: 15_000,
    });

    // ── Estado real da cobrança na Stripe ──
    // Fonte da verdade é a Stripe, não a nossa tabela: entre o pagamento e o
    // EFW alguém pode ter reembolsado pelo painel, e reembolsar de novo
    // devolveria dinheiro duas vezes.
    const charge = await this.resolveCharge(stripe, args);

    if (!charge) {
      const reason = 'cobrança não localizada na Stripe';
      await this.record(args, 'skipped_orphan', reason);
      return { decision: 'skipped_orphan', reason };
    }

    if (charge.refunded || (charge.amount_refunded ?? 0) >= charge.amount) {
      const reason = 'cobrança já estava totalmente reembolsada';
      await this.record({ ...args, chargeId: charge.id }, 'skipped_already_settled', reason, charge);
      return { decision: 'skipped_already_settled', reason };
    }

    // Disputa já aberta: reembolsar NÃO ajuda. O valor já saiu para o processo
    // de disputa, e o evento já entrou no denominador das bandeiras. O que vale
    // aqui é contestar com evidência (ou aceitar), não estornar.
    if (charge.disputed) {
      const reason =
        'disputa já aberta — reembolso não remove o evento do denominador das bandeiras; '
        + 'o caminho agora é contestar com evidência ou aceitar';
      await this.record({ ...args, chargeId: charge.id }, 'skipped_disputed', reason, charge);
      console.error(`[StripeEfw] ${args.efwId} em ${args.accountId}: ${reason}`);
      return { decision: 'skipped_disputed', reason };
    }

    // ── Teto ──
    // Comparado em USD cents. A cobrança pode estar em BRL, então convertemos
    // pelo que a transação guardou — que é o único número já convertido e
    // auditado que temos. Sem transação casada, o teto NÃO é aplicado por
    // aproximação: preferimos não reembolsar a reembolsar com base num palpite.
    const cap = row.efw_auto_refund_max_usd_cents;
    if (cap != null) {
      const usdCents = await this.resolveUsdCents(args.transactionId, charge);

      if (usdCents == null) {
        const reason =
          `teto configurado (${cap} USD cents) mas não foi possível determinar o valor em USD `
          + '(transação não casada) — não reembolsado por precaução';
        await this.record({ ...args, chargeId: charge.id }, 'skipped_above_cap', reason, charge);
        console.error(`[StripeEfw] ${args.efwId} em ${args.accountId}: ${reason}`);
        return { decision: 'skipped_above_cap', reason };
      }

      if (usdCents > cap) {
        const reason = `valor ${usdCents} USD cents acima do teto ${cap} — decisão humana`;
        await this.record({ ...args, chargeId: charge.id }, 'skipped_above_cap', reason, charge);
        console.error(
          `[StripeEfw] ⚠️ EFW ${args.efwId} em ${args.accountId} acima do teto: ${reason}. `
          + 'Ticket alto também é onde mora a fraude amigável, que se contesta e se ganha — '
          + 'olhe antes de estornar.',
        );
        return { decision: 'skipped_above_cap', reason };
      }
    }

    // ── Reembolso ──
    //
    // reason: 'fraudulent' aqui é DELIBERADO e é o oposto do default do
    // StripeProvider.refund ('requested_by_customer'). Numa EFW o emissor já
    // classificou como fraude: marcar assim alimenta o Radar e põe o cartão na
    // blocklist da conta, o que evita a segunda tentativa com o mesmo plástico.
    // Usar 'fraudulent' em reembolso comum seria o erro inverso — sujaria o
    // histórico de fraude da conta de graça.
    const refund = await stripe.refunds.create(
      {
        charge: charge.id,
        reason: 'fraudulent',
        metadata: {
          koopfy_efw_id: args.efwId,
          koopfy_transaction_id: String(args.transactionId ?? ''),
          koopfy_fraud_type: String(args.fraudType ?? ''),
        },
      },
      // Derivada do EFW: reentrega do webhook não reembolsa duas vezes, mesmo
      // se o dedupe de evento falhar por qualquer motivo.
      { idempotencyKey: `koopfy_efw_${args.efwId}` },
    );

    await this.record({ ...args, chargeId: charge.id }, 'refunded', 'reembolsado automaticamente', charge, refund.id);

    console.warn(
      `[StripeEfw] ✅ EFW ${args.efwId} em ${args.accountId}: reembolsado `
      + `${charge.amount} ${charge.currency?.toUpperCase()} (refund ${refund.id}, `
      + `tipo=${args.fraudType ?? '?'}). Evitou uma disputa — mas conte este EFW: `
      + 'volume de EFW é problema de origem, não de velocidade de reembolso.',
    );

    return { decision: 'refunded', reason: 'reembolsado automaticamente', refundId: refund.id };
  }

  // ─────────────────────────────────────────────
  // A EFW traz `charge` na maioria dos casos; quando só vem o intent,
  // buscamos o charge mais recente dele.
  // ─────────────────────────────────────────────

  private async resolveCharge(
    stripe: Stripe,
    args: { chargeId?: string | null; paymentIntentId?: string | null },
  ): Promise<Stripe.Charge | null> {
    if (args.chargeId) {
      try {
        return await stripe.charges.retrieve(args.chargeId);
      } catch (err: any) {
        console.error('[StripeEfw] charges.retrieve falhou:', err?.message);
      }
    }

    if (args.paymentIntentId) {
      try {
        const intent = await stripe.paymentIntents.retrieve(args.paymentIntentId, {
          expand: ['latest_charge'],
        });
        const latest = (intent as any).latest_charge;
        if (latest && typeof latest === 'object') return latest as Stripe.Charge;
        if (typeof latest === 'string') return await stripe.charges.retrieve(latest);
      } catch (err: any) {
        console.error('[StripeEfw] paymentIntents.retrieve falhou:', err?.message);
      }
    }

    return null;
  }

  // Valor em USD cents. Prefere o que a transação já converteu e auditou;
  // só cai no valor bruto do charge quando a moeda dele JÁ é USD.
  private async resolveUsdCents(
    transactionId: string | null | undefined,
    charge: Stripe.Charge,
  ): Promise<number | null> {
    if (transactionId) {
      const { data } = await supabase
        .from('transactions')
        .select('amount_usd_net_cents')
        .eq('id', transactionId)
        .maybeSingle();

      if (data?.amount_usd_net_cents != null) return Number(data.amount_usd_net_cents);
    }

    if (String(charge.currency ?? '').toUpperCase() === 'USD') return charge.amount;

    return null;
  }

  private async record(
    args: { efwId: string; accountId: string; transactionId?: string | null; chargeId?: string | null },
    decision: EfwDecision,
    reason: string,
    charge?: Stripe.Charge | null,
    refundId?: string,
  ): Promise<void> {
    const { error } = await supabase.from('stripe_efw_decisions').insert({
      efw_id: args.efwId,
      account_id: args.accountId,
      transaction_id: args.transactionId ?? null,
      charge_id: args.chargeId ?? charge?.id ?? null,
      decision,
      reason,
      amount_cents: charge?.amount ?? null,
      currency: charge?.currency ?? null,
      refund_id: refundId ?? null,
    });

    // 23505 = reentrega do mesmo EFW. A decisão original é a que vale.
    if (error && (error as any).code !== '23505') {
      console.error('[StripeEfw] record error:', error.message);
    }
  }
}
