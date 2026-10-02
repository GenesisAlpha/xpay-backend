// ============================================================================
// ROTEAMENTO DE CONTAS PRÓPRIAS DO SELLER — regras puras
// ----------------------------------------------------------------------------
// Com o roteamento ligado o seller tem várias contas por provedor e a Koopfy
// escolhe, por sessão do comprador, em qual delas a venda sai. Dois grupos:
//
//   • cartão → Whop (principal `whopl_…` e extras `whopa_…`) e Stripe
//              (`stripel_…`) misturadas: atendem cartão, pix, apple, google…
//   • PayPal → contas PayPal (`paypall_…`): só o método `paypal`.
//
// Tudo aqui é determinístico dado o que entra (métricas, configuração e o
// sorteio injetado): é o que deixa testar cada estratégia sem banco nem rede.
// O serviço (seller-routing.service.ts) só carrega os dados e grava.
// ============================================================================

import { BadRequestException } from '@nestjs/common';
import { isLinkedProviderAccountId } from '../whop/whop-linked';
import { OwnProvider, isPaypalOwnAccountId, isStripeOwnAccountId, isWhopExtraAccountId } from '../seller-provider/seller-provider-accounts';

export type RoutingStrategy = 'orders_split' | 'revenue_split' | 'priority_cap' | 'score';
export type RoutingGroup = 'card' | 'paypal';
export type RoutingPauseReason = 'manual' | 'disputes' | 'errors';

export const ROUTING_STRATEGIES: RoutingStrategy[] = ['orders_split', 'revenue_split', 'priority_cap', 'score'];

