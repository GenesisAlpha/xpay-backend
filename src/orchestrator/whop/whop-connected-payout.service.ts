import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';
import { notifySellerPayout } from '../../utils/seller-mail';
import { WhopConnectService } from './whop-connect.service';
import { classifyWhopTransfer, isDefinitiveWhopFailure } from './whop-connected';
import {
  ACTIVE_PAYOUT_STAGES,
  PAYOUT_EXECUTION_MODE,
  PayoutExecution,
  classifyWhopPayout,
  eventMatchesExecution,
  isQuoteRequiredError,
  isWhopConnectedPayout,
  newPayoutExecution,
  payoutNetCents,
  payoutTransferKey,
  payoutWithdrawalKey,
  payoutIdFromEvent,
  pickPayoutMethod,
  quoteUsable,
  toSavedDestination,
  whopPayoutFailureReason,
} from './whop-connected-payout';
import { WhopApiError, WhopPlatformClient } from './whop-platform.client';

// ============================================================================
// Execução do saque aprovado para seller com conta conectada.
//
// Aprovar no CRM só enfileira (queue). O ciclo executa, perna por perna:
//
//   queued/blocked ─ checagens ─> transferring ─> paying_out ─> completed
//        │                            │               │
//        └ (espera)            transfer_failed   payout_failed
//                              (saldo devolvido) (dinheiro na conectada)
//
// Saldo: segue o Modelo A do CRM — a aprovação já tirou o valor de
// `withdrawing`. Se a transferência é recusada, nada saiu da master e o valor
// volta ao disponível. Depois que a transferência entra, o dinheiro é do seller
// na conta dele: um saque recusado NÃO devolve saldo na Koopfy (seria pagar
// duas vezes) — fica em payout_failed até o CRM mandar de novo.
//
// Concorrência: a passagem de 'approved' para 'processing' é um CAS e é feita
// antes de qualquer dinheiro sair; daí em diante, as chaves de idempotência
// fazem duas instâncias chegarem na mesma transferência e no mesmo saque.
// ============================================================================

const LEDGER_TYPE = 'debit_payout';
const CYCLE_INTERVAL_MS = 5 * 60 * 1000;
const CYCLE_BATCH = 50;
// Estorno depois de pago chega por webhook (payout.reversed). A varredura é a
// rede de segurança para evento perdido ou webhook sem a assinatura do evento.
const REVERSAL_SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;
const REVERSAL_WINDOW_DAYS = 30;
const REVERSAL_BATCH = 200;

interface PayoutEntry {
  id: string;
  seller_id: string;
  amount: number;
  fee: number | null;
  currency: string | null;
  status: string;
  metadata: Record<string, any> | null;
  created_at?: string | null;
}

