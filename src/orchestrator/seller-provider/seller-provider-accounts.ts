// ============================================================================
// CONTAS STRIPE E PAYPAL PRÓPRIAS DO SELLER — regras puras
// ----------------------------------------------------------------------------
// Mesmo modelo da conta Whop própria (whop-linked.ts): o seller cola as
// credenciais da conta DELE e a Koopfy cobra nela. O dinheiro nunca passa pela
// Koopfy, então a venda não tem taxa do seller, não credita carteira e a
// remuneração é a comissão do CRM, cobrada no cartão dele.
//
// Ids no roteador/webhook, para o pipeline distinguir dos pools da Koopfy:
//   • `stripel_<uuid>`  → conta Stripe do seller
//   • `paypall_<uuid>`  → conta PayPal do seller
//   • `whopa_<uuid>`    → conta Whop EXTRA do seller (roteamento de contas)
//   (a Whop própria principal já é `whopl_<biz>`)
//
// Combinação (decisão do dono, 2026-09-28): Whop e Stripe cobram cartão e são
// mutuamente exclusivas; PayPal combina com qualquer uma, porque só atende o
// método `paypal`.
// ============================================================================

import { DEFAULT_LINKED_COMMISSION_PCT, isLinkedProviderAccountId } from '../whop/whop-linked';

export type OwnProvider = 'whop' | 'stripe' | 'paypal';
export type SellerProviderKind = 'stripe' | 'paypal';
/** O que mora em seller_provider_accounts: Stripe, PayPal e as Whop extras. */
export type SellerProviderRowKind = SellerProviderKind | 'whop';
export type SellerProviderMode = 'live' | 'test';

const STRIPE_PREFIX = 'stripel_';
const PAYPAL_PREFIX = 'paypall_';
// Whop EXTRA (roteamento ligado): a principal continua em whop_linked_accounts
// como `whopl_<biz>`; as demais contas Whop do seller moram aqui.
const WHOP_EXTRA_PREFIX = 'whopa_';

export function toStripeOwnAccountId(rowId: string): string {
  return `${STRIPE_PREFIX}${rowId}`;
}

export function toPaypalOwnAccountId(rowId: string): string {
  return `${PAYPAL_PREFIX}${rowId}`;
}

export function isStripeOwnAccountId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(STRIPE_PREFIX);
}

export function isPaypalOwnAccountId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(PAYPAL_PREFIX);
}

export function toWhopExtraAccountId(rowId: string): string {
  return `${WHOP_EXTRA_PREFIX}${rowId}`;
}

export function isWhopExtraAccountId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(WHOP_EXTRA_PREFIX);
}

/** Id do roteador de uma linha de seller_provider_accounts, pelo provedor dela. */
export function ownAccountIdOfRow(row: Pick<SellerProviderAccountRow, 'id' | 'provider'>): string {
  if (row.provider === 'whop') return toWhopExtraAccountId(row.id);
  return row.provider === 'paypal' ? toPaypalOwnAccountId(row.id) : toStripeOwnAccountId(row.id);
}

/** Id da linha em seller_provider_accounts a partir do id do roteador. */
export function rowIdFromOwnAccountId(id: string): string | null {
  if (isStripeOwnAccountId(id)) return id.slice(STRIPE_PREFIX.length);
  if (isPaypalOwnAccountId(id)) return id.slice(PAYPAL_PREFIX.length);
  if (isWhopExtraAccountId(id)) return id.slice(WHOP_EXTRA_PREFIX.length);
  return null;
}

/**
 * Conta do PRÓPRIO seller (Whop, Stripe ou PayPal)? É o que decide que a venda
 * não entra na carteira da Koopfy: o dinheiro já está na conta dele.
 */
export function isOwnProviderAccountId(id: string | null | undefined): boolean {
  return isLinkedProviderAccountId(id) || isWhopExtraAccountId(id) || isStripeOwnAccountId(id) || isPaypalOwnAccountId(id);
}

