import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';
import { ProviderAccountConfig } from '../provider-accounts.config';
import { AccountRouterService } from '../router/account-router.service';
import { WhopLinkedAccountsService } from '../whop/whop-linked.service';
import { linkedChargeBlocker, toLinkedProviderAccountId } from '../whop/whop-linked';
import { SellerProviderAccountsService } from '../seller-provider/seller-provider-accounts.service';
import {
  OwnProvider,
  ownAccountIdOfRow,
  providerChargeBlocker,
} from '../seller-provider/seller-provider-accounts';
import {
  ACCOUNTS_TABLE,
  ASSIGNMENTS_TABLE,
  RoutingSettingsRow,
  SETTINGS_TABLE,
  readRoutingSettings,
} from './routing-store';
import {
  ASSIGNMENT_TTL_MS,
  AccountStats,
  BREAKER_COOLDOWN_MS,
  RoutingCandidate,
  RoutingContext,
  RoutingGroup,
  RoutingStrategy,
  StatsTxRow,
  activePause,
  capReached,
  computeStats,
  computeToday,
  effectiveDailyLimits,
  defaultAccountConfig,
  disputeLimitExceeded,
  effectiveDisputePausePct,
  effectiveRoutingFeePct,
  groupOfMethod,
  groupOfProvider,
  ineligibility,
  keptOnDisable,
  normalizeAccountConfig,
  normalizeStrategy,
  ownProviderOfId,
  parseAccountPatch,
  routingDayStartMs,
  selectAccount,
  TodayTxRow,
} from './seller-routing';
import { notifySellerRoutingPause } from '../../utils/seller-mail';

// ============================================================================
// ROTEAMENTO DE CONTAS PRÓPRIAS DO SELLER
// ----------------------------------------------------------------------------
// Carrega as contas do seller (Whop principal, Whop extras, Stripe, PayPal),
// a configuração de cada uma, a estatística de 7 dias e as métricas do dia, e
// aplica as regras puras de seller-routing.ts. Também guarda a conta de cada
// sessão do comprador (routing_assignments).
//
// Com o roteamento DESLIGADO nada aqui entra no caminho da venda: resolveFor*
// devolvem null e o pay segue exatamente como antes.
// ============================================================================

// A estatística de 7 dias muda devagar e custa uma leitura de transações:
// cache curto por seller segura o caminho quente sem esconder uma disputa nova
// por muito tempo.
const STATS_TTL_MS = 60 * 1000;
const STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STATS_ROW_LIMIT = 20000;
// Vendas e volume do dia (tetos e aquecimento): cache bem mais curto, e
// zerado quando uma conta do seller aprova uma venda (onOwnAccountPaid).
const TODAY_TTL_MS = 10 * 1000;

/** Conta no roteamento com o que o painel e a escolha precisam. */
export interface PoolEntry extends RoutingCandidate {
  group: RoutingGroup;
  /** Pronta para o executeWithProvider (credencial decifrada), ou null. */
  account: ProviderAccountConfig | null;
  /** Situação da conexão: ativa, chave recusada ou guardada (roteamento desligado). */
  connection: 'active' | 'invalid' | 'standby';
  accountName: string | null;
  mode: 'live' | 'test' | null;
  /** Whop principal (a que tem carteira e saque). */
  primary: boolean;
  createdAt: string | null;
}

export interface ResolvedRoutingSettings {
  enabled: boolean;
  enabledAt: string | null;
  feeAcceptedAt: string | null;
  cardStrategy: RoutingStrategy;
  paypalStrategy: RoutingStrategy;
  /** Taxa em vigor (%): a do CRM ou o padrão. */
  feePct: number;
  /** Taxa definida no CRM (null = padrão). */
  routingFeePct: number | null;
  /** Limite de disputa definido no CRM (null = padrão). */
  disputePausePct: number | null;
  /** Limite de disputa em vigor (%). */
  disputePausePctEffective: number;
}

export interface RoutingConfigPick {
  card: PoolEntry | null;
  paypal: PoolEntry | null;
  /** Contas conectadas no grupo (0 = o grupo segue o fluxo de antes). */
  cardAccounts: number;
  paypalAccounts: number;
  routingKey: string | null;
}

export type RoutingSalePick =
  | { kind: 'legacy' }
  | { kind: 'account'; entry: PoolEntry & { account: ProviderAccountConfig }; provider: OwnProvider; feePct: number; reason: string };

/** Chave de sessão aceitável (id da checkout session), ou null. */
export function normalizeRoutingKey(value: unknown): string | null {
  const key = String(value ?? '').trim();
  if (!key || key.length > 128 || !/^[A-Za-z0-9_\-:.]+$/.test(key)) return null;
  return key;
}

const ROUTING_REASSIGNED_MESSAGE = 'Atualizamos a forma de pagamento. Confira e tente de novo.';

// Ações do crm_action_log que contam a história das contas próprias e do
// roteamento para o seller (GET routing/history).
const HISTORY_ACTION_PREFIXES = ['routing.', 'seller_provider.', 'whop_linked.', 'own_finance.'];
const HISTORY_LIMIT_MAX = 100;
// Um aviso de pausa por conta por hora, por processo: o cálculo ao vivo roda a
// cada escolha e a gravação da pausa é assíncrona.
const PAUSE_NOTICE_TTL_MS = 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Quem fez a ação, no formato do painel. */
export function historyActor(actor: unknown, managerId: unknown): 'seller' | 'koopfy' | 'system' {
  const value = String(actor ?? '');
  if (value.startsWith('seller:')) return 'seller';
  if (value === 'system') return 'system';
  if (value || managerId) return 'koopfy';
  return 'system';
}

