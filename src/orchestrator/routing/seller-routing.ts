// ============================================================================
// ROTEAMENTO DE CONTAS PRÓPRIAS DO SELLER — regras puras
// ----------------------------------------------------------------------------
// Com o roteamento ligado o seller tem várias contas por provedor e a Koopfy
// escolhe, por sessão do comprador, em qual delas a venda sai. O pool é um
// só; a divisão é por SLOT de método, cada slot com a sua estratégia:
//
//   • 'card'   → cartão, Apple Pay e Google Pay juntos ("Cartão e carteiras"):
//                o mesmo formulário Stripe/Whop desenha os três. Whop
//                (principal `whopl_…` e extras `whopa_…`), Stripe (`stripel_…`)
//                e as contas por link (Shopify `shopifyp_…`, Digistore24
//                `digistp_…`) concorrem aqui;
//   • 'paypal' → contas PayPal (`paypall_…`): só o método `paypal`;
//   • os demais (pix, ideal, mbway…) → um slot por método, com as contas que
//                o oferecem.
//
// Tudo aqui é determinístico dado o que entra (métricas, configuração e o
// sorteio injetado): é o que deixa testar cada estratégia sem banco nem rede.
// O serviço (seller-routing.service.ts) só carrega os dados e grava.
// ============================================================================

import { BadRequestException } from '@nestjs/common';
import { isLinkedProviderAccountId } from '../whop/whop-linked';
import { OwnProvider, isPaypalOwnAccountId, isStripeOwnAccountId, isWhopExtraAccountId } from '../seller-provider/seller-provider-accounts';

export type RoutingStrategy = 'orders_split' | 'revenue_split' | 'priority_cap' | 'score';
/**
 * Provedor de uma conta no roteamento. 'shopify' e 'digistore24' são contas
 * por LINK: o comprador paga no checkout da loja Shopify do seller (Shopify
 * Payments) ou no formulário de pedido da Digistore24, não no formulário da
 * Koopfy. Atendem só o slot do cartão, com as mesmas regras.
 */
export type RoutingProvider = OwnProvider | 'shopify' | 'digistore24';
/** Só o campo `group` do painel antigo: 'paypal' para PayPal, 'card' para o resto. */
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

// ─── Dia do roteamento ────────────────────────────────────────────────────

/**
 * Tetos do dia e dias de aquecimento contam no fuso de Brasília (UTC−3, sem
 * horário de verão desde 2019): o seller pensa em "hoje" no relógio dele, e o
 * dia em UTC virava às 21h — o teto zerava no meio da noite de vendas.
 */
const ROUTING_DAY_OFFSET_MS = -3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Número do dia (dias desde 1970) no fuso de Brasília. */
export function routingDayNumber(ms: number): number {
  return Math.floor((ms + ROUTING_DAY_OFFSET_MS) / DAY_MS);
}

/** Início do dia de Brasília que contém `ms`, em epoch ms (UTC). */
export function routingDayStartMs(ms: number): number {
  return routingDayNumber(ms) * DAY_MS - ROUTING_DAY_OFFSET_MS;
}

// ─── Ids ──────────────────────────────────────────────────────────────────

// Conta por link (seller_link_accounts): `shopifyp_<uuid>` e `digistp_<uuid>`.
// O prefixo cabe na regex do backend do checkout (`^[a-z]{4,8}_`).
const SHOPIFY_LINK_PREFIX = 'shopifyp_';
const DIGISTORE_LINK_PREFIX = 'digistp_';

export function toShopifyLinkAccountId(rowId: string): string {
  return `${SHOPIFY_LINK_PREFIX}${rowId}`;
}

export function toDigistoreLinkAccountId(rowId: string): string {
  return `${DIGISTORE_LINK_PREFIX}${rowId}`;
}

export function isLinkAccountId(id: string | null | undefined): boolean {
  return typeof id === 'string' && (id.startsWith(SHOPIFY_LINK_PREFIX) || id.startsWith(DIGISTORE_LINK_PREFIX));
}