/** Taxa de roteamento padrão (% sobre o bruto em USD). O CRM muda por seller. */
export function defaultRoutingFeePct(): number {
  const raw = Number(process.env.ROUTING_FEE_PCT_DEFAULT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.8;
}

/** Limite padrão da taxa de disputa (%, 7 dias) que pausa a conta. */
export const DEFAULT_DISPUTE_PAUSE_PCT = 0.75;

/**
 * Amostra mínima para a disputa pausar a conta e para o score deixar o prior
 * neutro. Com 3 aprovadas, UMA disputa daria 33% — pausar aí seria punir
 * conta nova por azar, não por risco.
 */
export const MIN_SAMPLE = 20;

/** Score de quem ainda não tem amostra mínima: nem premia nem pune. */
export const NEUTRAL_SCORE = 50;

/** Circuit breaker: erros técnicos seguidos e quanto tempo a conta descansa. */
export const BREAKER_MAX_CONSECUTIVE = 3;
export const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

/** Sessão presa a uma conta por até 24 h (routing_assignments.expires_at). */
export const ASSIGNMENT_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Ids ──────────────────────────────────────────────────────────────────

/** Provedor de uma conta própria pelo prefixo do id, ou null se não é própria. */
export function ownProviderOfId(id: string | null | undefined): OwnProvider | null {
  if (isLinkedProviderAccountId(id) || isWhopExtraAccountId(id)) return 'whop';
  if (isStripeOwnAccountId(id)) return 'stripe';
  if (isPaypalOwnAccountId(id)) return 'paypal';
  return null;
}

export function groupOfProvider(provider: OwnProvider): RoutingGroup {
  return provider === 'paypal' ? 'paypal' : 'card';
}

export function groupOfMethod(method: string | null | undefined): RoutingGroup {
  return String(method ?? '').toLowerCase() === 'paypal' ? 'paypal' : 'card';
}

// ─── Conectar mais uma conta ──────────────────────────────────────────────

/**
 * O que fazer quando o seller conecta uma conta e já há outra recebendo no
 * mesmo grupo. Sem o roteamento vale UMA conta por grupo, e conectar outra
 * trocava a atual em silêncio — ele achava que tinha duas e uma delas parava
 * de receber. A decisão agora é dele:
 *
 *   • 'proceed' → segue (roteamento já ligado, primeira conta, ou ele pediu
 *                 para trocar a atual);
 *   • 'enable'  → ele pediu várias contas: liga o roteamento antes de conectar;
 *   • 'ask'     → há conta recebendo e ele não disse o que quer: o painel pergunta.
 *
 * Conta com a credencial recusada não conta como ocupante: reconectar para
 * consertar a chave não pode pedir decisão nenhuma.
 */
export function connectionChoice(args: {
  routingEnabled: boolean;
  multiAccount?: unknown;
  replace?: unknown;
  /** Contas ATIVAS do mesmo grupo (cartão ou PayPal). */
  occupying: number;
}): 'proceed' | 'enable' | 'ask' {
  if (args.routingEnabled) return 'proceed';
  if (args.multiAccount === true) return 'enable';
  if (args.replace === true || args.occupying <= 0) return 'proceed';
  return 'ask';
}

// ─── Configuração por conta ───────────────────────────────────────────────

/** Linha de seller_routing_accounts (ou o padrão, quando a conta não tem linha). */
export interface RoutingAccountConfig {
  provider_account_id: string;
  seller_id: string;
  provider: OwnProvider;
  label: string | null;
  weight: number;
  priority: number;
  daily_cap_usd_cents: number | null;
  daily_cap_orders: number | null;
  min_ticket_usd_cents: number | null;
  max_ticket_usd_cents: number | null;
  countries: string[] | null;
  currencies: string[] | null;
  paused_at: string | null;
  pause_reason: RoutingPauseReason | null;
}

export function defaultAccountConfig(id: string, sellerId: string, provider: OwnProvider): RoutingAccountConfig {
  return {
    provider_account_id: id,
    seller_id: sellerId,
    provider,
    label: null,
    weight: 100,
    priority: 100,
    daily_cap_usd_cents: null,
    daily_cap_orders: null,
    min_ticket_usd_cents: null,
    max_ticket_usd_cents: null,
    countries: null,
    currencies: null,
    paused_at: null,
    pause_reason: null,
  };
}

/** Linha do banco → configuração normalizada (números vêm como string do numeric/bigint). */
export function normalizeAccountConfig(row: any, fallback: RoutingAccountConfig): RoutingAccountConfig {
  if (!row) return fallback;
  const num = (value: any) => (value === null || value === undefined || value === '' ? null : Number(value));
  const list = (value: any) => (Array.isArray(value) && value.length ? value.map((x: any) => String(x).toUpperCase()) : null);
  return {
    ...fallback,
    label: row.label ?? null,
    weight: Number.isFinite(Number(row.weight)) ? Number(row.weight) : fallback.weight,
    priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : fallback.priority,
    daily_cap_usd_cents: num(row.daily_cap_usd_cents),
    daily_cap_orders: num(row.daily_cap_orders),
    min_ticket_usd_cents: num(row.min_ticket_usd_cents),
    max_ticket_usd_cents: num(row.max_ticket_usd_cents),
    countries: list(row.countries),
    currencies: list(row.currencies),
    paused_at: row.paused_at ?? null,
    pause_reason: row.pause_reason ?? null,
  };
}

// ─── Estatística (7 dias) e score ─────────────────────────────────────────

export interface AccountStats {
  /** Tentativas com a conta (inclui pendentes). */
  orders7d: number;
  approved7d: number;
  failed7d: number;
  /** Fração 0–1 (aprovadas ÷ decididas); null sem nenhuma decidida. */
  approvalRate: number | null;
  revenueUsdCents7d: number;
  refunds7d: number;
  disputes7d: number;
  /** Fração 0–1 (disputas ÷ aprovadas); null sem aprovadas. */
  disputeRate: number | null;
  /** 0–100, ver scoreOf. */
  score: number;
  todayOrders: number;
  todayUsdCents: number;
}

export interface StatsTxRow {
  provider_account_id: string | null;
  status: string | null;
  amount_usd_gross_cents?: number | string | null;
  whop_dispute?: unknown;
  stripe_dispute?: unknown;
  paypal_dispute?: unknown;
}

// Estados que significam "o dinheiro entrou em algum momento": estorno e
// chargeback são vendas aprovadas que depois voltaram.
const APPROVED_STATES = new Set(['approved', 'refunded', 'partially_refunded', 'chargeback']);

export function emptyStats(): AccountStats {
  return {
    orders7d: 0, approved7d: 0, failed7d: 0, approvalRate: null, revenueUsdCents7d: 0,
    refunds7d: 0, disputes7d: 0, disputeRate: null, score: NEUTRAL_SCORE, todayOrders: 0, todayUsdCents: 0,
  };
}

/**
 * Agrega as transações dos últimos 7 dias por conta. Disputa conta pelo
 * status 'chargeback' OU pelo registro da disputa no metadata (Whop, Stripe,
 * PayPal) — a disputa aberta ainda não mudou o status da venda, e é ela que
 * o provedor olha para restringir a conta.
 */
export function computeStats(
  rows: StatsTxRow[],
  accountIds: string[],
  today: Map<string, { volume: number; paidCount: number }>,
  disputeLimitPct: number,
): Map<string, AccountStats> {
  const result = new Map<string, AccountStats>();
  for (const id of accountIds) result.set(id, emptyStats());

  for (const row of rows) {
    const stats = row.provider_account_id ? result.get(row.provider_account_id) : undefined;
    if (!stats) continue;
    const status = String(row.status ?? '').toLowerCase();
    stats.orders7d += 1;
    if (APPROVED_STATES.has(status)) {
      stats.approved7d += 1;
      stats.revenueUsdCents7d += Math.max(0, Math.round(Number(row.amount_usd_gross_cents ?? 0) || 0));
    } else if (status === 'failed') {
      stats.failed7d += 1;
    }
    if (status === 'refunded' || status === 'partially_refunded') stats.refunds7d += 1;
    if (status === 'chargeback' || row.whop_dispute || row.stripe_dispute || row.paypal_dispute) stats.disputes7d += 1;
  }

  for (const [id, stats] of result) {
    const decided = stats.approved7d + stats.failed7d;
    stats.approvalRate = decided > 0 ? stats.approved7d / decided : null;
    stats.disputeRate = stats.approved7d > 0 ? stats.disputes7d / stats.approved7d : null;
    stats.score = scoreOf(stats, disputeLimitPct);
    const day = today.get(id);
    stats.todayOrders = Number(day?.paidCount ?? 0) || 0;
    stats.todayUsdCents = Number(day?.volume ?? 0) || 0;
  }
  return result;
}

/**
 * Score 0–100 da conta nos últimos 7 dias:
 *
 *   score = round(100 × (0,7 × aprovação + 0,3 × saúde de disputa))
 *   aprovação       = aprovadas ÷ (aprovadas + recusadas)
 *   saúde de disputa = max(0, 1 − taxa de disputa ÷ limite de pausa)
 *                      (1 enquanto houver menos de MIN_SAMPLE aprovadas)
 *
 * Menos de MIN_SAMPLE tentativas decididas → NEUTRAL_SCORE (50): conta nova
 * recebe volume para formar histórico, sem competir de igual com quem já
 * provou. Aprovação pesa mais porque é o que o seller sente no caixa; a
 * disputa entra para tirar volume ANTES de a conta chegar ao limite de pausa.
 * Nunca abaixo de 1: conta elegível sempre recebe um pouco (senão nunca
 * recuperaria o score).
 */
export function scoreOf(stats: Pick<AccountStats, 'approved7d' | 'failed7d' | 'disputes7d'>, disputeLimitPct: number): number {
  const decided = stats.approved7d + stats.failed7d;
  if (decided < MIN_SAMPLE) return NEUTRAL_SCORE;
  const approval = stats.approved7d / decided;
  const limit = Math.max(0.0001, disputeLimitPct / 100);
  const disputeHealth = stats.approved7d >= MIN_SAMPLE
    ? Math.max(0, 1 - (stats.disputes7d / stats.approved7d) / limit)
    : 1;
  return Math.max(1, Math.round(100 * (0.7 * approval + 0.3 * disputeHealth)));
}

/** Taxa de disputa acima do limite, com amostra mínima de aprovadas. */
export function disputeLimitExceeded(stats: Pick<AccountStats, 'approved7d' | 'disputes7d'>, disputeLimitPct: number): boolean {
  if (stats.approved7d < MIN_SAMPLE) return false;
  return (stats.disputes7d / stats.approved7d) * 100 > disputeLimitPct;
}

// ─── Elegibilidade ────────────────────────────────────────────────────────

export interface RoutingContext {
  /** País do comprador (ISO-2). Desconhecido = filtro não se aplica agora. */
  country?: string | null;
  currency?: string | null;
  /** Valor da venda em centavos de USD (bruto). */
  amountUsdCents?: number | null;
}

export interface RoutingCandidate {
  id: string;
  provider: OwnProvider;
  config: RoutingAccountConfig;
  stats: AccountStats;
  /** Credencial pronta para cobrar (conectada, sem chave recusada). */
  chargeable: boolean;
  /** Circuit breaker aberto em memória (erros técnicos seguidos). */
  breakerOpen: boolean;
}

export type IneligibleReason =
  | 'not_chargeable'
  | 'paused_manual'
  | 'paused_disputes'
  | 'paused_errors'
  | 'country'
  | 'currency'
  | 'ticket'
  | 'cap_usd'
  | 'cap_orders';

/**
 * Pausa em vigor: manual (até o seller retomar), disputas (enquanto a taxa
 * de 7 dias estiver acima do limite — calculada ao vivo, não depende do que
 * ficou gravado) ou erros (breaker em memória ou pausa gravada ainda dentro
 * do cooldown: volta sozinha).
 */
export function activePause(
  candidate: Pick<RoutingCandidate, 'config' | 'stats' | 'breakerOpen'>,
  disputeLimitPct: number,
  now = Date.now(),
): RoutingPauseReason | null {
  const { config } = candidate;
  if (config.paused_at && (config.pause_reason === 'manual' || !config.pause_reason)) return 'manual';
  if (disputeLimitExceeded(candidate.stats, disputeLimitPct)) return 'disputes';
  if (candidate.breakerOpen) return 'errors';
  if (config.paused_at && config.pause_reason === 'errors') {
    const at = Date.parse(config.paused_at);
    if (Number.isFinite(at) && now - at < BREAKER_COOLDOWN_MS) return 'errors';
  }
  return null;
}

export function capReached(candidate: Pick<RoutingCandidate, 'config' | 'stats'>, amountUsdCents?: number | null): 'cap_usd' | 'cap_orders' | null {
  const { config, stats } = candidate;
  if (config.daily_cap_orders != null && stats.todayOrders >= config.daily_cap_orders) return 'cap_orders';
  if (config.daily_cap_usd_cents != null) {
    // Com o valor da venda, o teto vale para ela caber inteira; sem o valor
    // (escolha da sessão, antes do carrinho fechar), vale o que já entrou.
    const amount = Number.isFinite(Number(amountUsdCents)) && amountUsdCents != null ? Number(amountUsdCents) : 0;
    const projected = stats.todayUsdCents + amount;
    if (amount > 0 ? projected > config.daily_cap_usd_cents : stats.todayUsdCents >= config.daily_cap_usd_cents) return 'cap_usd';
  }
  return null;
}

/** Motivo para a conta não receber esta venda, ou null quando ela pode. */
export function ineligibility(
  candidate: RoutingCandidate,
  ctx: RoutingContext,
  disputeLimitPct: number,
  opts: { ignoreCaps?: boolean; now?: number } = {},
): IneligibleReason | null {
  if (!candidate.chargeable) return 'not_chargeable';
  const pause = activePause(candidate, disputeLimitPct, opts.now);
  if (pause) return `paused_${pause}` as IneligibleReason;

  const { config } = candidate;
  const country = String(ctx.country ?? '').trim().toUpperCase();
  if (config.countries?.length && country && !config.countries.includes(country)) return 'country';
  const currency = String(ctx.currency ?? '').trim().toUpperCase();
  if (config.currencies?.length && currency && !config.currencies.includes(currency)) return 'currency';

  const amount = ctx.amountUsdCents;
  if (amount != null && Number.isFinite(Number(amount))) {
    if (config.min_ticket_usd_cents != null && Number(amount) < config.min_ticket_usd_cents) return 'ticket';
    if (config.max_ticket_usd_cents != null && Number(amount) > config.max_ticket_usd_cents) return 'ticket';
  }

  if (!opts.ignoreCaps) {
    const cap = capReached(candidate, amount);
    if (cap) return cap;
  }
  return null;
}

// ─── Estratégias ──────────────────────────────────────────────────────────

const byPriority = (a: RoutingCandidate, b: RoutingCandidate) =>
  a.config.priority - b.config.priority || a.id.localeCompare(b.id);

/**
 * Divisão por peso pelo DÉFICIT do dia: cada conta deveria ter
 * peso ÷ Σpesos do total (pedidos ou USD) e recebe a próxima quem está mais
 * atrás dessa meta — o mesmo balanceamento que o pool da Koopfy usa. Soma a
 * venda atual ao total para a conta de peso maior começar o dia.
 * Peso 0 = não recebe (a conta fica só de reserva).
 */
function pickByDeficit(
  eligible: RoutingCandidate[],
  measure: (c: RoutingCandidate) => number,
  increment: number,
): RoutingCandidate | null {
  const weighted = eligible.filter(c => c.config.weight > 0);
  if (!weighted.length) return null;
  const totalWeight = weighted.reduce((sum, c) => sum + c.config.weight, 0);
  const total = weighted.reduce((sum, c) => sum + measure(c), 0) + increment;
  let best: { c: RoutingCandidate; deficit: number } | null = null;
  for (const c of [...weighted].sort(byPriority)) {
    const deficit = (c.config.weight / totalWeight) * total - measure(c);
    if (!best || deficit > best.deficit + 1e-9) best = { c, deficit };
  }
  return best?.c ?? null;
}

/**
 * Escolhe a conta entre as ELEGÍVEIS (filtros, pausas e tetos já aplicados).
 * `random` é injetado (0 ≤ x < 1) para o score ser testável.
 */
export function selectAccount(
  strategy: RoutingStrategy,
  eligible: RoutingCandidate[],
  ctx: RoutingContext,
  random: () => number = Math.random,
): RoutingCandidate | null {
  if (!eligible.length) return null;
  switch (strategy) {
    case 'revenue_split':
      return pickByDeficit(eligible, c => c.stats.todayUsdCents, Math.max(1, Number(ctx.amountUsdCents ?? 0) || 1));
    case 'priority_cap':
      // Cascata: a primeira na prioridade leva tudo até o teto dela; o teto
      // já tirou a estourada da lista, então a próxima assume sozinha.
      return [...eligible].sort(byPriority)[0];
    case 'score': {
      // Proporcional ao score (não "tudo para a melhor"): a conta pior ainda
      // recebe um pouco e consegue mostrar que melhorou.
      const sorted = [...eligible].sort(byPriority);
      const total = sorted.reduce((sum, c) => sum + Math.max(1, c.stats.score), 0);
      let ticket = Math.min(0.999999, Math.max(0, random())) * total;
      for (const c of sorted) {
        ticket -= Math.max(1, c.stats.score);
        if (ticket < 0) return c;
      }
      return sorted[sorted.length - 1];
    }
    case 'orders_split':
    default:
      return pickByDeficit(eligible, c => c.stats.todayOrders, 1);
  }
}

export function normalizeStrategy(value: unknown, fallback: RoutingStrategy = 'orders_split'): RoutingStrategy {
  const v = String(value ?? '').trim().toLowerCase();
  return (ROUTING_STRATEGIES as string[]).includes(v) ? (v as RoutingStrategy) : fallback;
}

// ─── Taxa e comissão ──────────────────────────────────────────────────────

/** Taxa de roteamento em vigor: a do CRM ou o padrão. */
export function effectiveRoutingFeePct(overridePct: unknown): number {
  const pct = overridePct === null || overridePct === undefined || overridePct === '' ? NaN : Number(overridePct);
  return Number.isFinite(pct) && pct >= 0 ? pct : defaultRoutingFeePct();
}

export function effectiveDisputePausePct(overridePct: unknown): number {
  const pct = overridePct === null || overridePct === undefined || overridePct === '' ? NaN : Number(overridePct);
  return Number.isFinite(pct) && pct > 0 ? pct : DEFAULT_DISPUTE_PAUSE_PCT;
}

/**
 * Comissão da Koopfy sobre venda em conta própria, em centavos de USD:
 * bruto × (comissão do seller + taxa de roteamento) ÷ 100. Com o roteamento
 * desligado a taxa de roteamento é 0 e o valor é o de sempre.
 */
export function ownAccountCommissionUsdCents(grossUsdCents: number, commissionPct: number, routingFeePct: number): number {
  const gross = Math.max(0, Math.round(Number(grossUsdCents) || 0));
  const pct = (Number(commissionPct) || 0) + (Number(routingFeePct) || 0);
  if (gross <= 0 || pct <= 0) return 0;
  return Math.round((gross * pct) / 100);
}

// ─── Falha técnica × recusa ───────────────────────────────────────────────

/**
 * A falha foi da CONTA (credencial, provedor fora, timeout) ou do cartão?
 * Só a primeira alimenta o circuit breaker: recusa do emissor não é defeito
 * da conta, e três cartões sem limite seguidos não podem tirá-la do ar (nem
 * mandar o próximo cartão para outra conta — é o padrão de card testing).
 *
 * Quem classifica (Stripe, PayPal, Clip) manda `data.accountLevel`; nos
 * demais (Whop) vale o que dá para ler: código de recusa ou pagamento criado
 * no provedor = passou pela conta e o emissor decidiu; HTTP 5xx, 401/403,
 * 429 ou timeout = técnico.
 */
export function isTechnicalFailure(result: any): boolean {
  const flag = result?.data?.accountLevel;
  if (typeof flag === 'boolean') return flag;
  if (result?.providerTransactionId) return false;
  const data = result?.data ?? {};
  if (data?.decline_code || data?.last_payment_error?.decline_code || data?.error?.decline_code) return false;
  const httpStatus = Number(data?.http_status ?? data?.httpStatus ?? data?.status_code);
  const message = String(result?.failureMessage ?? '');
  const fromMessage = Number(/HTTP (\d{3})/.exec(message)?.[1]);
  const status = Number.isFinite(httpStatus) && httpStatus > 0 ? httpStatus : fromMessage;
  if (Number.isFinite(status) && (status >= 500 || status === 401 || status === 403 || status === 429)) return true;
  if (/TIMEOUT_|ECONN|ETIMEDOUT|fetch failed|network/i.test(message)) return true;
  return false;
}

// ─── Desligar o roteamento ────────────────────────────────────────────────

export interface DisableCandidate {
  id: string;
  provider: OwnProvider;
  priority: number;
  createdAt?: string | null;
}

/**
 * Quem fica valendo quando o seller desliga o roteamento: a de maior
 * prioridade de cada provedor e, no cartão, só UMA entre Whop e Stripe (a
 * exclusão Whop×Stripe volta). As Whop extras ficam sempre guardadas: fora do
 * roteamento a Whop é a principal (é ela que tem carteira e saque).
 * Devolve os ids que continuam ativos; o resto vai para 'standby'.
 */
export function keptOnDisable(accounts: DisableCandidate[]): Set<string> {
  const order = (a: DisableCandidate, b: DisableCandidate) =>
    a.priority - b.priority || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id);
  const kept = new Set<string>();

  const card = accounts
    .filter(a => a.provider === 'stripe' || (a.provider === 'whop' && isLinkedProviderAccountId(a.id)))
    .sort(order);
  if (card[0]) kept.add(card[0].id);

  const paypal = accounts.filter(a => a.provider === 'paypal').sort(order);
  if (paypal[0]) kept.add(paypal[0].id);
  return kept;
}