@Injectable()
export class SellerRoutingService implements OnModuleInit {
  constructor(
    private readonly router: AccountRouterService,
    private readonly whopLinked: WhopLinkedAccountsService,
    private readonly sellerProviders: SellerProviderAccountsService,
  ) {}

  // Injetáveis nos testes: o sorteio do `score` e o relógio.
  random: () => number = Math.random;
  now: () => number = () => Date.now();

  private statsCache = new Map<string, { at: number; rows: StatsTxRow[] }>();
  private todayCache = new Map<string, { at: number; dayStart: number; rows: TodayTxRow[] }>();
  private pauseNotices = new Map<string, number>();
  // Injetável nos testes: o e-mail de conta pausada.
  notifyPause: typeof notifySellerRoutingPause = notifySellerRoutingPause;

  onModuleInit() {
    // Breaker de conta própria aberto → grava a pausa 'errors' (volta sozinha
    // depois do cooldown). Fire-and-forget: o pagamento não espera isto.
    this.router.onOwnAccountBreakerOpen = (accountId: string) => {
      void this.recordBreakerPause(accountId).catch((err: any) =>
        console.error(`[SellerRouting] pausa por erros de ${accountId}:`, err?.message));
    };
    // Venda aprovada numa conta própria: a próxima escolha relê o dia (o
    // teto do aquecimento costuma ser de poucas vendas).
    this.router.onOwnAccountPaid = (accountId: string) => this.forgetToday(accountId);
  }

  // ─── Configuração ──────────────────────────────────────────────────────

  async settings(sellerId: string): Promise<ResolvedRoutingSettings> {
    return resolveSettings(await readRoutingSettings(sellerId));
  }

  /** Taxa de roteamento a cobrar numa venda (0 com o roteamento desligado). */
  async feeForSale(sellerId: string): Promise<number> {
    const settings = await this.settings(sellerId);
    return settings.enabled ? settings.feePct : 0;
  }

  // ─── Contas do seller ──────────────────────────────────────────────────

  /**
   * Todas as contas próprias conectadas (inclusive guardadas), com
   * configuração, estatística e situação do breaker. Desconectadas ficam de
   * fora: o seller precisa conectar de novo para voltarem.
   */
  async loadPool(sellerId: string, settings?: ResolvedRoutingSettings): Promise<PoolEntry[]> {
    const resolved = settings ?? (await this.settings(sellerId));
    const [principal, rows, configs] = await Promise.all([
      this.whopLinked.getRow(sellerId).catch(() => null),
      this.sellerProviders.listRows(sellerId).catch(() => []),
      this.loadConfigs(sellerId),
    ]);

    const entries: Array<Omit<PoolEntry, 'stats' | 'breakerOpen'>> = [];

    if (principal?.whop_account_id && principal.api_key && (principal.status === 'active' || principal.status === 'invalid')) {
      const id = toLinkedProviderAccountId(principal.whop_account_id);
      const account = await this.whopLinked.getProviderAccountForSeller(sellerId).catch(() => null);
      entries.push({
        id,
        provider: 'whop',
        group: 'card',
        config: normalizeAccountConfig(configs.get(id), defaultAccountConfig(id, sellerId, 'whop')),
        account: account ?? null,
        chargeable: Boolean(account) && linkedChargeBlocker(principal) === null,
        connection: principal.status === 'active' ? 'active' : 'invalid',
        accountName: principal.company_title ?? principal.whop_account_id,
        mode: null,
        primary: true,
        createdAt: principal.created_at ?? null,
      });
    }

    for (const row of rows) {
      if (row.status !== 'active' && row.status !== 'invalid' && row.status !== 'standby') continue;
      const id = ownAccountIdOfRow(row);
      const provider = row.provider as OwnProvider;
      const account = this.sellerProviders.accountFromRow(row);
      entries.push({
        id,
        provider,
        group: groupOfProvider(provider),
        config: normalizeAccountConfig(configs.get(id), defaultAccountConfig(id, sellerId, provider)),
        account,
        chargeable: Boolean(account) && providerChargeBlocker(row) === null,
        connection: row.status,
        accountName: row.display_name
          ?? (row.provider === 'paypal' ? (row.mode === 'test' ? 'PayPal Sandbox' : 'PayPal') : row.account_ref)
          ?? null,
        mode: row.provider === 'whop' ? null : row.mode,
        primary: false,
        createdAt: row.created_at ?? null,
      });
    }

    const stats = await this.loadStats(sellerId, entries.map(entry => entry.id), resolved.disputePausePctEffective);
    return entries.map(entry => ({
      ...entry,
      stats: stats.get(entry.id)!,
      breakerOpen: this.router.accountBreakerOpen(entry.id),
    }));
  }

  private async loadConfigs(sellerId: string): Promise<Map<string, any>> {
    const { data, error } = await supabase.from(ACCOUNTS_TABLE).select('*').eq('seller_id', sellerId);
    if (error) {
      console.error('[SellerRouting] leitura da configuração das contas:', error.message);
      return new Map();
    }
    return new Map((Array.isArray(data) ? data : []).map((row: any) => [String(row.provider_account_id), row]));
  }