export interface SellerProviderAccountRow {
  id: string;
  seller_id: string;
  provider: SellerProviderRowKind;
  status: 'active' | 'invalid' | 'disabled' | 'standby';
  mode: SellerProviderMode;
  account_ref: string | null;
  display_name: string | null;
  public_key: string | null;
  secret_enc: string | null;
  /** Só Whop extra. */
  api_url?: string | null;
  webhook_id: string | null;
  webhook_secret_enc: string | null;
  last_error: string | null;
  last_checked_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Motivo para não cobrar nesta conta, ou null quando ela está pronta. */
export function providerChargeBlocker(row: Pick<SellerProviderAccountRow, 'status' | 'secret_enc' | 'public_key' | 'last_error' | 'provider'> | null): string | null {
  if (!row) return 'seller sem conta própria conectada';
  if (row.status === 'disabled') return 'conexão desligada';
  // Guardada: o seller desligou o roteamento e esta não é a conta que vale.
  if (row.status === 'standby') return 'conta guardada (roteamento desligado)';
  if (row.status === 'invalid') {
    return `credencial recusada pelo provedor${row.last_error ? `: ${row.last_error}` : ''}`;
  }
  if (!row.secret_enc || !row.public_key) return 'credenciais incompletas';
  return null;
}

// ─── Validação das credenciais (antes de qualquer chamada ao provedor) ─────

/**
 * Chaves da Stripe: secret (sk_) ou restrita (rk_) com a publishable (pk_) do
 * MESMO modo. Misturar live com test dá um checkout que cria o intent numa
 * conta e tenta confirmar em outra — o erro da Stripe não diz isso.
 */
export function validateStripeKeys(secretKey: string, publishableKey: string): { mode: SellerProviderMode } {
  const secret = String(secretKey ?? '').trim();
  const publishable = String(publishableKey ?? '').trim();
  if (!secret) throw new Error('Informe a Secret key da sua conta Stripe.');
  if (!publishable) throw new Error('Informe a Publishable key da sua conta Stripe.');

  const secretMatch = /^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.exec(secret);
  if (!secretMatch) {
    throw new Error('A Secret key deve começar com sk_live_ ou rk_live_ (ou sk_test_/rk_test_ em modo de teste).');
  }
  const publishableMatch = /^pk_(live|test)_[A-Za-z0-9]+$/.exec(publishable);
  if (!publishableMatch) {
    throw new Error('A Publishable key deve começar com pk_live_ (ou pk_test_ em modo de teste).');
  }
  if (secretMatch[2] !== publishableMatch[1]) {
    throw new Error('As duas chaves precisam ser do mesmo modo: as duas live ou as duas de teste.');
  }
  return { mode: secretMatch[2] === 'live' ? 'live' : 'test' };
}

export function validatePaypalCredentials(input: { clientId?: unknown; clientSecret?: unknown; mode?: unknown }): {
  clientId: string;
  clientSecret: string;
  mode: SellerProviderMode;
} {
  const clientId = String(input?.clientId ?? '').trim();
  const clientSecret = String(input?.clientSecret ?? '').trim();
  const mode = String(input?.mode ?? 'live').trim().toLowerCase();
  if (!clientId) throw new Error('Informe o Client ID do seu app no PayPal.');
  if (!clientSecret) throw new Error('Informe o Client Secret do seu app no PayPal.');
  if (mode !== 'live' && mode !== 'test') throw new Error('Modo do PayPal inválido: use produção (live) ou sandbox (test).');
  // Client id e secret do PayPal são longos e sem espaço; colar com quebra de
  // linha ou só um pedaço é o erro mais comum e a resposta do PayPal é genérica.
  if (/\s/.test(clientId) || /\s/.test(clientSecret) || clientId.length < 20 || clientSecret.length < 20) {
    throw new Error('Client ID ou Client Secret incompleto. Copie de novo em Apps & Credentials.');
  }
  return { clientId, clientSecret, mode };
}

// ─── Combinação entre provedores ───────────────────────────────────────────

/**
 * Whop e Stripe cobram cartão: com as duas ativas, a venda de cartão não teria
 * dono claro (e a comissão sairia duas vezes do mesmo pedido em tentativas
 * diferentes). PayPal só atende o método `paypal`, então combina com qualquer uma.
 */
export function ownProviderConflict(
  provider: OwnProvider,
  active: { whop: boolean; stripe: boolean },
): string | null {
  if (provider === 'stripe' && active.whop) {
    return 'Sua conta Whop está conectada. Desconecte a Whop para usar a Stripe — as duas cobram cartão e só uma pode ficar ativa.';
  }
  if (provider === 'whop' && active.stripe) {
    return 'Sua conta Stripe está conectada. Desconecte a Stripe para usar a Whop — as duas cobram cartão e só uma pode ficar ativa.';
  }
  return null;
}

/**
 * Por qual conta própria a venda sai, ou null quando segue o fluxo da Koopfy.
 *
 *   • método `paypal` → PayPal próprio, se cobrando;
 *   • qualquer outro  → Stripe própria (se cobrando), senão a Whop própria —
 *     esta só quando o provider do seller é a Whop, como sempre foi.
 */
export function chooseOwnSaleProvider(args: {
  method?: string | null;
  providerDefault?: string | null;
  whopCharging: boolean;
  stripeCharging: boolean;
  paypalCharging: boolean;
}): OwnProvider | null {
  const method = String(args.method ?? '').toLowerCase();
  if (method === 'paypal') return args.paypalCharging ? 'paypal' : null;
  if (args.stripeCharging) return 'stripe';
  if (String(args.providerDefault ?? '').toLowerCase() === 'whop' && args.whopCharging) return 'whop';
  return null;
}

/**
 * Percentual da comissão da Koopfy sobre venda em conta própria: o do CRM
 * (whop_linked_accounts.commission_pct, em qualquer status) ou 3%. Vale para
 * Whop, Stripe e PayPal — é um percentual por seller, não por provedor.
 */
export function normalizeCommissionPct(raw: unknown): number {
  // null/ausente = padrão (Number(null) seria 0% e a Koopfy não cobraria nada).
  const pct = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(pct) && pct >= 0 ? pct : DEFAULT_LINKED_COMMISSION_PCT;
}

// ─── O que o painel vê ─────────────────────────────────────────────────────

export interface OwnProviderStatus {
  connected: boolean;
  charging: boolean;
  accountName: string | null;
  mode?: SellerProviderMode;
  attention: string | null;
  /** Contas conectadas deste provedor (com o roteamento ligado podem ser várias). */
  accounts?: number;
}

/** Stripe/PayPal no formato do painel — nunca credencial nem id interno. */
export function sellerProviderStatusView(row: SellerProviderAccountRow | null): OwnProviderStatus | null {
  if (!row || row.status === 'disabled' || row.status === 'standby') return null;
  const connected = Boolean(row.secret_enc && row.public_key);
  const name = row.display_name
    ?? (row.provider === 'paypal' ? (row.mode === 'test' ? 'PayPal Sandbox' : 'PayPal') : row.account_ref)
    ?? null;
  return {
    connected,
    charging: connected && providerChargeBlocker(row) === null,
    accountName: name,
    mode: row.mode,
    attention: row.status === 'invalid'
      ? (row.provider === 'stripe'
        ? 'A Stripe recusou a chave. Gere uma nova e conecte de novo.'
        : 'O PayPal recusou as credenciais. Confira o app e conecte de novo.')
      : null,
  };
}

// ─── Valores no formato do PayPal ──────────────────────────────────────────

// Moedas SEM casa decimal no PayPal: mandar "10.00" em JPY é recusado com
// DECIMAL_PRECISION. O pay guarda tudo em centavos (x100) — inclusive JPY,
// ver StripeProvider.toStripeAmount — então aqui divide e arredonda.
const PAYPAL_ZERO_DECIMAL = new Set(['JPY', 'HUF', 'TWD']);

/** Centavos do pay → string decimal do PayPal ("12.34", ou "1000" em JPY). */
export function toPaypalValue(amountCents: number, currency: string): string {
  const cents = Math.round(Number(amountCents));
  if (!Number.isFinite(cents)) throw new Error(`valor inválido: ${amountCents}`);
  const cur = String(currency ?? '').toUpperCase();
  if (PAYPAL_ZERO_DECIMAL.has(cur)) return String(Math.round(cents / 100));
  return (cents / 100).toFixed(2);
}

/**
* A captura do PayPal é desta transação e deste valor? Devolve o motivo da
* divergência, ou null quando confere. `custom_id` é o transactions.id que
* mandamos na order; o valor volta em string decimal na moeda da order.
*/
export function paypalCaptureMismatch(
  tx: { id: string; amount: number; currency: string },
  capture: { customId: string | null; value: string | null; currency: string | null },
): string | null {
  if (capture.customId && capture.customId !== tx.id) return `custom_id ${capture.customId}`;
  if (capture.currency && String(capture.currency).toUpperCase() !== String(tx.currency).toUpperCase()) {
    return `moeda ${capture.currency} (esperado ${tx.currency})`;
  }
  if (capture.value != null) {
    const expected = fromPaypalValue(toPaypalValue(tx.amount, tx.currency));
    const received = fromPaypalValue(capture.value);
    if (!Number.isFinite(received) || received !== expected) {
      return `valor ${capture.value} (esperado ${toPaypalValue(tx.amount, tx.currency)})`;
    }
  }
  return null;
}

/** String do PayPal → centavos do pay (para conferir o que foi capturado). */
export function fromPaypalValue(value: string | number): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return NaN;
  return Math.round(amount * 100);
}