// ─── Edição da conta pelo painel ──────────────────────────────────────────

/**
 * Campos editáveis de uma conta no roteamento → colunas. Ausente = não muda;
 * null = sem teto/filtro. Valor inválido é recusado com a lista de erros.
 */
export function parseAccountPatch(body: Record<string, any>, current: RoutingAccountConfig, nowIso: string): Record<string, any> {
  const patch: Record<string, any> = {};
  const errors: string[] = [];
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  const int = (key: string, column: string, min: number, max: number, nullable: boolean) => {
    if (!has(key)) return;
    const raw = body[key];
    if ((raw === null || raw === '') && nullable) { patch[column] = null; return; }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${key}: use um inteiro entre ${min} e ${max}${nullable ? ' (ou vazio)' : ''}.`);
      return;
    }
    patch[column] = value;
  };

  if (has('label')) {
    const label = String(body.label ?? '').trim();
    patch.label = label ? label.slice(0, 60) : null;
  }
  int('weight', 'weight', 0, 10000, false);
  int('priority', 'priority', 1, 1000, false);
  int('dailyCapUsdCents', 'daily_cap_usd_cents', 0, 1e12, true);
  int('dailyCapOrders', 'daily_cap_orders', 0, 1e7, true);
  int('minTicketUsdCents', 'min_ticket_usd_cents', 0, 1e12, true);
  int('maxTicketUsdCents', 'max_ticket_usd_cents', 0, 1e12, true);

  const min = has('minTicketUsdCents') ? patch.min_ticket_usd_cents : current.min_ticket_usd_cents;
  const max = has('maxTicketUsdCents') ? patch.max_ticket_usd_cents : current.max_ticket_usd_cents;
  if (min != null && max != null && min > max) errors.push('A faixa de valor está invertida (mínimo acima do máximo).');

  const codes = (key: string, column: string, pattern: RegExp, label: string) => {
    if (!has(key)) return;
    const raw = body[key];
    if (raw === null || raw === '' || (Array.isArray(raw) && !raw.length)) { patch[column] = null; return; }
    const list = (Array.isArray(raw) ? raw : String(raw).split(','))
      .map((item: any) => String(item).trim().toUpperCase())
      .filter(Boolean);
    const invalid = list.filter((item: string) => !pattern.test(item));
    if (invalid.length) { errors.push(`${label} inválido(s): ${invalid.join(', ')}.`); return; }
    patch[column] = Array.from(new Set(list)).slice(0, 250);
  };
  codes('countries', 'countries', /^[A-Z]{2}$/, 'País');
  codes('currencies', 'currencies', /^[A-Z]{3}$/, 'Moeda');

  if (has('paused')) {
    if (body.paused === true) {
      patch.paused_at = current.paused_at && current.pause_reason === 'manual' ? current.paused_at : nowIso;
      patch.pause_reason = 'manual';
    } else if (body.paused === false) {
      // Retomar limpa qualquer pausa gravada; disputa acima do limite e
      // breaker aberto continuam valendo pelo cálculo ao vivo.
      patch.paused_at = null;
      patch.pause_reason = null;
    } else {
      errors.push('paused: use true ou false.');
    }
  }

  if (errors.length) throw new BadRequestException(`Configuração inválida. ${errors.join(' ')}`);
  return patch;
}