export function linkRowIdOf(id: string): string | null {
  if (typeof id !== 'string') return null;
  if (id.startsWith(SHOPIFY_LINK_PREFIX)) return id.slice(SHOPIFY_LINK_PREFIX.length);
  if (id.startsWith(DIGISTORE_LINK_PREFIX)) return id.slice(DIGISTORE_LINK_PREFIX.length);
  return null;
}

/** Provedores por link: o comprador sai do checkout da Koopfy para pagar. */
export const LINK_PROVIDERS = ['shopify', 'digistore24'] as const;

/** Conta por link (o comprador sai do checkout da Koopfy para pagar)? */
export function isLinkProvider(provider: RoutingProvider | string | null | undefined): boolean {
  return provider === 'shopify' || provider === 'digistore24';
}

/** Provedor de uma conta própria pelo prefixo do id, ou null se não é própria. */
export function ownProviderOfId(id: string | null | undefined): RoutingProvider | null {
  if (typeof id === 'string' && id.startsWith(SHOPIFY_LINK_PREFIX)) return 'shopify';
  if (typeof id === 'string' && id.startsWith(DIGISTORE_LINK_PREFIX)) return 'digistore24';
  if (isLinkedProviderAccountId(id) || isWhopExtraAccountId(id)) return 'whop';
  if (isStripeOwnAccountId(id)) return 'stripe';
  if (isPaypalOwnAccountId(id)) return 'paypal';
  return null;
}

/**
 * `group` do painel antigo (compatibilidade): 'paypal' para conta PayPal,
 * 'card' para as demais. A escolha não usa mais grupo: usa os slots.
 */
export function groupOfProvider(provider: RoutingProvider): RoutingGroup {
  return provider === 'paypal' ? 'paypal' : 'card';
}

// ─── Slots de método ──────────────────────────────────────────────────────

/** Nome de slot (e de método) aceito: o mesmo formato dos métodos por conta. */
export const SLOT_NAME_RE = /^[a-z][a-z0-9_]{1,29}$/;

// Cartão e carteiras: o mesmo formulário (Stripe/Whop) desenha os três.
const CARD_SLOT_METHODS = new Set(['card', 'credit_card', 'debit_card', 'apple_pay', 'google_pay']);

/** Slot de um método: 'card' para cartão e carteiras; o resto é o próprio método. */
export function slotOfMethod(method: unknown): string {
  const m = canonicalMethod(method);
  return CARD_SLOT_METHODS.has(m) ? 'card' : m;
}

/** Ordem dos slots no painel e na resposta: card, paypal, depois alfabética. */
export function compareSlots(a: string, b: string): number {
  const rank = (slot: string) => (slot === 'card' ? 0 : slot === 'paypal' ? 1 : 2);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * Métodos que a conta oferece de fato: os que ela atende filtrados pelos que
 * o seller deixou ligados (mantém a grafia de origem). Conta de cartão sem
 * nada lido atende pelo menos o cartão — é o que ela fazia antes dos slots.
 */
export function effectiveMethods(
  provider: RoutingProvider,
  available: string[],
  config: Pick<RoutingAccountConfig, 'methods'> | null | undefined,
): string[] {
  const base = available.length ? available : provider === 'paypal' ? ['paypal'] : ['credit_card'];
  return applyAccountMethods(base, config);
}

/**
 * Slots que a conta atende. Contas por link (Shopify, Digistore24) só o
 * cartão; PayPal só o PayPal; Whop e Stripe os slots dos métodos efetivos.
 */
export function slotsOfAccount(provider: RoutingProvider, methods: string[]): string[] {
  if (isLinkProvider(provider)) return ['card'];
  if (provider === 'paypal') return ['paypal'];
  const slots = new Set<string>();
  for (const method of methods) {
    const slot = slotOfMethod(method);
    if (slot && slot !== 'paypal' && SLOT_NAME_RE.test(slot)) slots.add(slot);
  }
  return [...slots].sort(compareSlots);
}

/** Os slots de duas contas se cruzam? (pausa, conexão e desligar contam assim) */
export function slotsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some(slot => b.includes(slot));
}