  /** Estatística de 7 dias + métricas do dia, por conta. */
  private async loadStats(sellerId: string, ids: string[], disputeLimitPct: number): Promise<Map<string, AccountStats>> {
    if (!ids.length) return new Map();
    const cacheKey = `${sellerId}:${[...ids].sort().join(',')}`;
    let rows: StatsTxRow[] | undefined;
    const cached = this.statsCache.get(cacheKey);
    if (cached && this.now() - cached.at < STATS_TTL_MS) rows = cached.rows;

    if (!rows) {
      const since = new Date(this.now() - STATS_WINDOW_MS).toISOString();
      const { data, error } = await supabase
        .from('transactions')
        .select(
          'provider_account_id, status, amount_usd_gross_cents, '
          + 'whop_dispute:metadata->whop_dispute, stripe_dispute:metadata->stripe_dispute, paypal_dispute:metadata->paypal_dispute',
        )
        .eq('seller_id', sellerId)
        .in('provider_account_id', ids)
        .gte('created_at', since)
        .limit(STATS_ROW_LIMIT);
      if (error) console.error('[SellerRouting] estatística das contas:', error.message);
      rows = (Array.isArray(data) ? data : []) as unknown as StatsTxRow[];
      this.statsCache.set(cacheKey, { at: this.now(), rows });
    }

    const today = computeToday(await this.loadTodayRows(sellerId, ids), ids);
    return computeStats(rows, ids, today, disputeLimitPct);
  }

  /** Transações criadas desde o início do dia de Brasília (ver computeToday). */
  private async loadTodayRows(sellerId: string, ids: string[]): Promise<TodayTxRow[]> {
    const cacheKey = `${sellerId}:${[...ids].sort().join(',')}`;
    const dayStart = routingDayStartMs(this.now());
    const cached = this.todayCache.get(cacheKey);
    if (cached && cached.dayStart === dayStart && this.now() - cached.at < TODAY_TTL_MS) return cached.rows;

    const { data, error } = await supabase
      .from('transactions')
      .select('provider_account_id, status, amount_usd_gross_cents')
      .eq('seller_id', sellerId)
      .in('provider_account_id', ids)
      .gte('created_at', new Date(dayStart).toISOString())
      .limit(STATS_ROW_LIMIT);
    if (error) {
      console.error('[SellerRouting] vendas do dia das contas:', error.message);
      // Sem a leitura, o último dia conhecido segura os tetos (melhor que zerar).
      return cached && cached.dayStart === dayStart ? cached.rows : [];
    }
    const rows = (Array.isArray(data) ? data : []) as unknown as TodayTxRow[];
    this.todayCache.set(cacheKey, { at: this.now(), dayStart, rows });
    return rows;
  }

  private forgetToday(accountId: string) {
    for (const key of this.todayCache.keys()) {
      if (key.split(':')[1]?.split(',').includes(accountId)) this.todayCache.delete(key);
    }
  }

  // ─── Escolha da conta ──────────────────────────────────────────────────

  private pick(
    group: RoutingGroup,
    pool: PoolEntry[],
    settings: ResolvedRoutingSettings,
    ctx: RoutingContext,
    only?: (entry: PoolEntry) => boolean,
  ): PoolEntry | null {
    const strategy = group === 'paypal' ? settings.paypalStrategy : settings.cardStrategy;
    const eligible = pool.filter(entry =>
      entry.group === group
      && (!only || only(entry))
      && ineligibility(entry, ctx, settings.disputePausePctEffective, { now: this.now() }) === null);
    return selectAccount(strategy, eligible, ctx, this.random) as PoolEntry | null;
  }

  private eligible(entry: PoolEntry | undefined, settings: ResolvedRoutingSettings, ctx: RoutingContext): entry is PoolEntry {
    return Boolean(entry) && ineligibility(entry!, ctx, settings.disputePausePctEffective, { now: this.now() }) === null;
  }

  /**
   * `/payments/config`: escolhe (ou reaproveita) a conta de cartão e a de
   * PayPal desta sessão e grava a atribuição. É o momento em que o checkout
   * monta o formulário — trocar a conta aqui é seguro.
   * null = roteamento desligado (o config segue como antes).
   */
  async resolveForConfig(sellerId: string, routingKey: string | null, ctx: RoutingContext = {}): Promise<RoutingConfigPick | null> {
    const settings = await this.settings(sellerId);
    if (!settings.enabled) return null;

    const pool = await this.loadPool(sellerId, settings);
    this.syncAutoPauses(sellerId, pool, settings);
    const key = normalizeRoutingKey(routingKey);
    const assignment = key ? await this.loadAssignment(key, sellerId) : null;

    const reuse = (id: string | null | undefined, group: RoutingGroup) => {
      const entry = id ? pool.find(item => item.id === id && item.group === group) : undefined;
      return this.eligible(entry, settings, ctx) ? entry : null;
    };
    const card = reuse(assignment?.card_account_id, 'card') ?? this.pick('card', pool, settings, ctx);
    const paypal = reuse(assignment?.paypal_account_id, 'paypal') ?? this.pick('paypal', pool, settings, ctx);

    if (key && (assignment?.card_account_id !== (card?.id ?? null) || assignment?.paypal_account_id !== (paypal?.id ?? null) || !assignment)) {
      await this.saveAssignment(key, sellerId, { card: card?.id ?? null, paypal: paypal?.id ?? null });
    }

    return {
      card,
      paypal,
      cardAccounts: pool.filter(entry => entry.group === 'card').length,
      paypalAccounts: pool.filter(entry => entry.group === 'paypal').length,
      routingKey: key,
    };
  }