// ─── Visão combinada para o painel (status.externalProvider) ───────────────

/** Visão da Whop que o painel já conhece (sellerExternalProviderView). */
export interface WhopExternalView {
  allowed: boolean;
  connected: boolean;
  provider: 'whop';
  accountName: string | null;
  commissionPct: number;
  charging: boolean;
  walletReady: boolean;
  attention: string | null;
}

export interface CombinedExternalProviderView extends Omit<WhopExternalView, 'provider'> {
  /** Provedor "principal" para painéis antigos: o de cartão conectado, senão PayPal. */
  provider: OwnProvider;
  providers: {
    whop: OwnProviderStatus | null;
    stripe: OwnProviderStatus | null;
    paypal: OwnProviderStatus | null;
  };
  /** Roteamento de contas: ligado? e a taxa em vigor (%). */
  routing?: { enabled: boolean; feePct: number };
}

/** Contagem de contas conectadas por provedor + estado do roteamento. */
export interface ExternalProviderExtras {
  counts?: { whop: number; stripe: number; paypal: number };
  routing?: { enabled: boolean; feePct: number };
}

/**
 * Junta Whop, Stripe e PayPal na visão do painel. Os campos de hoje (Whop)
 * continuam lá para painel antigo em cache; `connected`/`charging` passam a
 * valer para QUALQUER provedor, e `providers` traz o detalhe de cada um.
 * null quando o modo foi cortado no CRM (a opção some do painel).
 *
 * Com o roteamento, `providers.*.accounts` diz quantas contas daquele
 * provedor estão conectadas e `routing` diz se está ligado e a taxa.
 */
