import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { supabase } from '../lib/supabase.client';
import { AccountRouterService } from '../orchestrator/router/account-router.service';
import { getProviderAccountById } from '../orchestrator/provider-accounts.config';
import { isOwnProviderAccountId } from '../orchestrator/seller-provider/seller-provider-accounts';
import { WhopProvider } from '../orchestrator/providers/whop.provider';
import { StripeProvider } from '../orchestrator/providers/stripe.provider';
import { SlashProvider } from '../orchestrator/providers/slash.provider';
import { ClipProvider } from '../orchestrator/providers/clip.provider';
import { WebhookService } from '../webhooks/webhook.service';
import type { SellerCtx } from './cross-service-jwt.guard';

// ════════════════════════════════════════════════════════════════════════════
// REEMBOLSO PEDIDO PELO SELLER (Financeiro › Transações)
// ────────────────────────────────────────────────────────────────────────────
// Sempre TOTAL e sempre pela API do provedor que cobrou: o comprador só recebe
// se o estorno sair de verdade. Marcar "reembolsado" só no banco avisa o
// comprador de um dinheiro que não volta — e ele abre disputa.
//
// TRÊS REGRAS QUE NÃO SÃO DETALHE:
//
//   1. O SELLER PAGA O VALOR CHEIO. A taxa da Koopfy não é reembolsável
//      (decisão do dono, ver webhooks/refund-fee.ts). A tela mostra isso antes.
//   2. PRECISA TER SALDO. O estorno sai da conta da Koopfy no provedor; se o
//      seller já sacou, devolver o comprador deixaria a conta dele negativa e a
//      plataforma no prejuízo (e seria um jeito de sacar duas vezes, combinado
//      com o comprador). Sem saldo que cubra, o pedido é recusado.
//   3. A MARCA VAI ANTES DA CHAMADA. `refund_requested_by` na transação é o que
//      diz ao webhook que o estorno é nosso — sem ela a Whop "estornou sozinha"
//      e o seller pagaria a taxa de chargeback. Se o provedor recusa, a marca sai.
//
// Recusa de negócio sai como 400 com `error` + `message`: o backend do checkout
// só repassa ao painel a mensagem de 400/422 (as demais viram texto genérico).
//
// A contabilidade (saldo, reserva, aviso ao checkout) é a do webhook de estorno
// — WebhookService.refundTransaction. Aqui só se antecipa quando o provedor já
// confirma na resposta (a Clip nem manda webhook).
// ════════════════════════════════════════════════════════════════════════════

/** Pedido em aberto: não repete a chamada ao provedor enquanto o webhook não chega. */
const PENDING_WINDOW_MS = 30 * 60 * 1000;

export interface RefundRequestResult {
  status: 'refunded' | 'requested';
  message: string;
}

/** O que impede o reembolso, antes de falar com o provedor. null = pode seguir. */
export function refundBlocker(tx: any, now = Date.now()): { code: string; message: string } | null {
  if (!tx) return { code: 'NOT_FOUND', message: 'Transação não encontrada.' };
  const status = String(tx.status ?? '');
  if (status === 'refunded') return { code: 'ALREADY_REFUNDED', message: 'Esta venda já foi reembolsada.' };
  if (status === 'chargeback') return { code: 'CHARGEBACK', message: 'Esta venda teve chargeback: o valor já voltou ao comprador pelo banco.' };
  if (status !== 'approved') return { code: 'NOT_APPROVED', message: 'Só é possível reembolsar uma venda aprovada.' };

  const requestedAt = Date.parse(String(tx.metadata?.refund_requested_at ?? ''));
  if (Number.isFinite(requestedAt) && now - requestedAt < PENDING_WINDOW_MS) {
    return { code: 'REFUND_PENDING', message: 'O reembolso desta venda já foi solicitado e está sendo processado.' };
  }
  if (tx.metadata?.whop_dispute?.status || tx.metadata?.stripe_dispute?.status || tx.metadata?.paypal_dispute?.status) {
    return { code: 'DISPUTED', message: 'Esta venda está em disputa. Responda a disputa em Financeiro › Disputas.' };
  }

  const provider = String(tx.provider ?? '').toLowerCase();
  const method = String(tx.method ?? '').toLowerCase();
  if (provider === 'clip' && method === 'spei') {
    return { code: 'MANUAL_REFUND', message: 'Venda por transferência (SPEI) não tem reembolso automático: a devolução é feita por transferência. Fale com o suporte.' };
  }
  if (!['whop', 'stripe', 'slash', 'clip'].includes(provider)) {
    return { code: 'UNSUPPORTED_PROVIDER', message: 'Esta forma de pagamento não tem reembolso pelo painel. Faça o reembolso no painel do provedor ou fale com o suporte.' };
  }
  return null;
}

@Injectable()
export class SellerRefundService {
  constructor(
    private readonly accountRouter: AccountRouterService,
    private readonly webhooks: WebhookService,
  ) {}