/** Slots que uma conta atende antes de conectar (sem métodos lidos ainda). */
export function defaultSlotsOf(provider: RoutingProvider): string[] {
  return provider === 'paypal' ? ['paypal'] : ['card'];
}

/**
 * Estratégia de um slot: a gravada para ele (method_strategies) ou, sem ela,
 * a do PayPal para o slot 'paypal' e a do cartão para todos os outros.
 */
export function strategyOfSlot(
  settings: { methodStrategies?: Record<string, RoutingStrategy> | null; cardStrategy: RoutingStrategy; paypalStrategy: RoutingStrategy },
  slot: string,
): RoutingStrategy {
  const stored = settings.methodStrategies?.[slot];
  if (stored) return stored;
  return slot === 'paypal' ? settings.paypalStrategy : settings.cardStrategy;
}

/** method_strategies do banco → só os pares válidos. */
export function normalizeMethodStrategies(raw: unknown): Record<string, RoutingStrategy> {
  const out: Record<string, RoutingStrategy> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [slot, value] of Object.entries(raw as Record<string, unknown>)) {
    const strategy = normalizeStrategy(value, '' as any);
    if (SLOT_NAME_RE.test(slot) && strategy) out[slot] = strategy;
  }
  return out;
}

/**
 * `strategies` do PUT do painel → slots a gravar (null = volta ao padrão do
 * slot). Slot com nome inválido: 400 ROUTING_INVALID_SLOT; estratégia
 * inválida: 400 ROUTING_INVALID_STRATEGY.
 */
export function parseStrategiesPatch(raw: unknown): Record<string, RoutingStrategy | null> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException({ error: 'ROUTING_INVALID_STRATEGY', message: 'strategies: envie um objeto { slot: estratégia }.' });
  }
  const out: Record<string, RoutingStrategy | null> = {};
  for (const [rawSlot, value] of Object.entries(raw as Record<string, unknown>)) {
    const slot = String(rawSlot).trim().toLowerCase();
    if (!SLOT_NAME_RE.test(slot)) {
      throw new BadRequestException({ error: 'ROUTING_INVALID_SLOT', message: `Forma de pagamento inválida: ${String(rawSlot)}.` });
    }
    if (value === null) { out[slot] = null; continue; }
    const strategy = normalizeStrategy(value, '' as any);
    if (!strategy) throw new BadRequestException({ error: 'ROUTING_INVALID_STRATEGY', message: `Estratégia inválida: ${String(value)}.` });
    out[slot] = strategy;
  }
  return out;
}

/**
 * Atribuição da sessão para um slot: a gravada por slot (method_accounts) ou,
 * em sessão gravada antes dos slots, as colunas antigas (cartão e PayPal).
 */
export function assignedOfSlot(
  assignment: { card_account_id?: string | null; paypal_account_id?: string | null; method_accounts?: Record<string, string> | null } | null | undefined,
  slot: string,
): string | null {
  if (!assignment) return null;
  const stored = assignment.method_accounts?.[slot];
  if (typeof stored === 'string' && stored) return stored;
  if (slot === 'card') return assignment.card_account_id ?? null;
  if (slot === 'paypal') return assignment.paypal_account_id ?? null;
  return null;
}

// ─── Conectar mais uma conta ──────────────────────────────────────────────

/**
 * O que fazer quando o seller conecta uma conta e já há outra recebendo nos
 * mesmos slots (cartão ou PayPal). Sem o roteamento vale UMA conta por grupo, e conectar outra
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
  /** Contas ATIVAS cujos slots cruzam com os da conta nova (ver occupyingAccounts). */
  occupying: number;
}): 'proceed' | 'enable' | 'ask' {
  if (args.routingEnabled) return 'proceed';
  if (args.multiAccount === true) return 'enable';
  if (args.replace === true || args.occupying <= 0) return 'proceed';
  return 'ask';
}