export function combineExternalProviderView(
  whop: WhopExternalView | null,
  rows: { stripe: SellerProviderAccountRow | null; paypal: SellerProviderAccountRow | null },
  extras: ExternalProviderExtras = {},
): CombinedExternalProviderView | null {
  if (!whop) return null;
  const counts = extras.counts;
  const withCount = (status: OwnProviderStatus | null, count: number | undefined): OwnProviderStatus | null => {
    if (counts === undefined) return status;
    if (status) return { ...status, accounts: Math.max(count ?? 0, status.connected ? 1 : 0) };
    return null;
  };
  // Whop principal desconectada mas com extras (roteamento): continua "conectada".
  const whopBase: OwnProviderStatus | null = whop.connected
    ? { connected: true, charging: whop.charging, accountName: whop.accountName, attention: whop.attention }
    : counts?.whop
      ? { connected: true, charging: true, accountName: null, attention: null }
      : null;
  const whopStatus = withCount(whopBase, counts?.whop);
  const stripe = withCount(sellerProviderStatusView(rows.stripe), counts?.stripe);
  const paypal = withCount(sellerProviderStatusView(rows.paypal), counts?.paypal);
  const all = [whopStatus, stripe, paypal];

  const main: OwnProvider = whopStatus?.connected ? 'whop'
    : stripe?.connected ? 'stripe'
      : paypal?.connected ? 'paypal'
        : 'whop';
  const mainStatus = main === 'whop' ? whopStatus : main === 'stripe' ? stripe : paypal;

  return {
    ...whop,
    provider: main,
    connected: all.some(item => item?.connected),
    charging: all.some(item => item?.charging),
    accountName: mainStatus?.accountName ?? whop.accountName,
    attention: whop.attention ?? stripe?.attention ?? paypal?.attention ?? null,
    providers: { whop: whopStatus, stripe, paypal },
    ...(extras.routing ? { routing: extras.routing } : {}),
  };
}