  /** O que a tela mostra antes de confirmar: se pode, quanto sai do saldo e por quê não. */
  async preview(ctx: SellerCtx, transactionId: string) {
    const tx = await this.load(ctx, transactionId);
    const blocker = refundBlocker(tx);
    const debit = await this.debitFor(tx);
    const short = !blocker && debit.cents > 0 && debit.balanceCents < debit.cents;
    return {
      transactionId: tx.id,
      refundable: !blocker && !short,
      reason: blocker?.code ?? (short ? 'INSUFFICIENT_BALANCE' : null),
      message: blocker?.message ?? (short ? insufficientMessage(debit) : null),
      // Valor que volta ao comprador, na moeda da venda.
      amount: Number(tx.amount ?? 0) / 100,
      currency: String(tx.currency ?? 'USD').toUpperCase(),
      // Valor debitado do saldo do seller (USD): o bruto, taxa incluída.
      debitUsd: debit.cents / 100,
      feeUsd: Math.max(0, debit.cents - debit.creditedCents) / 100,
      ownAccount: debit.ownAccount,
    };
  }

  async request(ctx: SellerCtx, transactionId: string, body: { reason?: unknown }): Promise<RefundRequestResult> {
    const reason = String(body?.reason ?? '').replace(/\s+/g, ' ').trim();
    if (reason.length < 3) throw new BadRequestException({ error: 'REASON_REQUIRED', message: 'Informe o motivo do reembolso.' });
    if (reason.length > 300) throw new BadRequestException({ error: 'REASON_TOO_LONG', message: 'O motivo deve ter no máximo 300 caracteres.' });

    const tx = await this.load(ctx, transactionId);
    const blocker = refundBlocker(tx);
    if (blocker) throw new BadRequestException({ error: blocker.code, message: blocker.message });

    const debit = await this.debitFor(tx);
    if (debit.cents > 0 && debit.balanceCents < debit.cents) {
      throw new BadRequestException({ error: 'INSUFFICIENT_BALANCE', message: insufficientMessage(debit) });
    }

    // A marca vai ANTES da chamada (regra 3). `.eq('status','approved')` fecha a
    // corrida com um estorno que chegue por webhook neste instante.
    const mark = {
      refund_requested_by: `seller:${ctx.userId}`,
      refund_requested_at: new Date().toISOString(),
      refund_reason: reason,
    };
    const { data: marked, error: markError } = await supabase
      .from('transactions')
      .update({ metadata: { ...(tx.metadata ?? {}), ...mark } })
      .eq('id', tx.id).eq('seller_id', tx.seller_id).eq('status', 'approved')
      .select('id');
    if (markError) throw new BadRequestException({ error: 'REFUND_FAILED', message: 'Não foi possível iniciar o reembolso. Tente novamente.' });
    if (!marked?.length) throw new BadRequestException({ error: 'NOT_APPROVED', message: 'Esta venda não está mais aprovada.' });

    let outcome: { success: boolean; confirmed: boolean; message?: string };
    try {
      outcome = await this.callProvider(tx, reason);
    } catch (err: any) {
      outcome = { success: false, confirmed: false, message: err?.message ?? 'falha ao falar com o provedor' };
    }

    if (!outcome.success) {
      // O provedor não aceitou: a venda segue aprovada e sem a marca, para um
      // estorno futuro da própria Whop não ser lido como pedido nosso.
      await supabase.from('transactions')
        .update({ metadata: { ...(tx.metadata ?? {}), refund_last_error: String(outcome.message ?? '').slice(0, 300), refund_last_error_at: new Date().toISOString() } })
        .eq('id', tx.id).eq('status', 'approved');
      console.error(`[SellerRefund] ${tx.provider} recusou o reembolso da transação ${tx.id}: ${outcome.message}`);
      throw new BadRequestException({ error: 'PROVIDER_REFUSED', message: `O reembolso não foi aceito: ${outcome.message ?? 'erro no provedor'}` });
    }

    if (outcome.confirmed) {
      await this.webhooks.applyConfirmedRefund(tx.id);
      return { status: 'refunded', message: 'Reembolso feito. O valor volta ao comprador pelo mesmo meio de pagamento.' };
    }
    return { status: 'requested', message: 'Reembolso solicitado. A venda aparece como reembolsada assim que o provedor confirmar.' };
  }

  // ─── Provedor ─────────────────────────────────────────────────────────────