/**
 * Contas que "já recebem" no lugar da conta nova: ativas, pelo formulário
 * (conta por link não conta) e com algum slot em comum com os da conta nova
 * (antes de conectar: cartão para Whop/Stripe, PayPal para PayPal).
 */
export function occupyingAccounts<T extends { provider: RoutingProvider; connection: string; slots?: string[] }>(
  provider: RoutingProvider,
  pool: T[],
): T[] {
  const wanted = defaultSlotsOf(provider);
  return pool.filter(entry =>
    entry.connection === 'active'
    && !isLinkProvider(entry.provider)
    && slotsOverlap(entry.slots ?? defaultSlotsOf(entry.provider), wanted));
}

/**
 * "Trocar a conta atual" com o roteamento desligado: quais contas saem DEPOIS
 * que a nova conecta. Só as de OUTRO provedor do mesmo grupo — a do mesmo
 * provedor é regravada no lugar pela própria conexão (uma linha por provedor
 * sem o roteamento). Sair depois, e não antes, é o que garante que uma chave
 * errada na conta nova não deixa o seller sem conta nenhuma.
 */
export function accountsToReplace(args: {
  provider: OwnProvider;
  replace?: unknown;
  routingEnabled: boolean;
  occupying: Array<{ id: string; provider: OwnProvider }>;
}): string[] {
  if (args.routingEnabled || args.replace !== true) return [];
  return args.occupying.filter(entry => entry.provider !== args.provider).map(entry => entry.id);
}

// ─── Configuração por conta ───────────────────────────────────────────────

/** Linha de seller_routing_accounts (ou o padrão, quando a conta não tem linha). */
export interface RoutingAccountConfig {
  provider_account_id: string;
  seller_id: string;
  provider: RoutingProvider;
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
  /** Aquecimento: início (null = desligado). Ver warmupState. */
  warmup_started_at: string | null;
  warmup_days: number | null;
  warmup_start_orders: number | null;
  warmup_start_usd_cents: number | null;
  /** Crescimento diário dos limites, em % (30 = ×1,3 por dia). */
  warmup_growth_pct: number | null;
  /** Ticket máximo enquanto aquece. */
  warmup_max_ticket_usd_cents: number | null;
  /** Métodos que a conta oferece no checkout (null = todos os que ela atende). */
  methods: string[] | null;
}

export function defaultAccountConfig(id: string, sellerId: string, provider: RoutingProvider): RoutingAccountConfig {
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
    warmup_started_at: null,
    warmup_days: null,
    warmup_start_orders: null,
    warmup_start_usd_cents: null,
    warmup_growth_pct: null,
    warmup_max_ticket_usd_cents: null,
    methods: null,
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
    warmup_started_at: row.warmup_started_at ?? null,
    warmup_days: num(row.warmup_days),
    warmup_start_orders: num(row.warmup_start_orders),
    warmup_start_usd_cents: num(row.warmup_start_usd_cents),
    warmup_growth_pct: num(row.warmup_growth_pct),
    warmup_max_ticket_usd_cents: num(row.warmup_max_ticket_usd_cents),
    methods: Array.isArray(row.methods) && row.methods.length
      ? Array.from(new Set(row.methods.map((m: any) => canonicalMethod(m)).filter(Boolean))) as string[]
      : null,
  };
}

// ─── Métodos por conta ────────────────────────────────────────────────────

/**
 * Nome único do método: o pay fala 'credit_card'/'debit_card', o checkout
 * fala 'card'. Tudo do cartão vira 'card'; o resto vai em minúsculas.
 */
export function canonicalMethod(value: unknown): string {
  const m = String(value ?? '').trim().toLowerCase();
  return m === 'credit_card' || m === 'debit_card' ? 'card' : m;
}