  /**
   * createPayment: a conta da venda. Ordem de decisão:
   *   1. mesma chave de idempotência já cobrada numa conta → ela (é retry);
   *   2. conta que a sessão recebeu no config (ou que o navegador declarou em
   *      providerAccountId) → ela, se ainda elegível. Se não é mais, a sessão
   *      ganha outra conta e responde 409 ROUTING_REASSIGNED: o formulário do
   *      navegador foi montado com a credencial pública DAQUELA conta (pk da
   *      Stripe, biz da Whop, client id do PayPal) e não confirmaria em outra;
   *   3. sem sessão: o mesmo pedido já tentou numa conta → ela (recusa não
   *      troca de conta — anti card testing — e o reembolso fica num titular só);
   *   4. escolha nova pela estratégia do grupo.
   * null = roteamento desligado; { kind: 'legacy' } = o grupo não tem contas
   * (ex.: só PayPal conectado e venda de cartão) e segue o fluxo de antes.
   */
  async resolveForSale(
    sellerId: string,
    args: {
      method?: string | null;
      routingKey?: string | null;
      ctx?: RoutingContext;
      orderRef?: string | null;
      providerAccountId?: string | null;
      idempotencyKey?: string | null;
    },
  ): Promise<RoutingSalePick | null> {
    const settings = await this.settings(sellerId);
    if (!settings.enabled) return null;

    const group = groupOfMethod(args.method);
    const ctx = args.ctx ?? {};
    const pool = await this.loadPool(sellerId, settings);
    this.syncAutoPauses(sellerId, pool, settings);
    const groupPool = pool.filter(entry => entry.group === group);
    if (!groupPool.length) return { kind: 'legacy' };

    const done = (entry: PoolEntry, reason: string): RoutingSalePick => {
      if (!entry.account) throw new BadRequestException({ error: 'ROUTING_NO_ACCOUNT', message: 'Conta de pagamento do vendedor indisponível.' });
      return { kind: 'account', entry: entry as PoolEntry & { account: ProviderAccountConfig }, provider: entry.provider, feePct: settings.feePct, reason };
    };
    const inGroup = (id: string | null | undefined) => (id ? groupPool.find(entry => entry.id === id) : undefined);

    // 1. Retry idempotente: o intent/order/sessão já existe naquela conta.
    if (args.idempotencyKey) {
      const { data: existing } = await supabase
        .from('transactions')
        .select('provider_account_id')
        .eq('seller_id', sellerId)
        .eq('idempotency_key', args.idempotencyKey)
        .maybeSingle();
      const entry = inGroup((existing as any)?.provider_account_id);
      if (entry?.chargeable) return done(entry, 'idempotency');
    }

    // 2. Conta da sessão (ou a que o navegador montou).
    const key = normalizeRoutingKey(args.routingKey);
    const assignment = key ? await this.loadAssignment(key, sellerId) : null;
    const assignedId = (group === 'paypal' ? assignment?.paypal_account_id : assignment?.card_account_id)
      ?? (inGroup(args.providerAccountId) ? args.providerAccountId : null);
    if (assignedId) {
      const entry = inGroup(assignedId);
      if (this.eligible(entry, settings, ctx)) return done(entry, 'session');

      // A conta da sessão saiu (pausa, teto, desconexão, filtro): a próxima
      // carga das formas de pagamento já vem com a nova conta.
      const next = this.pick(group, pool, settings, ctx);
      // Nenhuma outra aceita esta venda (ex.: ticket acima do máximo de todas):
      // recarregar não adiantaria — o config, que não conhece o valor, daria a
      // mesma conta de novo e o checkout ficaria preso entre 409s.
      if (!next) {
        throw new BadRequestException({
          error: 'ROUTING_NO_ACCOUNT',
          message: 'Nenhuma conta de pagamento disponível para este pedido agora.',
        });
      }
      if (key) {
        await this.saveAssignment(key, sellerId, {
          card: group === 'card' ? next.id : assignment?.card_account_id ?? null,
          paypal: group === 'paypal' ? next.id : assignment?.paypal_account_id ?? null,
        });
      }
      console.warn(
        `[SellerRouting] seller ${sellerId}: conta ${assignedId} da sessão ${key ?? '(sem chave)'} não é mais elegível `
        + `→ ${next.id}; checkout recarrega (409)`,
      );
      throw new ConflictException({ error: 'ROUTING_REASSIGNED', message: ROUTING_REASSIGNED_MESSAGE });
    }

    // 3. Sem sessão: o pedido já tentou numa conta própria deste grupo.
    if (args.orderRef) {
      const sticky = await this.router.resolveStickyAccountAnyProvider({ sellerId, orderRef: args.orderRef }).catch(() => null);
      const entry = inGroup(sticky?.accountId);
      if (entry && ineligibility(entry, ctx, settings.disputePausePctEffective, { ignoreCaps: true, now: this.now() }) === null) {
        return done(entry, 'order');
      }
    }

    // 4. Escolha nova.
    const chosen = this.pick(group, pool, settings, ctx);
    if (!chosen) {
      throw new BadRequestException({
        error: 'ROUTING_NO_ACCOUNT',
        message: 'Nenhuma conta de pagamento disponível para este pedido agora.',
      });
    }
    if (key) {
      await this.saveAssignment(key, sellerId, {
        card: group === 'card' ? chosen.id : assignment?.card_account_id ?? null,
        paypal: group === 'paypal' ? chosen.id : assignment?.paypal_account_id ?? null,
      });
    }
    return done(chosen, 'strategy');
  }

