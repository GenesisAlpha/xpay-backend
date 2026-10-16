// ============================================================================
// Saque pela API v1 da Whop: POST /payouts (+ cotação) e GET /payouts/{id}.
//
// Substitui /withdrawals, que a Whop removeu: desde a versão 2026-08-25-1 a
// rota responde 410 "Use POST /payouts instead" (confirmado em 2026-10-16 com
// e sem o header Api-Version-Date). Serve a conta vinculada (chave do seller)
// e a conta própria do Financeiro — por isso recebe o fetch de quem chama.
//
// Cotação: conta com `payout_quote_required` recusa o payout sem o
// `quote_token` de POST /payouts/quotes (erro `invalid_payout_quote`). Pedimos
// a cotação sempre que der — nada se move nela — e seguimos sem quando a Whop
// não a oferece para a conta.
//
// Sem imports de serviço de propósito (ver whop-company.ts).
// ============================================================================

export type FetchLike = (url: string, init?: any) => Promise<any>;

/** Estados em que a Whop não muda mais o saque. `reversed` é novo na v1. */
export const WHOP_PAYOUT_FINAL_STATUS = new Set(['completed', 'failed', 'canceled', 'cancelled', 'denied', 'reversed']);

export interface WhopPayoutResult {
  id: string | null;
  status: string;
  feeCents: number;
  estimatedAt: string | null;
  raw: any;
}

export class WhopPayoutError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'WhopPayoutError';
  }
}

export async function requestWhopPayout(args: {
  apiKey: string;
  apiUrl: string;
  accountId: string;
  payoutMethodId: string;
  /** Em centavos; a Whop trabalha em decimal. */
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  fetchImpl?: FetchLike;
}): Promise<WhopPayoutResult> {
  const call = args.fetchImpl ?? ((url, init) => fetch(url, init) as any);
  const base = {
    account_id: args.accountId,
    payout_method_id: args.payoutMethodId,
    amount: args.amountCents / 100,
    currency: args.currency.toLowerCase(),
  };

  // A cotação é opcional para a Whop e obrigatória para algumas contas. Falhar
  // aqui não pode impedir o saque: tentamos o payout sem token.
  let quoteToken: string | null = null;
  try {
    const quote = await post(call, args, '/api/v1/payouts/quotes', base, `${args.idempotencyKey}_quote`);
    quoteToken = typeof quote?.quote_token === 'string' ? quote.quote_token : null;
  } catch (err: any) {
    console.warn('[WhopPayouts] cotação indisponível, seguindo sem:', err?.message);
  }

  const payout = await post(call, args, '/api/v1/payouts', {
    ...base,
    ...(quoteToken ? { quote_token: quoteToken } : {}),
    ...(args.metadata ? { metadata: args.metadata } : {}),
  }, args.idempotencyKey);

  return mapWhopPayout(payout);
}

export async function fetchWhopPayout(args: {
  apiKey: string;
  apiUrl: string;
  payoutId: string;
  fetchImpl?: FetchLike;
}): Promise<WhopPayoutResult> {
  const call = args.fetchImpl ?? ((url, init) => fetch(url, init) as any);
  const response = await call(`${args.apiUrl}/api/v1/payouts/${encodeURIComponent(args.payoutId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${args.apiKey}`, Accept: 'application/json' },
  });
  const json: any = await response.json().catch(() => ({}));
  if (!response.ok) throw toError(json, response.status, '/api/v1/payouts/{id}');
  return mapWhopPayout(json);
}

/** Resposta de POST/GET /payouts (e, por garantia, o formato antigo de /withdrawals). */
export function mapWhopPayout(json: any): WhopPayoutResult {
  const fee = toCents(json?.fee_amount ?? json?.fees?.fee_amount) + toCents(json?.markup_fee ?? json?.fees?.markup_fee);
  return {
    id: typeof json?.id === 'string' ? json.id : null,
    status: String(json?.status ?? 'requested').trim() || 'requested',
    feeCents: fee,
    estimatedAt: json?.estimated_arrival ?? json?.estimated_availability ?? null,
    raw: json,
  };
}

async function post(call: FetchLike, args: { apiKey: string; apiUrl: string }, path: string, body: Record<string, any>, idempotencyKey: string) {
  const response = await call(`${args.apiUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      // Retry de rede com a mesma chave devolve o MESMO saque em vez de criar outro.
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const json: any = await response.json().catch(() => ({}));
  if (!response.ok) throw toError(json, response.status, path);
  return json;
}

function toError(json: any, status: number, path: string): WhopPayoutError {
  return new WhopPayoutError(
    json?.error?.message ?? json?.message ?? `Whop HTTP ${status} em ${path}`,
    status,
    typeof json?.error?.code === 'string' ? json.error.code : null,
  );
}

function toCents(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
