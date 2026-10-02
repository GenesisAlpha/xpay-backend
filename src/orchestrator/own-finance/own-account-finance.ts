// ============================================================================
// FINANCEIRO DAS CONTAS PRÓPRIAS DO SELLER — regras puras
// ----------------------------------------------------------------------------
// No modo conta externa o dinheiro da venda nasce e fica na conta de provedor
// do seller (Whop, Stripe ou PayPal). A Koopfy não custodia: lê o saldo com a
// credencial que ele conectou e dispara o saque para o banco DELE.
//
// Cada provedor fala de um jeito (Whop em decimal, Stripe na menor unidade da
// moeda, PayPal em string). Aqui tudo vira o mesmo formato — centavos inteiros
// na convenção do pay (x100 até para JPY) — para o painel mostrar e somar
// contas de provedores diferentes lado a lado.
//
// Nem todo provedor deixa fazer tudo por API; `capabilities` diz ao painel o
// que oferecer em cada conta, em vez de um botão que sempre falha.
// ============================================================================

import { LinkedBalance, LinkedBalanceCurrency, LinkedPayoutMethod, toCents } from '../whop/whop-linked';
import { OwnProvider } from '../seller-provider/seller-provider-accounts';

export type OwnAccountBalance = LinkedBalance;
export type OwnBalanceCurrency = LinkedBalanceCurrency;
export type OwnPayoutMethod = LinkedPayoutMethod;

export type OwnWithdrawalStatus = 'requested' | 'pending' | 'in_transit' | 'completed' | 'failed' | 'canceled';

export interface OwnWithdrawal {
  id: string;
  externalId: string | null;
  amountCents: number;
  feeCents: number;
  currency: string;
  status: OwnWithdrawalStatus | string;
  /** Saque automático do provedor (agenda dele), não pedido por aqui. */
  automatic: boolean;
  estimatedAt: string | null;
  failureReason: string | null;
  createdAt: string;
}

/** Agenda de repasse do provedor (Stripe): diz por que o disponível vive zerado. */
export interface OwnPayoutSchedule {
  interval: 'manual' | 'daily' | 'weekly' | 'monthly' | string;
  delayDays: number | null;
}

export interface OwnFinanceCapabilities {
  balance: boolean;
  /** Dá para pedir o saque por aqui. */
  withdraw: boolean;
  /** O seller escolhe o destino (Whop); senão vai para o banco padrão da conta. */
  chooseDestination: boolean;
  history: boolean;
  /** Onde gerenciar banco e saque no painel do provedor. */
  manageUrl: string;
}

export function capabilitiesOf(provider: OwnProvider, mode: 'live' | 'test' | null = null): OwnFinanceCapabilities {
  if (provider === 'whop') {
    return { balance: true, withdraw: true, chooseDestination: true, history: true, manageUrl: 'https://whop.com/dashboard/' };
  }
  if (provider === 'stripe') {
    return {
      balance: true,
      withdraw: true,
      chooseDestination: false,
      history: true,
      manageUrl: mode === 'test' ? 'https://dashboard.stripe.com/test/payouts' : 'https://dashboard.stripe.com/payouts',
    };
  }
  // PayPal: a API não transfere do saldo para o banco; o saque é no painel dele.
  return {
    balance: true,
    withdraw: false,
    chooseDestination: false,
    history: false,
    manageUrl: mode === 'test' ? 'https://www.sandbox.paypal.com/myaccount/money' : 'https://www.paypal.com/myaccount/money',
  };
}

// ─── Stripe ────────────────────────────────────────────────────────────────

// Mesmas listas do StripeProvider (toStripeAmount): a Stripe usa a menor
// unidade da moeda; o pay guarda centavos (x100) até para moeda sem centavo.
const STRIPE_ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const STRIPE_THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/** Valor da Stripe (menor unidade) → centavos do pay. */
export function fromStripeAmount(amount: unknown, currency: string): number {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 0;
  const cur = String(currency ?? '').toUpperCase();
  if (STRIPE_ZERO_DECIMAL.has(cur)) return Math.round(value * 100);
  if (STRIPE_THREE_DECIMAL.has(cur)) return Math.round(value / 10);
  return Math.round(value);
}