  private async callProvider(tx: any, reason: string): Promise<{ success: boolean; confirmed: boolean; message?: string }> {
    const provider = String(tx.provider ?? '').toLowerCase();

    if (provider === 'slash') {
      const account = getProviderAccountById(tx.provider_account_id ?? 'slash_main') ?? getProviderAccountById('slash_main');
      if (!account?.apiKey || !tx.provider_transaction_id) return { success: false, confirmed: false, message: 'pagamento da Slash indisponível' };
      const amountMinor = Number(tx.amount);
      const result = await new SlashProvider().refund({
        providerConfig: account as any,
        providerTransactionId: String(tx.provider_transaction_id),
        amountMinor,
        idempotencyKey: `koopfy_rf_${tx.id}_${amountMinor}`,
      });
      // A Slash confirma por webhook (payments.refund.updated).
      return { success: result.success, confirmed: false, message: result.message };
    }

    const account: any = tx.provider_account_id ? await this.accountRouter.resolveAccountById(String(tx.provider_account_id)) : null;
    if (!account?.apiKey) {
      return { success: false, confirmed: false, message: 'a conta que recebeu esta venda não está mais disponível' };
    }

    if (provider === 'whop') {
      const paymentId = String(tx.metadata?.whop_payment_id ?? tx.provider_transaction_id ?? '');
      if (!paymentId.startsWith('pay_')) return { success: false, confirmed: false, message: 'esta venda não tem o pagamento da Whop registrado' };
      const result = await new WhopProvider().refund(paymentId, account);
      return { success: result.success, confirmed: Boolean(result.refunded), message: result.message };
    }

    if (provider === 'stripe') {
      if (!tx.provider_transaction_id) return { success: false, confirmed: false, message: 'esta venda não tem o pagamento da Stripe registrado' };
      const result = await new StripeProvider().refund({
        providerConfig: account,
        providerTransactionId: String(tx.provider_transaction_id),
        transactionId: String(tx.id),
      });
      return { success: result.success, confirmed: String(result.status ?? '') === 'succeeded', message: result.message };
    }

    // Clip (cartão): sem webhook, o 200 é a confirmação.
    if (!tx.provider_transaction_id) return { success: false, confirmed: false, message: 'esta venda não tem o pagamento da Clip registrado' };
    const result = await new ClipProvider().refund({
      providerConfig: { id: account.id, apiKey: account.apiKey, config: account.config },
      providerTransactionId: String(tx.provider_transaction_id),
      amountMinor: Number(tx.amount),
      reason,
    });
    return { success: result.success, confirmed: result.success, message: result.message };
  }

  // ─── Apoio ────────────────────────────────────────────────────────────────

  private async load(ctx: SellerCtx, transactionId: string) {
    // Quem vende só pela conta própria (externalOnly) também reembolsa: o
    // dinheiro é dele e o estorno sai da conta dele.
    if (!ctx.seller || (ctx.seller.status !== 'active' && !ctx.externalOnly)) {
      throw new ConflictException('Conta financeira ainda não está ativa.');
    }
    const { data: tx, error } = await supabase
      .from('transactions').select('*')
      .eq('id', transactionId).eq('seller_id', ctx.seller.id).maybeSingle();
    if (error) throw new BadRequestException('Não foi possível ler a transação.');
    if (!tx) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Transação não encontrada.' });
    return tx;
  }

  /**
   * Quanto sai do saldo do seller neste estorno, e quanto saldo há para cobrir.
   * Conta própria do seller (Whop/Stripe dele): nada foi creditado aqui, então
   * nada é debitado e não há o que conferir.
   */
  private async debitFor(tx: any): Promise<{ cents: number; creditedCents: number; balanceCents: number; ownAccount: boolean }> {
    if (isOwnProviderAccountId(tx.provider_account_id)) return { cents: 0, creditedCents: 0, balanceCents: 0, ownAccount: true };

    const [{ data: credits }, { data: reserves }, { data: balance }] = await Promise.all([
      supabase.from('wallet_ledger').select('amount').eq('transaction_id', tx.id).eq('type', 'credit_pending'),
      supabase.from('wallet_ledger').select('amount').eq('transaction_id', tx.id).eq('type', 'reserve_hold').eq('status', 'hold'),
      supabase.from('wallet_balance').select('available_balance, pending_balance').eq('seller_id', tx.seller_id).maybeSingle(),
    ]);
    const creditedCents = (credits ?? []).reduce((sum, row: any) => sum + Math.max(0, Number(row.amount ?? 0)), 0);
    if (creditedCents <= 0) return { cents: 0, creditedCents: 0, balanceCents: 0, ownAccount: false };

    const reserveHeld = (reserves ?? []).reduce((sum, row: any) => sum + Number(row.amount ?? 0), 0);
    const gross = Number(tx.amount_usd_gross_cents);
    // Mesmo cálculo do estorno (refund-fee.ts): bruto menos a reserva ainda
    // presa, que fica com a Koopfy e já conta como devolvida.
    const cents = Number.isFinite(gross) && gross > 0
      ? Math.max(creditedCents, Math.round(gross - reserveHeld))
      : creditedCents + Number(tx.fee ?? 0) + Number(tx.external_fee_cents ?? 0);
    const balanceCents = Number(balance?.available_balance ?? 0) + Number(balance?.pending_balance ?? 0);
    return { cents, creditedCents, balanceCents, ownAccount: false };
  }
}

function usd(cents: number) {
  return `US$ ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function insufficientMessage(debit: { cents: number; balanceCents: number }) {
  return `Saldo insuficiente para este reembolso: ele debita ${usd(debit.cents)} e sua conta tem ${usd(Math.max(0, debit.balanceCents))} entre disponível e a liberar. Fale com o suporte para reembolsar esta venda.`;
}