  // ─── Atribuição por sessão ─────────────────────────────────────────────

  private async loadAssignment(key: string, sellerId: string): Promise<{ card_account_id: string | null; paypal_account_id: string | null } | null> {
    const { data, error } = await supabase
      .from(ASSIGNMENTS_TABLE)
      .select('routing_key, seller_id, card_account_id, paypal_account_id, expires_at')
      .eq('routing_key', key)
      .maybeSingle();
    if (error) {
      console.error('[SellerRouting] leitura da atribuição:', error.message);
      return null;
    }
    const row: any = data;
    if (!row || row.seller_id !== sellerId) return null;
    const expires = Date.parse(String(row.expires_at ?? ''));
    if (Number.isFinite(expires) && expires <= this.now()) return null;
    return { card_account_id: row.card_account_id ?? null, paypal_account_id: row.paypal_account_id ?? null };
  }

  private async saveAssignment(key: string, sellerId: string, ids: { card: string | null; paypal: string | null }) {
    // Chave de outro seller (colisão improvável de id de sessão): não
    // sobrescreve — a sessão dele segue com a conta dele.
    const { data: current } = await supabase
      .from(ASSIGNMENTS_TABLE)
      .select('seller_id')
      .eq('routing_key', key)
      .maybeSingle();
    if ((current as any)?.seller_id && (current as any).seller_id !== sellerId) return;

    const now = this.now();
    const { error } = await supabase.from(ASSIGNMENTS_TABLE).upsert(
      {
        routing_key: key,
        seller_id: sellerId,
        card_account_id: ids.card,
        paypal_account_id: ids.paypal,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + ASSIGNMENT_TTL_MS).toISOString(),
      },
      { onConflict: 'routing_key' },
    );
    if (error) console.error('[SellerRouting] gravação da atribuição:', error.message);
  }

  // ─── Pausas automáticas ────────────────────────────────────────────────

  /**
   * Grava o que o cálculo ao vivo decidiu (para o painel, o CRM e as outras
   * instâncias verem) e limpa o que já passou. Não bloqueia a escolha: quem
   * decide é sempre o cálculo ao vivo.
   */
  private syncAutoPauses(sellerId: string, pool: PoolEntry[], settings: ResolvedRoutingSettings) {
    const nowIso = new Date(this.now()).toISOString();
    for (const entry of pool) {
      const stored = entry.config.pause_reason;
      if (entry.config.paused_at && stored === 'manual') continue;
      const exceeded = disputeLimitExceeded(entry.stats, settings.disputePausePctEffective);
      let patch: Record<string, any> | null = null;
      if (exceeded && stored !== 'disputes') patch = { paused_at: nowIso, pause_reason: 'disputes' };
      else if (!exceeded && stored === 'disputes') patch = { paused_at: null, pause_reason: null };
      else if (stored === 'errors' && !entry.breakerOpen) {
        const at = Date.parse(String(entry.config.paused_at ?? ''));
        if (!Number.isFinite(at) || this.now() - at >= BREAKER_COOLDOWN_MS) patch = { paused_at: null, pause_reason: null };
      }
      if (!patch) continue;
      if (patch.pause_reason === 'disputes') {
        console.error(
          `[SellerRouting] conta ${entry.id} do seller ${sellerId} PAUSADA por disputas: `
          + `${entry.stats.disputes7d}/${entry.stats.approved7d} em 7 dias (limite ${settings.disputePausePctEffective}%)`,
        );
        this.announcePause(sellerId, entry, pool, settings);
      } else if (stored === 'disputes') {
        void this.log(sellerId, 'system', 'routing.account_resumed', { account_id: entry.id, reason: 'disputes' });
      }
      void this.writeAccountConfig(sellerId, entry.id, entry.provider, patch)
        .catch((err: any) => console.error(`[SellerRouting] pausa automática de ${entry.id}:`, err?.message));
    }
  }

  /**
   * Conta pausada por disputas: fica no histórico e o seller recebe o aviso —
   * uma vez por pausa, não a cada venda que recalcula a mesma conta.
   */
  private announcePause(sellerId: string, entry: PoolEntry, pool: PoolEntry[], settings: ResolvedRoutingSettings) {
    const last = this.pauseNotices.get(entry.id);
    if (last && this.now() - last < PAUSE_NOTICE_TTL_MS) return;
    this.pauseNotices.set(entry.id, this.now());

    const remaining = pool.filter(other =>
      other.id !== entry.id
      && other.group === entry.group
      && other.chargeable
      && other.connection === 'active'
      && !activePause(other, settings.disputePausePctEffective, this.now())).length;

    void this.log(sellerId, 'system', 'routing.account_auto_paused', {
      account_id: entry.id,
      reason: 'disputes',
      disputes_7d: entry.stats.disputes7d,
      approved_7d: entry.stats.approved7d,
      limit_pct: settings.disputePausePctEffective,
    });
    void this.notifyPause(sellerId, {
      accountName: entry.config.label ?? entry.accountName ?? entry.id,
      provider: entry.provider,
      disputes: entry.stats.disputes7d,
      approved: entry.stats.approved7d,
      limitPct: settings.disputePausePctEffective,
      remaining,
    });
  }

  /** Breaker aberto numa conta própria: grava a pausa 'errors' (volta sozinha). */
  async recordBreakerPause(accountId: string) {
    const provider = ownProviderOfId(accountId);
    if (!provider) return;
    const account: any = await this.router.resolveAccountById(accountId).catch(() => null);
    const sellerId = account?.config?.seller_id;
    if (!sellerId || !(await this.settings(sellerId)).enabled) return;

    const { data: current } = await supabase
      .from(ACCOUNTS_TABLE)
      .select('paused_at, pause_reason')
      .eq('provider_account_id', accountId)
      .maybeSingle();
    // Pausa manual do seller manda: o breaker não a sobrescreve.
    if ((current as any)?.paused_at && (current as any)?.pause_reason === 'manual') return;

    console.error(`[SellerRouting] conta ${accountId} do seller ${sellerId} em pausa por erros técnicos seguidos (${BREAKER_COOLDOWN_MS / 60000} min)`);
    await this.writeAccountConfig(sellerId, accountId, provider, {
      paused_at: new Date(this.now()).toISOString(),
      pause_reason: 'errors',
    });
    await this.log(sellerId, 'system', 'routing.account_auto_paused', { account_id: accountId, reason: 'errors' });
  }

  private async writeAccountConfig(sellerId: string, accountId: string, provider: OwnProvider, patch: Record<string, any>) {
    const { error } = await supabase.from(ACCOUNTS_TABLE).upsert(
      {
        provider_account_id: accountId,
        seller_id: sellerId,
        provider,
        ...patch,
        updated_at: new Date(this.now()).toISOString(),
      },
      { onConflict: 'provider_account_id' },
    );
    if (error) throw new BadRequestException(`Não foi possível salvar a conta no roteamento: ${error.message}`);
  }

  // ─── Painel do seller ──────────────────────────────────────────────────

  /** GET /integration/koopfy/routing (e a ficha do CRM). */
  async view(sellerId: string) {
    const settings = await this.settings(sellerId);
    const pool = await this.loadPool(sellerId, settings);
    const now = this.now();
    const order = (a: PoolEntry, b: PoolEntry) =>
      (a.group === b.group ? 0 : a.group === 'card' ? -1 : 1)
      || a.config.priority - b.config.priority
      || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));

    return {
      enabled: settings.enabled,
      enabledAt: settings.enabledAt,
      feePct: settings.feePct,
      routingFeePct: settings.routingFeePct,
      feeAcceptedAt: settings.feeAcceptedAt,
      cardStrategy: settings.cardStrategy,
      paypalStrategy: settings.paypalStrategy,
      disputePausePct: settings.disputePausePct,
      disputePausePctEffective: settings.disputePausePctEffective,
      accounts: [...pool].sort(order).map(entry => {
        const pause = activePause(entry, settings.disputePausePctEffective, now);
        const limits = effectiveDailyLimits(entry.config, now);
        return {
          id: entry.id,
          provider: entry.provider,
          group: entry.group,
          primary: entry.primary,
          label: entry.config.label,
          accountName: entry.accountName,
          ...(entry.mode ? { mode: entry.mode } : {}),
          // active = cobrando; attention = credencial recusada; standby =
          // guardada enquanto o roteamento está desligado.
          status: entry.connection === 'invalid' ? 'attention' : entry.connection,
          paused: Boolean(pause),
          pauseReason: pause,
          capReached: Boolean(capReached(entry, null, now)),
          // Limites de HOJE (o menor entre o teto e o aquecimento).
          todayLimitOrders: limits.orders,
          todayLimitUsdCents: limits.usdCents,
          warmup: entry.config.warmup_started_at && entry.config.warmup_days
            ? {
              active: Boolean(limits.warmup),
              startedAt: entry.config.warmup_started_at,
              days: entry.config.warmup_days,
              startOrders: entry.config.warmup_start_orders,
              startUsdCents: entry.config.warmup_start_usd_cents,
              growthPct: entry.config.warmup_growth_pct,
              maxTicketUsdCents: entry.config.warmup_max_ticket_usd_cents,
              day: limits.warmup?.day ?? null,
              endsAt: limits.warmup?.endsAt ?? null,
            }
            : null,
          weight: entry.config.weight,
          priority: entry.config.priority,
          dailyCapUsdCents: entry.config.daily_cap_usd_cents,
          dailyCapOrders: entry.config.daily_cap_orders,
          minTicketUsdCents: entry.config.min_ticket_usd_cents,
          maxTicketUsdCents: entry.config.max_ticket_usd_cents,
          countries: entry.config.countries ?? [],
          currencies: entry.config.currencies ?? [],
          stats: {
            orders7d: entry.stats.orders7d,
            approved7d: entry.stats.approved7d,
            failed7d: entry.stats.failed7d,
            // Frações 0–1 (não percentuais).
            approvalRate: entry.stats.approvalRate,
            revenueUsdCents7d: entry.stats.revenueUsdCents7d,
            refunds7d: entry.stats.refunds7d,
            disputes7d: entry.stats.disputes7d,
            disputeRate: entry.stats.disputeRate,
            score: entry.stats.score,
            todayOrders: entry.stats.todayOrders,
            todayUsdCents: entry.stats.todayUsdCents,
          },
        };
      }),
    };
  }

  /**
   * GET /integration/koopfy/routing/history — o que mudou nas contas e no
   * roteamento, do mais recente para o mais antigo: conexões, liga/desliga,
   * estratégia, ajustes de conta, pausas automáticas e saques. Só o que o
   * seller pode ver: nunca credencial, nunca o id interno de quem é da Koopfy.
   */
  async history(sellerId: string, rawLimit?: unknown) {
    const limit = Math.min(HISTORY_LIMIT_MAX, Math.max(1, Math.floor(Number(rawLimit)) || 50));
    const { data, error } = await supabase
      .from('crm_action_log')
      .select('id, action, manager_id, payload, created_at')
      .eq('seller_id', sellerId)
      .or(HISTORY_ACTION_PREFIXES.map(prefix => `action.like.${prefix}%`).join(','))
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('[SellerRouting] leitura do histórico:', error.message);
      return { events: [] };
    }

    const names = new Map((await this.loadPool(sellerId).catch(() => [] as PoolEntry[]))
      .map(entry => [entry.id, entry.config.label ?? entry.accountName ?? null]));

    return {
      events: (Array.isArray(data) ? data : []).map((row: any) => {
        const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
        const accountId = typeof payload.account_id === 'string' ? payload.account_id : null;
        return {
          id: String(row.id ?? `${row.created_at}:${row.action}`),
          at: row.created_at,
          action: String(row.action),
          actor: historyActor(payload.actor, row.manager_id),
          accountId,
          accountName: accountId ? names.get(accountId) ?? null : null,
          details: historyDetails(payload),
        };
      }),
    };
  }

  /**
   * PUT /integration/koopfy/routing — o seller liga/desliga e escolhe as
   * estratégias. Ligar pela primeira vez exige o aceite da taxa.
   */
  async update(
    sellerId: string,
    body: { enabled?: unknown; acceptFee?: unknown; cardStrategy?: unknown; paypalStrategy?: unknown },
    actor: string | null,
  ) {
    const current = await readRoutingSettings(sellerId);
    const resolved = resolveSettings(current);
    const nowIso = new Date(this.now()).toISOString();

    const patch: Record<string, any> = {};
    for (const [field, column] of [['cardStrategy', 'card_strategy'], ['paypalStrategy', 'paypal_strategy']] as const) {
      const raw = body?.[field];
      if (raw === undefined || raw === null || raw === '') continue;
      const normalized = normalizeStrategy(raw, '' as any);
      if (!normalized) throw new BadRequestException({ error: 'ROUTING_INVALID_STRATEGY', message: `Estratégia inválida: ${String(raw)}.` });
      patch[column] = normalized;
    }

    const wantsEnabled = typeof body?.enabled === 'boolean' ? body.enabled : undefined;
    if (wantsEnabled === true && !resolved.enabled) {
      const accepting = body?.acceptFee === true;
      if (!resolved.feeAcceptedAt && !accepting) {
        throw new BadRequestException({
          error: 'ROUTING_FEE_ACCEPTANCE_REQUIRED',
          message: `Para ligar o roteamento, aceite a taxa de roteamento de ${resolved.feePct}% por venda.`,
        });
      }
      patch.enabled = true;
      patch.enabled_at = nowIso;
      patch.fee_accepted_at = resolved.feeAcceptedAt ?? nowIso;
    } else if (wantsEnabled === false && resolved.enabled) {
      patch.enabled = false;
    }

    if (Object.keys(patch).length) {
      await this.writeSettings(sellerId, patch, actor);
      if (patch.enabled === true) await this.applyEnable(sellerId);
      if (patch.enabled === false) await this.applyDisable(sellerId);
      await this.log(sellerId, actor, 'routing.settings_changed', { ...patch });
    }
    return this.view(sellerId);
  }

  /** Ligar: as contas guardadas voltam a receber. */
  private async applyEnable(sellerId: string) {
    const rows = await this.sellerProviders.listRows(sellerId);
    const standby = rows.filter(row => row.status === 'standby').map(row => row.id);
    if (standby.length) await this.sellerProviders.setRowsStatus(sellerId, standby, 'active');
  }

  /**
   * Desligar: vale a conta de maior prioridade de cada provedor (e só uma
   * entre Whop e Stripe); as demais ficam guardadas ('standby'), com a
   * configuração intacta, para quando o roteamento for ligado de novo.
   */
  private async applyDisable(sellerId: string) {
    const pool = await this.loadPool(sellerId);
    const connected = pool.filter(entry => entry.connection !== 'standby');
    const kept = keptOnDisable(connected.map(entry => ({
      id: entry.id,
      provider: entry.provider,
      priority: entry.config.priority,
      createdAt: entry.createdAt,
    })));
    const rows = await this.sellerProviders.listRows(sellerId);
    const toStandby = rows
      .filter(row => (row.status === 'active' || row.status === 'invalid') && !kept.has(ownAccountIdOfRow(row)))
      .map(row => row.id);
    if (toStandby.length) await this.sellerProviders.setRowsStatus(sellerId, toStandby, 'standby');
  }

  /** PUT /integration/koopfy/routing/accounts/:accountId */
  async updateAccount(sellerId: string, accountId: string, body: Record<string, any>, actor: string | null) {
    const pool = await this.loadPool(sellerId);
    const entry = pool.find(item => item.id === accountId);
    if (!entry) throw new NotFoundException('Conta não encontrada.');

    const patch = parseAccountPatch(body ?? {}, entry.config, new Date(this.now()).toISOString());
    await this.writeAccountConfig(sellerId, accountId, entry.provider, patch);
    await this.log(sellerId, actor, 'routing.account_changed', { account_id: accountId, ...patch });
    return this.view(sellerId);
  }

  // ─── CRM ───────────────────────────────────────────────────────────────

  /**
   * PUT crm/admin/sellers/:sellerId/routing — taxa e limite de disputa (null
   * volta ao padrão) e desligar. Ligar é do seller (tem o aceite da taxa).
   */
  async crmUpdate(
    sellerId: string,
    body: { routingFeePct?: unknown; disputePausePct?: unknown; enabled?: unknown },
    actor: string | null,
  ) {
    const patch: Record<string, any> = {};
    if (body && 'routingFeePct' in body) {
      patch.routing_fee_pct = parsePct(body.routingFeePct, { min: 0, max: 10, label: 'Taxa de roteamento' });
    }
    if (body && 'disputePausePct' in body) {
      patch.dispute_pause_pct = parsePct(body.disputePausePct, { min: 0.01, max: 10, label: 'Limite de disputa' });
    }
    if (body?.enabled === true) {
      throw new BadRequestException('O roteamento é ligado pelo seller no painel (com o aceite da taxa).');
    }
    const disabling = body?.enabled === false && (await this.settings(sellerId)).enabled;
    if (disabling) patch.enabled = false;

    if (Object.keys(patch).length) {
      await this.writeSettings(sellerId, patch, actor);
      if (disabling) await this.applyDisable(sellerId);
      await this.log(sellerId, actor, 'routing.crm_changed', { ...patch });
    }
    return this.view(sellerId);
  }

  // ─── Internos ──────────────────────────────────────────────────────────

  private async writeSettings(sellerId: string, patch: Record<string, any>, actor: string | null) {
    const { error } = await supabase.from(SETTINGS_TABLE).upsert(
      { seller_id: sellerId, ...patch, updated_by: actor, updated_at: new Date(this.now()).toISOString() },
      { onConflict: 'seller_id' },
    );
    if (error) throw new BadRequestException(`Não foi possível salvar o roteamento: ${error.message}`);
  }

  /**
   * `actor` vai dentro do payload: `manager_id` é do gestor do CRM, e as ações
   * do seller ("seller:<id>") e do sistema não cabem lá.
   */
  private async log(sellerId: string, actor: string | null, action: string, payload: Record<string, any>) {
    const { error } = await supabase.from('crm_action_log').insert({
      seller_id: sellerId,
      manager_id: actor && UUID_RE.test(actor) ? actor : null,
      action,
      resource_type: 'seller',
      resource_id: sellerId,
      payload: { ...payload, actor },
      created_at: new Date(this.now()).toISOString(),
    });
    if (error) console.error(`[SellerRouting] ação ${action} não registrada:`, error.message);
  }
}