@Injectable()
export class WhopConnectedPayoutService implements OnModuleInit {
  private cycleRunning = false;
  private lastReversalSweep = 0;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly whop: WhopPlatformClient,
    private readonly connect: WhopConnectService,
  ) { }

  // Desligado por padrão, como a liberação automática: é dinheiro saindo da
  // master, e o primeiro saque precisa ser acompanhado.
  static enabled(): boolean {
    return process.env.WHOP_CONNECTED_PAYOUTS === 'true';
  }

  onModuleInit() {
    if (!WhopConnectedPayoutService.enabled()) return;
    setInterval(() => void this.runCycle(), CYCLE_INTERVAL_MS);
  }

  /**
   * Conta conectada que pode receber o saque, ou null (seller na master: o
   * saque segue manual, como sempre foi — a Whop não paga quem não tem conta).
   */
  async eligibleAccount(sellerId: string): Promise<string | null> {
    if (!WhopConnectedPayoutService.enabled()) return null;
    const row = await this.connect.getRow(sellerId);
    if (!row?.whop_account_id || row.status !== 'active') return null;
    return row.whop_account_id;
  }

  /** Chamado pelo CRM logo depois de aprovar. Não move dinheiro. */
  async queue(payoutId: string, whopAccountId: string) {
    const entry = await this.load(payoutId);
    if (isWhopConnectedPayout(entry.metadata)) return;
    await this.saveExecution(entry, newPayoutExecution(whopAccountId));
    void this.advance(payoutId).catch(err =>
      console.error(`[WhopPayout] saque ${payoutId}:`, err?.message ?? err));
  }

  async runCycle() {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    try {
      const { data, error } = await supabase
        .from('wallet_ledger')
        .select('id')
        .eq('type', LEDGER_TYPE)
        .in('status', ['approved', 'processing'])
        .filter('metadata->execution->>mode', 'eq', PAYOUT_EXECUTION_MODE)
        .in('metadata->execution->>stage', ACTIVE_PAYOUT_STAGES)
        .order('created_at', { ascending: true })
        .limit(CYCLE_BATCH);
      if (error) {
        console.error('[WhopPayout] ciclo:', error.message);
        return;
      }
      for (const row of data ?? []) {
        await this.advance(row.id).catch(err =>
          console.error(`[WhopPayout] saque ${row.id}:`, err?.message ?? err));
      }

      if (Date.now() - this.lastReversalSweep >= REVERSAL_SWEEP_EVERY_MS) {
        this.lastReversalSweep = Date.now();
        await this.checkReversals().catch(err =>
          console.error('[WhopPayout] varredura de estornos:', err?.message ?? err));
      }
    } finally {
      this.cycleRunning = false;
    }
  }

  /**
   * Ação do CRM sobre um saque parado:
   *  • payout_failed — o banco recusou e o dinheiro está na conta conectada:
   *    manda de novo, opcionalmente para outra conta bancária;
   *  • blocked — ainda nada saiu (ex.: várias contas bancárias e nenhuma
   *    padrão): grava a conta escolhida e tenta já.
   */
  async retryWithdrawal(payoutId: string, payoutMethodId?: string | null) {
    const entry = await this.load(payoutId);
    const exec = this.execution(entry);
    if (exec.stage !== 'payout_failed' && exec.stage !== 'blocked') {
      throw new BadRequestException(`Só um saque recusado pelo banco ou bloqueado pode ser reenviado (etapa atual: ${exec.stage}).`);
    }
    const chosen = payoutMethodId?.trim() || null;
    if (chosen) {
      const methods = await this.whop.listSavedPayoutMethods(exec.whop_account_id);
      const choice = pickPayoutMethod(methods?.data ?? methods, chosen);
      if (!choice.ok) throw new BadRequestException(choice.reason);
    }

    if (exec.stage === 'blocked') {
      await this.saveExecution(entry, { ...exec, payout_method_id: chosen || exec.payout_method_id || null });
      await this.advance(payoutId);
      return this.describe(await this.load(payoutId));
    }

    await this.saveExecution(entry, {
      ...exec,
      stage: 'paying_out',
      attempt: exec.attempt + 1,
      payout: null,
      payout_method_id: chosen || exec.payout_method_id || null,
      last_error: null,
    });
    await this.advance(payoutId);
    return this.describe(await this.load(payoutId));
  }

  /** Contas salvas na conta conectada do saque (a escolhida vem marcada). */
  async savedMethods(payoutId: string) {
    const entry = await this.load(payoutId);
    const exec = this.execution(entry);
    const response = await this.whop.listSavedPayoutMethods(exec.whop_account_id);
    const items: any[] = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
    return items.map(method => ({
      ...toSavedDestination(method),
      selected: method?.id === (exec.payout_method_id ?? entry.metadata?.destination?.whopPayoutMethodId),
    }));
  }

  /** Estado legível para o CRM. */
  describe(entry: PayoutEntry) {
    const exec = entry.metadata?.execution as PayoutExecution | undefined;
    if (!exec || exec.mode !== PAYOUT_EXECUTION_MODE) return null;
    return {
      stage: exec.stage,
      whopAccountId: exec.whop_account_id,
      payoutMethodId: exec.payout_method_id ?? null,
      transferId: exec.transfer?.id ?? null,
      transferStatus: exec.transfer?.status ?? null,
      payoutId: exec.payout?.id ?? null,
      payoutStatus: exec.payout?.status ?? null,
      attempt: exec.attempt,
      lastError: exec.last_error ?? null,
    };
  }

  // ─────────────────────────────────────────────
  // Máquina de estados
  // ─────────────────────────────────────────────

  async advance(payoutId: string) {
    // Mesmo processo: o disparo da aprovação e o ciclo não correm juntos.
    if (this.inFlight.has(payoutId)) return;
    this.inFlight.add(payoutId);
    try {
      let entry = await this.load(payoutId);
      if (!isWhopConnectedPayout(entry.metadata)) return;

      const stage = this.execution(entry).stage;
      if (stage === 'queued' || stage === 'blocked') {
        entry = await this.startTransfer(entry);
      } else if (stage === 'transferring') {
        entry = await this.settleTransfer(entry);
      }
      if (this.execution(entry).stage === 'paying_out') {
        await this.settlePayout(entry);
      }
    } finally {
      this.inFlight.delete(payoutId);
    }
  }

  private async startTransfer(entry: PayoutEntry): Promise<PayoutEntry> {
    const exec = this.execution(entry);
    const net = payoutNetCents(entry);
    if (net <= 0) return this.block(entry, 'valor líquido do saque é zero');

    // Checagens ANTES de o dinheiro sair: sem conta bancária, a transferência
    // deixaria o valor parado na conta conectada.
    const row = await this.connect.getRow(entry.seller_id);
    if (!row?.whop_account_id || row.status !== 'active') {
      return this.block(entry, `conta conectada ${row?.status ?? 'inexistente'}`);
    }
    if (row.whop_account_id !== exec.whop_account_id) {
      return this.block(entry, 'a conta conectada do seller mudou depois da aprovação');
    }

    let methods: any;
    try {
      methods = await this.whop.listSavedPayoutMethods(exec.whop_account_id);
    } catch (err) {
      return this.block(entry, `contas bancárias indisponíveis: ${this.message(err)}`);
    }
    const preferred = exec.payout_method_id ?? entry.metadata?.destination?.whopPayoutMethodId ?? null;
    const choice = pickPayoutMethod(methods?.data ?? methods, preferred);
    if (!choice.ok) return this.block(entry, choice.reason);

    const masterId = await this.connect.masterAccountId();
    const masterUsd = await this.connect.accountAvailableCents(masterId, 'usd');
    if (masterUsd < net) {
      return this.block(entry, `saldo em USD da master insuficiente (US$ ${(masterUsd / 100).toFixed(2)} para US$ ${(net / 100).toFixed(2)})`);
    }

    // CAS approved → processing: a partir daqui o saque é do ciclo, e o CRM não
    // consegue mais marcá-lo como falho (o dinheiro pode estar saindo).
    const claimed = await this.update(entry, {
      status: 'processing',
      execution: { ...exec, stage: 'transferring', payout_method_id: choice.id, last_error: null },
    }, 'approved');
    if (!claimed) return this.load(entry.id);

    return this.settleTransfer(claimed, masterId);
  }

  private async settleTransfer(entry: PayoutEntry, masterIdHint?: string): Promise<PayoutEntry> {
    const exec = this.execution(entry);
    const net = payoutNetCents(entry);

    let transfer: any;
    try {
      transfer = exec.transfer?.id
        ? await this.whop.getTransfer(exec.transfer.id)
        : await this.whop.createTransfer({
          origin_id: masterIdHint ?? await this.connect.masterAccountId(),
          destination_id: exec.whop_account_id,
          amount: net / 100,
          currency: 'usd',
          notes: 'Saque Koopfy',
          metadata: { koopfy_seller_id: entry.seller_id, koopfy_payout_id: entry.id },
        }, payoutTransferKey(entry.id));
    } catch (err) {
      // Só criação recusada de forma definitiva devolve o saldo. Timeout,
      // 409, 429 e 5xx podem ter criado a transferência: fica em aberto e o
      // próximo ciclo repete com a mesma chave.
      if (!exec.transfer?.id && err instanceof WhopApiError && isDefinitiveWhopFailure(err.status)) {
        return this.failTransfer(entry, this.message(err));
      }
      return this.note(entry, `transferência em aberto: ${this.message(err)}`);
    }

    const outcome = classifyWhopTransfer(transfer);
    if (outcome === 'failed') {
      return this.failTransfer(entry, String(transfer?.failure_reason ?? 'transferência recusada pela Whop'));
    }

    const next: PayoutExecution = {
      ...exec,
      transfer: { id: transfer?.id ?? exec.transfer?.id ?? null, status: transfer?.status ?? null },
      stage: outcome === 'succeeded' ? 'paying_out' : 'transferring',
      last_error: null,
    };
    return (await this.update(entry, { execution: next })) ?? entry;
  }

  private async settlePayout(entry: PayoutEntry, quoteRetried = false): Promise<PayoutEntry> {
    let exec = this.execution(entry);
    const net = payoutNetCents(entry);
    const current = exec.payout?.attempt === exec.attempt ? exec.payout : null;

    let payout: any;
    try {
      if (current?.id) {
        payout = await this.whop.getPayout(current.id);
      } else {
        // A transferência pode levar um instante para aparecer no saldo.
        const connectedUsd = await this.connect.accountAvailableCents(exec.whop_account_id, 'usd');
        if (connectedUsd < net) {
          return this.note(entry, `aguardando saldo na conta conectada (US$ ${(connectedUsd / 100).toFixed(2)} de US$ ${(net / 100).toFixed(2)})`);
        }
        ({ entry, exec } = await this.ensureQuote(entry, exec, net));
        const round = exec.quote_required ? exec.quote_round ?? 1 : 0;
        if (exec.quote_required && !exec.quote_sent) {
          // Gravado ANTES de enviar: se o POST cair no meio, o próximo ciclo
          // sabe que esta cotação já foi usada e repete o mesmo corpo.
          exec = { ...exec, quote_sent: true };
          entry = (await this.update(entry, { execution: exec })) ?? entry;
        }
        payout = await this.whop.createPayout({
          account_id: exec.whop_account_id,
          payout_method_id: exec.payout_method_id,
          amount: net / 100,
          currency: 'usd',
          // Explícito: omitido, a Whop aplica a política da plataforma. A taxa
          // de entrega é do seller.
          platform_covers_fees: false,
          notes: 'Saque Koopfy',
          metadata: { koopfy_payout_id: entry.id, koopfy_seller_id: entry.seller_id },
          ...(exec.quote_required && exec.quote?.token ? { quote_token: exec.quote.token } : {}),
        }, payoutWithdrawalKey(entry.id, exec.attempt, round));
      }
    } catch (err) {
      if (!current?.id && err instanceof WhopApiError && isQuoteRequiredError(err)) {
        // A conta exige cotação (ou a cotação expirou): rodada nova, com chave
        // nova. Tenta de novo já; se falhar outra vez, o ciclo repete.
        const next: PayoutExecution = {
          ...exec,
          quote_required: true,
          quote: null,
          quote_sent: false,
          quote_round: (exec.quote_round ?? 0) + 1,
          last_error: 'a conta exige cotação — cotando o saque',
        };
        const saved = (await this.update(entry, { execution: next })) ?? entry;
        return quoteRetried ? saved : this.settlePayout(saved, true);
      }
      if (!current?.id && err instanceof WhopApiError && isDefinitiveWhopFailure(err.status)) {
        return this.failPayout(entry, this.message(err), null);
      }
      return this.note(entry, `saque em aberto: ${this.message(err)}`);
    }

    const outcome = classifyWhopPayout(payout);
    const payoutState = { id: payout?.id ?? current?.id ?? null, status: payout?.status ?? null, attempt: exec.attempt };

    if (outcome === 'failed') {
      return this.failPayout(entry, whopPayoutFailureReason(payout), payoutState);
    }

    if (outcome === 'succeeded') {
      const done = await this.update(entry, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        provider_payout_id: payoutState.id,
        execution: { ...exec, stage: 'completed', payout: payoutState, last_error: null },
      }, 'processing');
      if (done) {
        void notifySellerPayout(entry.seller_id, 'completed', {
          ...this.emailInfo(entry),
          providerPayoutId: payoutState.id,
        });
      }
      return done ?? entry;
    }

    return (await this.update(entry, {
      execution: { ...exec, payout: payoutState, last_error: null },
    })) ?? entry;
  }

  /**
   * Cotação do saque, quando a conta exige. Reaproveita a cotação já enviada
   * (o POST pode ter criado o saque e só a resposta se perdeu); cota de novo
   * quando a atual expirou antes de ser usada.
   */
  private async ensureQuote(entry: PayoutEntry, exec: PayoutExecution, net: number) {
    if (!exec.quote_required) return { entry, exec };
    if (exec.quote?.token && (exec.quote_sent || quoteUsable(exec.quote))) return { entry, exec };

    const round = exec.quote_round ?? 1;
    const quote = await this.whop.createPayoutQuote({
      account_id: exec.whop_account_id,
      payout_method_id: exec.payout_method_id,
      amount: net / 100,
      currency: 'usd',
      platform_covers_fees: false,
    }, `${payoutWithdrawalKey(entry.id, exec.attempt, round)}_quote_${Date.now()}`);
    if (!quote?.quote_token) throw new Error('A Whop não devolveu a cotação do saque.');

    const next: PayoutExecution = {
      ...exec,
      quote_round: round,
      quote: { token: String(quote.quote_token), expires_at: quote.expires_at ?? null },
      quote_sent: false,
    };
    const saved = (await this.update(entry, { execution: next })) ?? entry;
    return { entry: saved, exec: next };
  }

  // ─────────────────────────────────────────────
  // Estorno depois de pago
  // ─────────────────────────────────────────────

  /**
   * Evento de payout da Whop (webhook). Adianta o saque em andamento e trata o
   * estorno de um saque já concluído.
   */
  async handlePayoutEvent(eventType: string, data: any, whopAccountId: string) {
    const payoutId = payoutIdFromEvent(data);
    if (!payoutId) return { ignored: true, reason: 'payout sem koopfy_payout_id' };

    let entry: PayoutEntry;
    try {
      entry = await this.load(payoutId);
    } catch {
      return { ignored: true, reason: 'saque não encontrado' };
    }
    if (!isWhopConnectedPayout(entry.metadata)) return { ignored: true, reason: 'saque manual' };

    const exec = this.execution(entry);
    if (exec.whop_account_id !== whopAccountId) {
      console.error(`[WhopPayout] 🚨 evento ${eventType} da conta ${whopAccountId} aponta para o saque ${payoutId}, que é da conta ${exec.whop_account_id} — ignorado`);
      return { ignored: true, reason: 'ownership mismatch' };
    }
    if (!eventMatchesExecution(data, exec)) return { ignored: true, reason: 'payout de outra tentativa' };

    if (entry.status === 'completed') {
      if (classifyWhopPayout(data) === 'failed') {
        await this.markReversed(entry, whopPayoutFailureReason(data));
        return { reversed: true };
      }
      return { received: true };
    }

    await this.advance(payoutId);
    return { received: true };
  }

  /** Confere os saques pagos nos últimos dias atrás de estorno perdido. */
  async checkReversals() {
    const since = new Date(Date.now() - REVERSAL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('wallet_ledger')
      .select('id, seller_id, amount, fee, currency, status, metadata, created_at')
      .eq('type', LEDGER_TYPE)
      .eq('status', 'completed')
      .filter('metadata->execution->>mode', 'eq', PAYOUT_EXECUTION_MODE)
      .gte('completed_at', since)
      .limit(REVERSAL_BATCH);
    if (error) throw new Error(error.message);

    let reversed = 0;
    for (const entry of (data ?? []) as PayoutEntry[]) {
      const payoutRef = entry.metadata?.execution?.payout?.id;
      if (!payoutRef) continue;
      try {
        const payout = await this.whop.getPayout(payoutRef);
        if (classifyWhopPayout(payout) === 'failed') {
          await this.markReversed(entry, whopPayoutFailureReason(payout));
          reversed += 1;
        }
      } catch (err) {
        console.error(`[WhopPayout] estorno do saque ${entry.id}:`, this.message(err));
      }
    }
    return { checked: data?.length ?? 0, reversed };
  }

  // O dinheiro voltou para a conta conectada. O saldo na Koopfy NÃO volta:
  // ele é do seller, na conta dele. O saque reabre em payout_failed para o
  // CRM reenviar.
  private async markReversed(entry: PayoutEntry, reason: string) {
    const exec = this.execution(entry);
    const message = `o banco devolveu o saque depois de pago: ${reason}`.slice(0, 500);
    const reopened = await this.update(entry, {
      status: 'processing',
      completed_at: null,
      execution: { ...exec, stage: 'payout_failed', reversed_at: new Date().toISOString(), last_error: message },
    }, 'completed');
    if (!reopened) return;

    console.error(`[WhopPayout] 🚨 saque ${entry.id}: ${message}. Dinheiro na conta conectada ${exec.whop_account_id}; reenviar pelo CRM.`);
    await this.log(entry.seller_id, 'whop_payout.reversed', { payout_id: entry.id, reason, payout_ref: exec.payout?.id ?? null });
    void notifySellerPayout(entry.seller_id, 'failed', {
      ...this.emailInfo(entry),
      reason: 'O banco devolveu o saque. O valor voltou para a sua conta Whop e será reenviado.',
    });
  }

  // ─────────────────────────────────────────────
  // Desfechos
  // ─────────────────────────────────────────────

  private async failTransfer(entry: PayoutEntry, reason: string): Promise<PayoutEntry> {
    const exec = this.execution(entry);
    const amount = Math.floor(Number(entry.amount));
    // Nada saiu da master: o valor inteiro (líquido + taxa) volta ao seller.
    const { error: creditError } = await supabase.rpc('credit_balance', {
      p_seller_id: entry.seller_id,
      p_bucket: 'available',
      p_amount_cents: amount,
    });
    const updated = await this.update(entry, {
      status: 'failed',
      failure_reason: reason.slice(0, 500),
      execution: {
        ...exec,
        stage: 'transfer_failed',
        last_error: reason.slice(0, 500),
        ...(creditError ? { reconciliation: true, credit_error: creditError.message } : {}),
      },
    });
    console.error(
      `[WhopPayout] saque ${entry.id}: transferência recusada (${reason}) — `
      + (creditError ? `saldo NÃO devolvido (${creditError.message}), reconciliar à mão.` : 'saldo devolvido ao disponível.'),
    );
    if (!creditError) {
      void notifySellerPayout(entry.seller_id, 'failed', { ...this.emailInfo(entry), reason: 'Não foi possível enviar o saque. O valor voltou ao seu saldo disponível.' });
    }
    return updated ?? entry;
  }

  private async failPayout(entry: PayoutEntry, reason: string, payout: PayoutExecution['payout']): Promise<PayoutEntry> {
    const exec = this.execution(entry);
    console.error(`[WhopPayout] 🚨 saque ${entry.id}: dinheiro na conta conectada ${exec.whop_account_id}, saque recusado (${reason}). Reenviar pelo CRM.`);
    await this.log(entry.seller_id, 'whop_payout.withdrawal_failed', { payout_id: entry.id, reason, attempt: exec.attempt });
    return (await this.update(entry, {
      execution: { ...exec, stage: 'payout_failed', payout: payout ?? exec.payout ?? null, last_error: reason.slice(0, 500) },
    })) ?? entry;
  }

  private async block(entry: PayoutEntry, reason: string): Promise<PayoutEntry> {
    const exec = this.execution(entry);
    if (exec.stage !== 'blocked' || exec.last_error !== reason) {
      console.warn(`[WhopPayout] saque ${entry.id} aguardando: ${reason}`);
    }
    return (await this.update(entry, { execution: { ...exec, stage: 'blocked', last_error: reason } }, 'approved')) ?? entry;
  }

  private async note(entry: PayoutEntry, reason: string): Promise<PayoutEntry> {
    const exec = this.execution(entry);
    console.warn(`[WhopPayout] saque ${entry.id}: ${reason}`);
    return (await this.update(entry, { execution: { ...exec, last_error: reason } })) ?? entry;
  }

  // ─────────────────────────────────────────────
  // Persistência
  // ─────────────────────────────────────────────

  private execution(entry: PayoutEntry): PayoutExecution {
    const exec = entry.metadata?.execution;
    if (!exec || exec.mode !== PAYOUT_EXECUTION_MODE) {
      throw new Error(`saque ${entry.id} não é de conta conectada`);
    }
    return exec as PayoutExecution;
  }

  private async load(payoutId: string): Promise<PayoutEntry> {
    const { data, error } = await supabase
      .from('wallet_ledger')
      .select('id, seller_id, amount, fee, currency, status, metadata, created_at')
      .eq('id', payoutId)
      .eq('type', LEDGER_TYPE)
      .single();
    if (error || !data) throw new BadRequestException('Saque não encontrado');
    return data as PayoutEntry;
  }

  private saveExecution(entry: PayoutEntry, execution: PayoutExecution) {
    return this.update(entry, { execution });
  }

  /**
   * Grava colunas e a execução (mesclada ao metadata). Com `expectStatus`, só
   * grava se o status ainda for esse — e devolve null se outro chegou antes.
   */
  private async update(
    entry: PayoutEntry,
    patch: { execution: PayoutExecution & Record<string, any>; status?: string; [column: string]: any },
    expectStatus?: string,
  ): Promise<PayoutEntry | null> {
    const { execution, ...columns } = patch;
    const metadata = {
      ...(entry.metadata ?? {}),
      execution: { ...execution, updated_at: new Date().toISOString() },
    };
    let query = supabase
      .from('wallet_ledger')
      .update({ ...columns, metadata, updated_at: new Date().toISOString() })
      .eq('id', entry.id)
      .eq('type', LEDGER_TYPE);
    if (expectStatus) query = query.eq('status', expectStatus);

    const { data, error } = await query
      .select('id, seller_id, amount, fee, currency, status, metadata, created_at')
      .maybeSingle();
    if (error) throw new Error(`ledger do saque ${entry.id}: ${error.message}`);
    return (data as PayoutEntry | null) ?? null;
  }

  private emailInfo(entry: PayoutEntry) {
    return {
      amountCents: Number(entry.amount),
      currency: entry.currency,
      method: entry.metadata?.method ?? null,
      payoutId: entry.id,
      destination: entry.metadata?.destination ?? null,
      feeCents: Number(entry.fee) || null,
      requestedAt: entry.created_at ?? null,
    };
  }

  private message(err: any): string {
    return String(err?.message ?? err).slice(0, 500);
  }

  private async log(sellerId: string, action: string, payload: Record<string, any>) {
    const { error } = await supabase.from('crm_action_log').insert({
      seller_id: sellerId,
      manager_id: null,
      action,
      resource_type: 'withdrawal',
      resource_id: payload.payout_id ?? sellerId,
      payload,
      created_at: new Date(),
    });
    if (error) console.error(`[WhopPayout] crm_action_log (${action}):`, error.message);
  }
}
