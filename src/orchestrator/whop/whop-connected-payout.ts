// ============================================================================
// SAQUE DE SELLER COM CONTA CONECTADA — regras puras
// ----------------------------------------------------------------------------
// O dinheiro das vendas fica na master. Depois que o CRM aprova o saque:
//   1. a master transfere o líquido para a conta conectada do seller;
//   2. a conta conectada saca para a conta bancária dele.
// A taxa de saque da Koopfy não sai da master: transfere-se só o líquido.
//
// O estado da execução vive em wallet_ledger.metadata.execution da linha
// debit_payout. Cada perna tem a própria chave de idempotência, derivada do id
// do saque — um retry (timeout, duas instâncias rodando o ciclo) devolve a
// MESMA transferência/saque na Whop em vez de criar outro.
// ============================================================================

export const PAYOUT_EXECUTION_MODE = 'whop_connected';

export type PayoutStage =
  | 'queued'           // aprovado, nada enviado
  | 'blocked'          // aprovado, esperando algo (conta bancária, saldo da master)
  | 'transferring'     // transferência master → conectada criada ou em criação
  | 'paying_out'       // dinheiro na conectada; saque para o banco em andamento
  | 'payout_failed'    // dinheiro na conectada, saque recusado — ação do CRM
  | 'transfer_failed'  // transferência recusada; saldo devolvido ao seller
  | 'completed';

export interface PayoutExecution {
  mode: typeof PAYOUT_EXECUTION_MODE;
  stage: PayoutStage;
  whop_account_id: string;
  payout_method_id?: string | null;
  transfer?: { id?: string | null; status?: string | null } | null;
  withdrawal?: { id?: string | null; status?: string | null; attempt: number } | null;
  attempt: number;
  last_error?: string | null;
  updated_at?: string;
}

/** Estágios em que o ciclo ainda tem trabalho a fazer. */
export const ACTIVE_PAYOUT_STAGES: PayoutStage[] = ['queued', 'blocked', 'transferring', 'paying_out'];

export function newPayoutExecution(whopAccountId: string): PayoutExecution {
  return { mode: PAYOUT_EXECUTION_MODE, stage: 'queued', whop_account_id: whopAccountId, attempt: 1 };
}

export function payoutTransferKey(payoutId: string): string {
  return `koopfy_payout_${payoutId}_transfer`;
}

// O saque tem tentativa: depois de um saque recusado (conta bancária errada), o
// CRM manda de novo — e esse precisa ser um saque NOVO na Whop.
export function payoutWithdrawalKey(payoutId: string, attempt: number): string {
  return `koopfy_payout_${payoutId}_withdraw_${attempt}`;
}

/** Líquido do saque: o que sai da master e chega ao banco do seller. */
export function payoutNetCents(entry: { amount: number | string; fee?: number | string | null; metadata?: any }): number {
  const fromMetadata = Number(entry.metadata?.net_cents);
  if (Number.isFinite(fromMetadata) && fromMetadata > 0) return Math.floor(fromMetadata);
  const amount = Math.floor(Number(entry.amount) || 0);
  const fee = Math.floor(Number(entry.fee) || 0);
  return Math.max(amount - fee, 0);
}

export function classifyWhopWithdrawal(withdrawal: any): 'succeeded' | 'failed' | 'processing' {
  const status = String(withdrawal?.status ?? '').toLowerCase();
  if (status === 'completed') return 'succeeded';
  if (status === 'failed' || status === 'canceled' || status === 'denied') return 'failed';
  return 'processing';
}

// Plano de propósito: o tsconfig não tem strictNullChecks, e sem ele uma união
// discriminada não estreita em `if (!choice.ok)`.
export interface PayoutMethodChoice {
  ok: boolean;
  id?: string;
  reason?: string;
}

/**
 * Conta bancária do saque. A escolhida pelo seller vale se ainda existir; sem
 * escolha, a padrão da Whop; sem padrão, a única cadastrada. Com várias e
 * nenhuma padrão, não chuta — dinheiro no banco errado não volta.
 */
export function pickPayoutMethod(methods: any[] | null | undefined, preferredId?: string | null): PayoutMethodChoice {
  const list = (Array.isArray(methods) ? methods : []).filter(m => typeof m?.id === 'string' && m.id);
  const preferred = String(preferredId ?? '').trim();

  if (preferred) {
    if (list.some(m => m.id === preferred)) return { ok: true, id: preferred };
    return { ok: false, reason: 'a conta bancária escolhida não está mais cadastrada na conta conectada' };
  }
  if (list.length === 0) {
    return { ok: false, reason: 'o seller ainda não cadastrou conta bancária na conta conectada' };
  }
  const defaults = list.filter(m => m.is_default === true);
  if (defaults.length === 1) return { ok: true, id: defaults[0].id };
  if (list.length === 1) return { ok: true, id: list[0].id };
  return { ok: false, reason: 'o seller tem mais de uma conta bancária e nenhuma padrão — escolha no CRM' };
}

/** Saldo disponível (centavos) de uma moeda em `balances[]` do Retrieve Account. */
export function availableCents(balances: any[] | null | undefined, currency: string): number {
  const match = (Array.isArray(balances) ? balances : [])
    .find(b => String(b?.symbol ?? '').toLowerCase() === currency.toLowerCase());
  const value = Number(match?.breakdown?.available ?? match?.balance ?? 0);
  return Number.isFinite(value) ? Math.floor(Math.round(value * 100)) : 0;
}

export function isWhopConnectedPayout(metadata: any): boolean {
  return metadata?.execution?.mode === PAYOUT_EXECUTION_MODE;
}
