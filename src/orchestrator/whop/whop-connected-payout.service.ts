import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';
import { notifySellerPayout } from '../../utils/seller-mail';
import { WhopConnectService } from './whop-connect.service';
import { classifyWhopTransfer, isDefinitiveWhopFailure } from './whop-connected';
import {
  ACTIVE_PAYOUT_STAGES,
  PAYOUT_EXECUTION_MODE,
  PayoutExecution,
  classifyWhopWithdrawal,
  isWhopConnectedPayout,
  newPayoutExecution,
  payoutNetCents,
  payoutTransferKey,
  payoutWithdrawalKey,
  pickPayoutMethod,
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

  private static platformCoversFees(): boolean {
    return process.env.WHOP_PAYOUT_PLATFORM_COVERS_FEES === 'true';
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
      const methods = await this.whop.listPayoutMethods(exec.whop_account_id);
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
      withdrawal: null,
      payout_method_id: chosen || exec.payout_method_id || null,
      last_error: null,
    });
    await this.advance(payoutId);
    return this.describe(await this.load(payoutId));
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
      withdrawalId: exec.withdrawal?.id ?? null,
      withdrawalStatus: exec.withdrawal?.status ?? null,
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
        await this.settleWithdrawal(entry);
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
      methods = await this.whop.listPayoutMethods(exec.whop_account_id);
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

  private async settleWithdrawal(entry: PayoutEntry): Promise<PayoutEntry> {
    const exec = this.execution(entry);
    const net = payoutNetCents(entry);
    const current = exec.withdrawal?.attempt === exec.attempt ? exec.withdrawal : null;

    let withdrawal: any;
    try {
      if (current?.id) {
        withdrawal = await this.whop.getWithdrawal(current.id);
      } else {
        // A transferência pode levar um instante para aparecer no saldo.
        const connectedUsd = await this.connect.accountAvailableCents(exec.whop_account_id, 'usd');
        if (connectedUsd < net) {
          return this.note(entry, `aguardando saldo na conta conectada (US$ ${(connectedUsd / 100).toFixed(2)} de US$ ${(net / 100).toFixed(2)})`);
        }
        withdrawal = await this.whop.createWithdrawal({
          company_id: exec.whop_account_id,
          payout_method_id: exec.payout_method_id,
          amount: net / 100,
          currency: 'usd',
          platform_covers_fees: WhopConnectedPayoutService.platformCoversFees(),
        }, payoutWithdrawalKey(entry.id, exec.attempt));
      }
    } catch (err) {
      if (!current?.id && err instanceof WhopApiError && isDefinitiveWhopFailure(err.status)) {
        return this.failWithdrawal(entry, this.message(err), null);
      }
      return this.note(entry, `saque em aberto: ${this.message(err)}`);
    }

    const outcome = classifyWhopWithdrawal(withdrawal);
    const withdrawalState = { id: withdrawal?.id ?? current?.id ?? null, status: withdrawal?.status ?? null, attempt: exec.attempt };

    if (outcome === 'failed') {
      const reason = String(withdrawal?.error_message ?? withdrawal?.error_code ?? `saque ${withdrawal?.status ?? 'recusado'}`);
      return this.failWithdrawal(entry, reason, withdrawalState);
    }

    if (outcome === 'succeeded') {
      const done = await this.update(entry, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        provider_payout_id: withdrawalState.id,
        execution: { ...exec, stage: 'completed', withdrawal: withdrawalState, last_error: null },
      }, 'processing');
      if (done) {
        void notifySellerPayout(entry.seller_id, 'completed', {
          ...this.emailInfo(entry),
          providerPayoutId: withdrawalState.id,
        });
      }
      return done ?? entry;
    }

    return (await this.update(entry, {
      execution: { ...exec, withdrawal: withdrawalState, last_error: null },
    })) ?? entry;
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

  private async failWithdrawal(entry: PayoutEntry, reason: string, withdrawal: PayoutExecution['withdrawal']): Promise<PayoutEntry> {
    const exec = this.execution(entry);
    console.error(`[WhopPayout] 🚨 saque ${entry.id}: dinheiro na conta conectada ${exec.whop_account_id}, saque recusado (${reason}). Reenviar pelo CRM.`);
    await this.log(entry.seller_id, 'whop_payout.withdrawal_failed', { payout_id: entry.id, reason, attempt: exec.attempt });
    return (await this.update(entry, {
      execution: { ...exec, stage: 'payout_failed', withdrawal: withdrawal ?? exec.withdrawal ?? null, last_error: reason.slice(0, 500) },
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