/** Centavos do pay → menor unidade da Stripe. */
export function toStripeMinor(amountCents: number, currency: string): number {
  const cents = Math.round(Number(amountCents));
  const cur = String(currency ?? '').toUpperCase();
  if (STRIPE_ZERO_DECIMAL.has(cur)) return Math.round(cents / 100);
  if (STRIPE_THREE_DECIMAL.has(cur)) return Math.round(cents * 10);
  return cents;
}

/**
 * `GET /v1/balance` (+ a moeda padrão da conta) no formato do painel.
 * Disponível = pronto para repasse; pendente = ainda liquidando. A Stripe não
 * separa "reservado" no saldo da conta própria (só `connect_reserved`).
 */
export function mapStripeBalance(balance: any, defaultCurrency?: string | null): OwnAccountBalance {
  const byCurrency = new Map<string, OwnBalanceCurrency>();
  const row = (currency: string) => {
    const cur = String(currency ?? '').toLowerCase();
    if (!byCurrency.has(cur)) byCurrency.set(cur, { currency: cur, availableCents: 0, pendingCents: 0, reservedCents: 0 });
    return byCurrency.get(cur)!;
  };
  for (const item of Array.isArray(balance?.available) ? balance.available : []) {
    row(item?.currency).availableCents += fromStripeAmount(item?.amount, item?.currency);
  }
  for (const item of Array.isArray(balance?.pending) ? balance.pending : []) {
    row(item?.currency).pendingCents += fromStripeAmount(item?.amount, item?.currency);
  }
  for (const item of Array.isArray(balance?.connect_reserved) ? balance.connect_reserved : []) {
    row(item?.currency).reservedCents += fromStripeAmount(item?.amount, item?.currency);
  }
  const currencies = [...byCurrency.values()].filter(item => item.currency.length === 3);

  const preferred = String(defaultCurrency ?? '').toLowerCase();
  const main = currencies.find(item => item.currency === preferred)
    // Sem moeda padrão: a que tem mais dinheiro é a que o seller procura.
    ?? [...currencies].sort((a, b) => (b.availableCents + b.pendingCents) - (a.availableCents + a.pendingCents))[0];

  return {
    currency: main?.currency ?? (preferred || 'usd'),
    availableCents: main?.availableCents ?? 0,
    pendingCents: main?.pendingCents ?? 0,
    reservedCents: main?.reservedCents ?? 0,
    // Saldo negativo (estorno maior que as vendas) não é teto de saque.
    withdrawableCents: Math.max(0, main?.availableCents ?? 0),
    currencies,
    payoutStatus: null,
    settlementAt: null,
  };
}

const STRIPE_PAYOUT_STATUS: Record<string, OwnWithdrawalStatus> = {
  paid: 'completed',
  pending: 'pending',
  in_transit: 'in_transit',
  canceled: 'canceled',
  failed: 'failed',
};

/** `GET /v1/payouts` no formato do painel. */
export function mapStripePayouts(payload: any): OwnWithdrawal[] {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .filter((row: any) => row?.id)
    .map((row: any) => ({
      id: String(row.id),
      externalId: String(row.id),
      amountCents: fromStripeAmount(row.amount, row.currency),
      feeCents: 0,
      currency: String(row.currency ?? '').toLowerCase(),
      status: STRIPE_PAYOUT_STATUS[String(row.status ?? '')] ?? String(row.status ?? 'pending'),
      automatic: row.automatic === true,
      estimatedAt: unixToIso(row.arrival_date),
      failureReason: row.failure_message ?? null,
      createdAt: unixToIso(row.created) ?? new Date(0).toISOString(),
    }));
}

export function mapStripeSchedule(account: any): OwnPayoutSchedule | null {
  const schedule = account?.settings?.payouts?.schedule;
  if (!schedule?.interval) return null;
  const delay = Number(schedule.delay_days);
  return { interval: String(schedule.interval), delayDays: Number.isFinite(delay) ? delay : null };
}

function unixToIso(seconds: unknown): string | null {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
}

// ─── PayPal ────────────────────────────────────────────────────────────────