// ─── Helpers puros do serviço ────────────────────────────────────────────────

export function resolveSettings(row: RoutingSettingsRow | null): ResolvedRoutingSettings {
  const override = (value: unknown) => (value === null || value === undefined || value === '' ? null : Number(value));
  const routingFeePct = override(row?.routing_fee_pct);
  const disputePausePct = override(row?.dispute_pause_pct);
  return {
    enabled: Boolean(row?.enabled),
    enabledAt: row?.enabled_at ?? null,
    feeAcceptedAt: row?.fee_accepted_at ?? null,
    cardStrategy: normalizeStrategy(row?.card_strategy),
    paypalStrategy: normalizeStrategy(row?.paypal_strategy),
    feePct: effectiveRoutingFeePct(routingFeePct),
    routingFeePct: Number.isFinite(routingFeePct as number) ? routingFeePct : null,
    disputePausePct: Number.isFinite(disputePausePct as number) ? disputePausePct : null,
    disputePausePctEffective: effectiveDisputePausePct(disputePausePct),
  };
}

// Campos do payload que o seller pode ver no histórico. Lista fechada: o log é
// compartilhado com o CRM e pode guardar coisa que não é para o painel.
const HISTORY_DETAIL_KEYS = [
  'enabled', 'card_strategy', 'paypal_strategy', 'routing_fee_pct', 'dispute_pause_pct',
  'label', 'weight', 'priority', 'daily_cap_usd_cents', 'daily_cap_orders',
  'min_ticket_usd_cents', 'max_ticket_usd_cents', 'countries', 'currencies', 'paused_at', 'pause_reason',
  'warmup_started_at', 'warmup_days', 'warmup_start_orders', 'warmup_start_usd_cents', 'warmup_growth_pct',
  'warmup_max_ticket_usd_cents',
  'reason', 'disputes_7d', 'approved_7d', 'limit_pct', 'provider', 'mode', 'amount_cents', 'currency', 'routing', 'hostname',
] as const;

export function historyDetails(payload: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of HISTORY_DETAIL_KEYS) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
}

function parsePct(raw: unknown, opts: { min: number; max: number; label: string }): number | null {
  if (raw === null || raw === '') return null;
  const value = typeof raw === 'string' ? Number(raw.replace(',', '.')) : Number(raw);
  if (!Number.isFinite(value) || value < opts.min || value > opts.max) {
    throw new BadRequestException(`${opts.label}: use um valor entre ${opts.min} e ${opts.max} (ou vazio para o padrão).`);
  }
  return Math.round(value * 10000) / 10000;
}