/** A conta oferece este método? Sem lista configurada, todos os dela. */
export function methodAllowed(config: Pick<RoutingAccountConfig, 'methods'>, method: unknown): boolean {
  if (!config.methods?.length) return true;
  return config.methods.includes(canonicalMethod(method));
}

/** Os métodos da conta que o seller deixou ligados (mantém a grafia de origem). */
export function applyAccountMethods<T>(methods: T[], config: Pick<RoutingAccountConfig, 'methods'> | null | undefined): T[] {
  if (!config?.methods?.length) return methods;
  return methods.filter(method => methodAllowed(config, method));
}

// ─── Aquecimento ──────────────────────────────────────────────────────────

export const WARMUP_DEFAULT_GROWTH_PCT = 30;
export const WARMUP_MAX_DAYS = 90;

export interface WarmupState {
  /** Dia do aquecimento, começando em 1 (dia de Brasília em que começou). */
  day: number;
  totalDays: number;
  /** Vendas aprovadas permitidas hoje pelo aquecimento (null = sem limite de vendas). */
  ordersLimit: number | null;
  /** Volume permitido hoje pelo aquecimento, em centavos de USD (null = sem limite de volume). */
  usdLimitCents: number | null;
  maxTicketUsdCents: number | null;
  growthPct: number;
  /** Quando o aquecimento acaba (início do dia seguinte ao último), ISO. */
  endsAt: string;
}

/**
 * Conta nova recebendo o volume cheio do primeiro dia é o que mais derruba
 * conta em Stripe/Whop/PayPal: o provedor vê um salto sem histórico. O
 * aquecimento sobe os limites do dia aos poucos:
 *
 *   limite do dia N = início × (1 + crescimento)^(N − 1)
 *
 * nunca acima do teto diário da conta (o teto é o destino do aquecimento),
 * e com um ticket máximo opcional enquanto durar. Os dias contam no fuso de
 * Brasília a partir do dia em que começou, vendendo ou não — a curva é do
 * calendário, igual à do provedor. Acabados os dias, valem só os tetos.
 * null = sem aquecimento em vigor.
 */
export function warmupState(config: RoutingAccountConfig, now = Date.now()): WarmupState | null {
  const startedMs = config.warmup_started_at ? Date.parse(config.warmup_started_at) : NaN;
  const totalDays = Number(config.warmup_days);
  if (!Number.isFinite(startedMs) || !Number.isInteger(totalDays) || totalDays < 1) return null;
  const index = routingDayNumber(now) - routingDayNumber(startedMs);
  if (index < 0 || index >= totalDays) return null;

  const growth = config.warmup_growth_pct != null && Number.isFinite(Number(config.warmup_growth_pct))
    ? Math.max(0, Number(config.warmup_growth_pct))
    : WARMUP_DEFAULT_GROWTH_PCT;
  const factor = Math.pow(1 + growth / 100, index);
  const curve = (start: number | null, cap: number | null) => {
    if (start == null) return null;
    const value = Math.max(start > 0 ? 1 : 0, Math.floor(start * factor));
    return cap != null ? Math.min(value, cap) : value;
  };

  return {
    day: index + 1,
    totalDays,
    ordersLimit: curve(config.warmup_start_orders, config.daily_cap_orders),
    usdLimitCents: curve(config.warmup_start_usd_cents, config.daily_cap_usd_cents),
    maxTicketUsdCents: config.warmup_max_ticket_usd_cents,
    growthPct: growth,
    endsAt: new Date(routingDayStartMs(startedMs) + totalDays * DAY_MS).toISOString(),
  };
}

/**
 * Fase da conta para o painel: 'warming' enquanto aquece, 'ready_to_scale'
 * depois que o aquecimento terminou (pode subir os tetos), 'active' sem
 * aquecimento configurado.
 */
export function accountStage(config: RoutingAccountConfig, now = Date.now()): 'warming' | 'ready_to_scale' | 'active' {
  if (warmupState(config, now)) return 'warming';
  const started = config.warmup_started_at ? Date.parse(config.warmup_started_at) : NaN;
  if (Number.isFinite(started) && Number(config.warmup_days) >= 1
    && routingDayNumber(now) - routingDayNumber(started) >= Number(config.warmup_days)) return 'ready_to_scale';
  return 'active';
}

