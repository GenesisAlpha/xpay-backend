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
  payout?: { id?: string | null; status?: string | null; attempt: number } | null;
  attempt: number;
  last_error?: string | null;
  updated_at?: string;
  // A conta conectada exige cotação antes do saque (payout_quote_required).
  quote_required?: boolean;
  quote?: { token: string; expires_at: string | null } | null;
  // A cotação atual já foi mandada num POST /payouts.
  quote_sent?: boolean;
  // Rodada de cotação: cada cotação nova vai com uma chave de saque nova.
  quote_round?: number;
  // O banco devolveu um saque já dado como pago.
  reversed_at?: string | null;
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
export function payoutWithdrawalKey(payoutId: string, attempt: number, quoteRound = 0): string {
  const base = `koopfy_payout_${payoutId}_withdraw_${attempt}`;
  // Com cotação, o corpo do saque muda (quote_token): mesma chave com corpo
  // diferente a Whop recusaria. Cada cotação ganha a sua.
  return quoteRound > 0 ? `${base}_q${quoteRound}` : base;
}

/** Líquido do saque: o que sai da master e chega ao banco do seller. */
export function payoutNetCents(entry: { amount: number | string; fee?: number | string | null; metadata?: any }): number {
  const fromMetadata = Number(entry.metadata?.net_cents);
  if (Number.isFinite(fromMetadata) && fromMetadata > 0) return Math.floor(fromMetadata);
  const amount = Math.floor(Number(entry.amount) || 0);
  const fee = Math.floor(Number(entry.fee) || 0);
  return Math.max(amount - fee, 0);
}

/**
 * Status do payout (API versionada): requested, in_review, processing,
 * completed, reversed, canceled, failed, denied. `reversed` é um pagamento que
 * voltou depois de liquidado — o dinheiro está de novo na conta conectada.
 */
export function classifyWhopPayout(payout: any): 'succeeded' | 'failed' | 'processing' {
  const status = String(payout?.status ?? '').toLowerCase();
  if (status === 'completed') return 'succeeded';
  if (['failed', 'canceled', 'denied', 'reversed'].includes(status)) return 'failed';
  return 'processing';
}

/** Motivo legível de um payout que não pagou. */
export function whopPayoutFailureReason(payout: any): string {
  const failure = payout?.failure ?? {};
  return String(failure.message ?? failure.code ?? `saque ${payout?.status ?? 'recusado'}`);
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
  // `broken`: a Whop já viu pagamentos falharem nessa conta de forma permanente.
  const list = (Array.isArray(methods) ? methods : [])
    .filter(m => typeof m?.id === 'string' && m.id && m.status !== 'broken');
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

// ─── Conta bancária informada pelo seller no saque ──────────────────────────

/** O que a tela mostra de uma conta salva. Nunca o número inteiro. */
export function toSavedDestination(method: any) {
  return {
    id: String(method?.id ?? ''),
    name: method?.nickname ?? method?.supported_payout_method?.name ?? method?.payer_name ?? null,
    method: method?.supported_payout_method?.name ?? null,
    institution: method?.institution_name ?? null,
    reference: method?.account_reference ?? null,
    currency: method?.destination_currency ?? method?.currency ?? null,
    country: method?.supported_payout_method?.country_code ?? method?.destination?.country_code ?? null,
    isDefault: method?.is_default === true,
    status: method?.status ?? null,
    iconUrl: method?.supported_payout_method?.icon_url ?? null,
  };
}

export function toSupportedMethod(method: any) {
  return {
    id: String(method?.id ?? ''),
    name: method?.name ?? null,
    deliveryType: method?.delivery_type ?? null,
    iconUrl: method?.icon_url ?? null,
    fields: Array.isArray(method?.required_fields) ? method.required_fields.map(toRequiredField) : null,
  };
}

export function toRequiredField(field: any) {
  return {
    id: String(field?.id ?? ''),
    label: field?.label ?? field?.id ?? '',
    type: field?.type ?? null,
    inputType: field?.input_type === 'options' || field?.input_type === 'date' ? field.input_type : 'text',
    required: field?.required !== false,
    options: Array.isArray(field?.options) ? field.options.map(String) : null,
    placeholder: field?.placeholder ?? null,
    validation: typeof field?.validation === 'string' ? field.validation : null,
    sensitive: field?.sensitive === true,
  };
}

/**
 * Confere os valores digitados contra o schema da Whop antes de mandar — o
 * seller vê o erro no campo, e só os campos do schema seguem adiante.
 */
export function checkPayoutFields(
  schema: Array<ReturnType<typeof toRequiredField>>,
  values: Record<string, unknown> | null | undefined,
): { ok: boolean; fields: Record<string, string>; errors: Record<string, string> } {
  const fields: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const input = values && typeof values === 'object' ? values : {};

  for (const field of schema) {
    const raw = input[field.id];
    const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
    if (!value) {
      if (field.required) errors[field.id] = `Informe ${field.label}.`;
      continue;
    }
    if (field.options && field.options.length && !field.options.includes(value)) {
      errors[field.id] = `${field.label}: opção inválida.`;
      continue;
    }
    if (field.validation) {
      let pattern: RegExp | null = null;
      try { pattern = new RegExp(field.validation); } catch { pattern = null; }
      if (pattern && !pattern.test(value)) {
        errors[field.id] = `${field.label} em formato inválido.`;
        continue;
      }
    }
    fields[field.id] = value;
  }
  return { ok: Object.keys(errors).length === 0, fields, errors };
}

// ─── Cotação ────────────────────────────────────────────────────────────────

/** A Whop recusou o saque porque a conta exige cotação. */
export function isQuoteRequiredError(err: any): boolean {
  const text = [err?.type, err?.code, err?.message].filter(Boolean).join(' ');
  return /invalid_payout_quote|quote_token|payout_quote_required/i.test(text);
}

/**
 * Cotação ainda utilizável: com folga de 60s para o POST chegar antes de
 * expirar. Sem data de expiração, não arrisca.
 */
export function quoteUsable(quote: PayoutExecution['quote'], now = Date.now()): boolean {
  if (!quote?.token || !quote.expires_at) return false;
  const expires = Date.parse(quote.expires_at);
  return Number.isFinite(expires) && expires - now > 60_000;
}

// ─── Eventos de payout (webhook) ────────────────────────────────────────────

/** Saque da Koopfy a que um evento de payout se refere. */
export function payoutIdFromEvent(data: any): string | null {
  const id = data?.metadata?.koopfy_payout_id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** O evento é do payout que este saque criou? (`cofr_` ou `wdrl_`). */
export function eventMatchesExecution(data: any, exec: PayoutExecution): boolean {
  const known = exec.payout?.id;
  if (!known) return false;
  return [data?.id, data?.payout_request_id].filter(Boolean).includes(known);
}