// ─────────────────────────────────────────────
// Métodos ativos na conta Stripe do seller
// ─────────────────────────────────────────────

/** Nome do método na Stripe (payment_method_configurations) → nome no checkout. */
export const STRIPE_METHOD_NAMES: Record<string, string> = {
  card: 'credit_card',
  apple_pay: 'apple_pay',
  google_pay: 'google_pay',
  link: 'link',
  ideal: 'ideal',
  bancontact: 'bancontact',
  eps: 'eps',
  p24: 'p24',
  blik: 'blik',
  klarna: 'klarna',
  affirm: 'affirm',
  afterpay_clearpay: 'afterpay',
  sepa_debit: 'sepa',
  multibanco: 'multibanco',
  mb_way: 'mbway',
  twint: 'twint',
  swish: 'swish',
  mobilepay: 'mobile_pay',
  oxxo: 'oxxo',
  pix: 'pix',
  boleto: 'boleto',
  cashapp: 'cashapp',
  us_bank_account: 'ach',
  revolut_pay: 'revolut_pay',
  alipay: 'ali_pay',
};

/** Métodos que só fecham levando o comprador ao banco/app (o intent precisa aceitar redirecionamento). */
export const STRIPE_REDIRECT_METHODS = new Set([
  'ideal', 'bancontact', 'eps', 'p24', 'blik', 'klarna', 'affirm', 'afterpay', 'sepa',
  'multibanco', 'mbway', 'twint', 'swish', 'mobile_pay', 'giropay', 'sofort', 'bizum',
  'revolut_pay', 'ali_pay', 'cashapp',
]);

/**
 * Métodos ligados na configuração padrão da conta (resposta de
 * GET /v1/payment_method_configurations). "Ligado" = a Stripe diz que está
 * disponível para cobrar (`available`), que já junta a preferência do painel e
 * a capacidade aprovada. Devolve null quando não há configuração legível: quem
 * chama mantém a lista de antes em vez de esconder o cartão de todo mundo.
 */
export function stripeEnabledMethodsFrom(response: unknown): string[] | null {
  const list = Array.isArray((response as any)?.data) ? (response as any).data as Record<string, any>[] : [];
  // A padrão da própria conta: sem pai e sem aplicação (as de plataforma Connect ficam de fora).
  const config = list.find(item => item?.is_default === true && !item?.parent && item?.active !== false)
    ?? list.find(item => item?.is_default === true)
    ?? null;
  if (!config) return null;
  const out: string[] = [];
  for (const [stripeName, ourName] of Object.entries(STRIPE_METHOD_NAMES)) {
    if (config[stripeName]?.available === true && !out.includes(ourName)) out.push(ourName);
  }
  return out.length ? out : null;
}