/** Os limites de hoje: o menor entre o teto diário e o do aquecimento. */
export function effectiveDailyLimits(config: RoutingAccountConfig, now = Date.now()): {
  orders: number | null;
  usdCents: number | null;
  warmup: WarmupState | null;
} {
  const warmup = warmupState(config, now);
  const min = (a: number | null, b: number | null | undefined) => (a == null ? b ?? null : b == null ? a : Math.min(a, b));
  return {
    orders: min(config.daily_cap_orders, warmup?.ordersLimit),
    usdCents: min(config.daily_cap_usd_cents, warmup?.usdLimitCents),
    warmup,
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
  /** Venda por link com disputa aberta (routing_link_sales.disputed). */
  link_dispute?: unknown;
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
    if (status === 'chargeback' || row.whop_dispute || row.stripe_dispute || row.paypal_dispute || row.link_dispute) stats.disputes7d += 1;
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

export interface TodayTxRow {
  provider_account_id: string | null;
  status: string | null;
  amount_usd_gross_cents?: number | string | null;
}

/**
 * Vendas e volume do dia por conta, a partir das transações criadas desde o
 * início do dia de Brasília: aprovadas (inclusive as que depois voltaram), em
 * USD BRUTO. O account_daily_metrics do pool conta o líquido de câmbio e vira
 * o dia em UTC — comparado com o teto e o ticket (brutos) deixava passar.
 */
export function computeToday(rows: TodayTxRow[], accountIds: string[]): Map<string, { volume: number; paidCount: number }> {
  const result = new Map<string, { volume: number; paidCount: number }>();
  for (const id of accountIds) result.set(id, { volume: 0, paidCount: 0 });
  for (const row of rows) {
    const day = row.provider_account_id ? result.get(row.provider_account_id) : undefined;
    if (!day || !APPROVED_STATES.has(String(row.status ?? '').toLowerCase())) continue;
    day.paidCount += 1;
    day.volume += Math.max(0, Math.round(Number(row.amount_usd_gross_cents ?? 0) || 0));
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
  /**
   * Contas por link nesta sessão: 'deny' (padrão — a oferta não cabe no
   * checkout da Shopify, ou o checkout é antigo e não sabe mandar o comprador
   * para lá), 'allow' (entram no sorteio com as demais) ou 'only' (a oferta
   * foi vinculada à Shopify Payments: só elas). Vale só para o slot do cartão
   * (o único que conta por link atende).
   */
  link?: 'deny' | 'allow' | 'only' | null;
  /**
   * Provedores por link que podem concorrer nesta sessão (padrão: só
   * 'shopify', como antes da Digistore24). O backend manda 'digistore24'
   * quando a oferta é digital de pagamento único.
   */
  linkProviders?: string[] | null;
  /** Método da venda (só no pagamento): a conta precisa oferecê-lo. */
  method?: string | null;
}

/** Provedores por link do `?linkProviders=` (CSV); sem nada, só Shopify. */
export function parseLinkProviders(raw: unknown): string[] {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map(item => String(item).trim().toLowerCase())
    .filter(item => (LINK_PROVIDERS as readonly string[]).includes(item));
  return list.length ? Array.from(new Set(list)) : ['shopify'];
}

/** A conta pode atender esta sessão pelo tipo (link × formulário)? */
export function linkModeAllows(
  provider: RoutingProvider,
  mode: RoutingContext['link'],
  linkProviders?: string[] | null,
): boolean {
  const link = isLinkProvider(provider);
  const allowedLink = link && (linkProviders?.length ? linkProviders : ['shopify']).includes(provider);
  if (mode === 'only') return allowedLink;
  if (mode === 'allow') return !link || allowedLink;
  return !link;
}

export interface RoutingCandidate {
  id: string;
  provider: RoutingProvider;
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
  | 'warmup_ticket'
  | 'cap_usd'
  | 'cap_orders'
  | 'link_mode'
  | 'method';

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

/**
 * Teto do dia atingido? Vale o menor entre o teto diário e o limite do
 * aquecimento (effectiveDailyLimits). Vendas e volume do dia são os
 * APROVADOS no dia de Brasília, em USD bruto — a mesma unidade do ticket.
 */
export function capReached(
  candidate: Pick<RoutingCandidate, 'config' | 'stats'>,
  amountUsdCents?: number | null,
  now = Date.now(),
): 'cap_usd' | 'cap_orders' | null {
  const { stats } = candidate;
  const limits = effectiveDailyLimits(candidate.config, now);
  if (limits.orders != null && stats.todayOrders >= limits.orders) return 'cap_orders';
  if (limits.usdCents != null) {
    // Com o valor da venda, o teto vale para ela caber inteira; sem o valor
    // (escolha da sessão, antes do carrinho fechar), vale o que já entrou.
    const amount = Number.isFinite(Number(amountUsdCents)) && amountUsdCents != null ? Number(amountUsdCents) : 0;
    const projected = stats.todayUsdCents + amount;
    if (amount > 0 ? projected > limits.usdCents : stats.todayUsdCents >= limits.usdCents) return 'cap_usd';
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
  if (!linkModeAllows(candidate.provider, ctx.link, ctx.linkProviders)) return 'link_mode';
  if (ctx.method && !methodAllowed(candidate.config, ctx.method)) return 'method';
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
    const warmup = warmupState(config, opts.now);
    if (warmup?.maxTicketUsdCents != null && Number(amount) > warmup.maxTicketUsdCents) return 'warmup_ticket';
  }

  if (!opts.ignoreCaps) {
    const cap = capReached(candidate, amount, opts.now);
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
/**
 * As linhas da venda em conta própria, cada uma com o seu valor: a taxa de
 * checkout e a de roteamento (0 com o roteamento desligado). O total que vira
 * débito continua sendo ownAccountCommissionUsdCents (pode diferir um
 * centavo da soma das linhas pelo arredondamento).
 */
export function ownAccountFeeLines(grossUsdCents: number, commissionPct: number, routingFeePct: number) {
  const gross = Math.max(0, Math.round(Number(grossUsdCents) || 0));
  const line = (pct: number) => (gross > 0 && pct > 0 ? Math.round((gross * pct) / 100) : 0);
  return {
    checkout_fee_usd_cents: line(Number(commissionPct) || 0),
    routing_fee_usd_cents: line(Number(routingFeePct) || 0),
  };
}

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
  provider: RoutingProvider;
  priority: number;
  createdAt?: string | null;
  /**
   * Slots que a conta ATENDE (os métodos lidos dela, sem o filtro do
   * roteamento — desligado, o filtro por conta não vale). Sem a lista: cartão,
   * ou PayPal para conta PayPal.
   */
  slots?: string[];
}

/**
 * Quem fica valendo quando o seller desliga o roteamento: pela prioridade,
 * cada conta fica se nenhum slot dela cruza com o de uma conta que já ficou —
 * no cartão, só UMA entre Whop e Stripe (a exclusão Whop×Stripe volta), e uma
 * PayPal. As Whop extras ficam sempre guardadas: fora do roteamento a Whop é
 * a principal (é ela que tem carteira e saque). Conta por link não é linha do
 * pay e nunca fica. Devolve os ids que continuam ativos; o resto vai para
 * 'standby'.
 */
export function keptOnDisable(accounts: DisableCandidate[]): Set<string> {
  const order = (a: DisableCandidate, b: DisableCandidate) =>
    a.priority - b.priority || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id);
  const kept = new Set<string>();
  const taken: string[] = [];
  // Sem o roteamento vale uma linha por provedor (a conexão regrava no lugar).
  const providers = new Set<string>();

  const candidates = accounts
    .filter(a => a.provider === 'stripe' || a.provider === 'paypal' || (a.provider === 'whop' && isLinkedProviderAccountId(a.id)))
    .sort(order);
  for (const account of candidates) {
    const slots = account.slots?.length ? account.slots : defaultSlotsOf(account.provider);
    if (providers.has(account.provider) || slotsOverlap(slots, taken)) continue;
    kept.add(account.id);
    providers.add(account.provider);
    taken.push(...slots);
  }
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
  if (has('methods')) {
    const raw = body.methods;
    if (raw === null || raw === '' || (Array.isArray(raw) && !raw.length)) patch.methods = null;
    else {
      const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map(canonicalMethod).filter(Boolean);
      const invalid = list.filter(m => !/^[a-z][a-z0-9_]{1,29}$/.test(m));
      if (invalid.length) errors.push(`Método inválido: ${invalid.join(', ')}.`);
      else patch.methods = Array.from(new Set(list)).slice(0, 40);
    }
  }

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

  if (has('warmup')) parseWarmupPatch(body.warmup, current, nowIso, patch, errors);

  if (errors.length) throw new BadRequestException(`Configuração inválida. ${errors.join(' ')}`);
  return patch;
}

/**
 * `warmup` no corpo do PUT da conta:
 *   • null / false → encerra o aquecimento (a curva fica guardada);
 *   • { days, startOrders?, startUsdCents?, growthPct?, maxTicketUsdCents?, restart? }
 *     → liga ou ajusta. Ligar começa hoje; ajustar um aquecimento em curso
 *     mantém o dia em que ele está, a não ser com `restart: true`.
 * Pelo menos um dos limites de início (vendas ou volume) é obrigatório:
 * aquecimento sem limite nenhum não aquece nada.
 */
function parseWarmupPatch(raw: any, current: RoutingAccountConfig, nowIso: string, patch: Record<string, any>, errors: string[]) {
  if (raw === null || raw === false) {
    patch.warmup_started_at = null;
    return;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('warmup: envie a configuração do aquecimento ou null para encerrar.');
    return;
  }

  const value = (key: string, min: number, max: number, opts: { nullable: boolean; integer: boolean }) => {
    const input = raw[key];
    if (input === undefined || input === null || input === '') return opts.nullable ? null : undefined;
    const n = Number(input);
    if (!Number.isFinite(n) || n < min || n > max || (opts.integer && !Number.isInteger(n))) {
      errors.push(`warmup.${key}: use ${opts.integer ? 'um inteiro' : 'um número'} entre ${min} e ${max}.`);
      return undefined;
    }
    return n;
  };

  const days = value('days', 1, WARMUP_MAX_DAYS, { nullable: false, integer: true });
  const startOrders = value('startOrders', 1, 1e6, { nullable: true, integer: true });
  const startUsd = value('startUsdCents', 100, 1e12, { nullable: true, integer: true });
  const growth = value('growthPct', 0, 200, { nullable: true, integer: false });
  const maxTicket = value('maxTicketUsdCents', 100, 1e12, { nullable: true, integer: true });

  if (raw.days === undefined || raw.days === null || raw.days === '') errors.push('warmup.days: informe por quantos dias a conta aquece.');
  if (startOrders === null && startUsd === null) errors.push('warmup: informe as vendas ou o volume do primeiro dia.');
  // Com qualquer erro a requisição inteira é recusada; não monta o patch.
  if (errors.length) return;

  const running = current.warmup_started_at != null && warmupState(current, Date.parse(nowIso)) !== null;
  patch.warmup_started_at = running && raw.restart !== true ? current.warmup_started_at : nowIso;
  patch.warmup_days = days;
  patch.warmup_start_orders = startOrders;
  patch.warmup_start_usd_cents = startUsd;
  patch.warmup_growth_pct = growth ?? WARMUP_DEFAULT_GROWTH_PCT;
  patch.warmup_max_ticket_usd_cents = maxTicket;
}