/**
 * `GET /v1/reporting/balances?currency_code=ALL` no formato do painel.
 * `withheld_balance` é o que o PayPal segura (reserva, disputas): entra como
 * reservado. O PayPal não expõe "pendente" neste relatório.
 */
export function mapPaypalBalance(payload: any): OwnAccountBalance {
  const rows = Array.isArray(payload?.balances) ? payload.balances : [];
  const currencies: OwnBalanceCurrency[] = rows
    .map((row: any) => ({
      currency: String(row?.currency ?? row?.available_balance?.currency_code ?? '').toLowerCase(),
      availableCents: toCents(row?.available_balance?.value),
      pendingCents: 0,
      reservedCents: toCents(row?.withheld_balance?.value),
    }))
    .filter((row: OwnBalanceCurrency) => row.currency.length === 3);

  const primary = rows.find((row: any) => row?.primary === true);
  const preferred = String(primary?.currency ?? '').toLowerCase();
  const main = currencies.find(item => item.currency === preferred)
    ?? [...currencies].sort((a, b) => b.availableCents - a.availableCents)[0];

  return {
    currency: main?.currency ?? (preferred || 'usd'),
    availableCents: main?.availableCents ?? 0,
    pendingCents: 0,
    reservedCents: main?.reservedCents ?? 0,
    withdrawableCents: Math.max(0, main?.availableCents ?? 0),
    currencies,
    payoutStatus: null,
    settlementAt: payload?.as_of_time ?? null,
  };
}

// ─── Visão consolidada ─────────────────────────────────────────────────────

export interface OwnFinanceTotal {
  currency: string;
  availableCents: number;
  pendingCents: number;
  reservedCents: number;
  /** Quantas contas têm saldo nesta moeda. */
  accounts: number;
}

/**
 * Soma os saldos de várias contas POR MOEDA. Não converte: dólar numa conta e
 * euro em outra são dinheiros diferentes, e somar com uma cotação daria um
 * número que não existe em conta nenhuma.
 */
export function sumBalances(balances: Array<OwnAccountBalance | null | undefined>): OwnFinanceTotal[] {
  const totals = new Map<string, OwnFinanceTotal>();
  for (const balance of balances) {
    if (!balance) continue;
    // Conta sem a lista por moeda (Whop antiga): vale a linha principal.
    const rows = balance.currencies.length
      ? balance.currencies
      : [{ currency: balance.currency, availableCents: balance.availableCents, pendingCents: balance.pendingCents, reservedCents: balance.reservedCents }];
    for (const row of rows) {
      if (!row.availableCents && !row.pendingCents && !row.reservedCents) continue;
      const total = totals.get(row.currency)
        ?? { currency: row.currency, availableCents: 0, pendingCents: 0, reservedCents: 0, accounts: 0 };
      total.availableCents += row.availableCents;
      total.pendingCents += row.pendingCents;
      total.reservedCents += row.reservedCents;
      total.accounts += 1;
      totals.set(row.currency, total);
    }
  }
  return [...totals.values()].sort((a, b) =>
    (b.availableCents + b.pendingCents) - (a.availableCents + a.pendingCents) || a.currency.localeCompare(b.currency));
}

/** Teto do saque numa moeda, pelo saldo que o provedor informou. */
export function withdrawCeiling(balance: OwnAccountBalance, currency: string): number {
  const cur = String(currency ?? '').toLowerCase();
  if (cur === balance.currency) return balance.withdrawableCents;
  return Math.max(0, balance.currencies.find(item => item.currency === cur)?.availableCents ?? 0);
}

/** Pedido de saque conferido antes de qualquer chamada ao provedor. */
export function parseWithdrawInput(input: { amountCents?: unknown; currency?: unknown; payoutMethodId?: unknown }): {
  amountCents: number;
  currency: string;
  payoutMethodId: string | null;
} {
  const amountCents = Math.floor(Number(input?.amountCents));
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error('Informe um valor de saque maior que zero.');
  const currency = String(input?.currency ?? '').trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new Error('Moeda do saque inválida.');
  const payoutMethodId = String(input?.payoutMethodId ?? '').trim() || null;
  return { amountCents, currency, payoutMethodId };
}
