import { Injectable, OnModuleInit } from '@nestjs/common';
import { PaymentContext } from '../payment-context.interface';
import { StripeProvider } from '../providers/stripe.provider';
import { supabase } from '../../lib/supabase.client';
import { CryptoService } from '../../crypto/crypto.service';
import { SibsProvider } from '../providers/sibs.provider';
import { VivaProvider } from '../providers/viva.provider';
import { StripeCryptoProvider } from '../providers/stripe-crypto.provider';

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

type ProviderType =
  | 'stripe'
  | 'stripe_crypto'
  | 'airwallex'
  | 'sibs'
  | 'viva'
  | 'europago'
  | 'mollie'
  | 'sumup';

type ProviderAccount = {
  id: string;
  seller_id: string;
  provider: ProviderType;
  weight: number;
  supported_methods: string[];
  status: string;

  public_key: string;
  encrypted_secret_key: string;

  // 🆕 Country da conta (ISO-2). No caso da Stripe, é o country da Connected
  // Account / Account.country. Pode estar em coluna raiz ou em metadata.
  country?: string;

  countries?: string[];
  risk_levels?: string[];
  min_amount?: number;
  max_amount?: number;

  config?: Record<string, any>;
  metadata?: Record<string, any>;

  // Acumulados — leitura apenas; updates via RPC.
  total_volume_processed?: number;
  total_paid_count?:       number;
};

// ─────────────────────────────────────────────
// PROVIDER COUNTRY PRIORITY
//
// Quando seller tem múltiplas contas do mesmo provider em países
// diferentes, priorizamos por país do cliente.
//
// Hoje aplicado APENAS pra Stripe (Payment Element) em getAccountByProvider.
// Pra adicionar outro provider, é só estender PROVIDER_COUNTRY_PRIORITY.
//
// Regras Stripe:
//   Cliente PT  → conta com country=PT
//   Cliente US  → conta com country=GB (Stripe usa GB pro Reino Unido)
//
// Comportamento de fallback:
//   - Se houver regra pro país do cliente mas nenhuma conta com o country
//     preferido, cai pro pool completo (não bloqueia o pagamento).
//   - Se houver match, o balanceamento por déficit roda APENAS entre as
//     contas do país preferido (preserva o balanceamento intra-país).
// ─────────────────────────────────────────────

const PROVIDER_COUNTRY_PRIORITY: Record<string, Record<string, string>> = {
  stripe: {
    PT: 'PT',
    US: 'GB',
  },
};

// ─────────────────────────────────────────────
// METRICS
// ─────────────────────────────────────────────

interface DailyMetric {
  volume: number;
  paidCount: number;
  day: string;
  hydratedAt: number;
}

interface HealthMetric {
  recentFails: number;
  lastFailAt: number;
  consecutiveFails: number;
}

@Injectable()
export class AccountRouterService implements OnModuleInit {
  constructor(private readonly cryptoService: CryptoService) { }

  private daily: Map<string, DailyMetric> = new Map();
  private health: Map<string, HealthMetric> = new Map();

  private readonly CACHE_TTL_MS = 30 * 1000;
  private readonly MAX_CONSECUTIVE_FAILS = 3;
  private readonly COOLDOWN_MS = 5 * 60 * 1000;

  onModuleInit() {
    setInterval(() => this.rolloverIfNeeded(), 60 * 1000);
  }

  // ─────────────────────────────────────────────
  // DAY ROLLOVER
  // ─────────────────────────────────────────────

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private rolloverIfNeeded() {
    const today = this.today();
    for (const [id, m] of this.daily.entries()) {
      if (m.day !== today) this.daily.delete(id);
    }
  }

  // ─────────────────────────────────────────────
  // CACHE READ-THROUGH
  // ─────────────────────────────────────────────

  private async getDaily(id: string): Promise<DailyMetric> {
    const today = this.today();
    const cached = this.daily.get(id);

    const fresh = cached
      && cached.day === today
      && Date.now() - cached.hydratedAt < this.CACHE_TTL_MS;

    if (fresh) return cached!;

    return this.hydrateDaily(id, today);
  }

  private async hydrateDaily(accountId: string, day: string): Promise<DailyMetric> {
    const { data, error } = await supabase
      .from('account_daily_metrics')
      .select('volume, paid_count')
      .eq('account_id', accountId)
      .eq('day', day)
      .maybeSingle();

    if (error) {
      console.error('[AccountRouter] hydrateDaily error:', error.message);
      const stale = this.daily.get(accountId);
      return stale ?? { volume: 0, paidCount: 0, day, hydratedAt: Date.now() };
    }

    const metric: DailyMetric = {
      volume: data?.volume ?? 0,
      paidCount: data?.paid_count ?? 0,
      day,
      hydratedAt: Date.now(),
    };

    this.daily.set(accountId, metric);
    return metric;
  }

  private async hydrateMany(ids: string[]): Promise<Map<string, DailyMetric>> {
    const today = this.today();
    const stale: string[] = [];
    const result = new Map<string, DailyMetric>();

    for (const id of ids) {
      const cached = this.daily.get(id);
      if (cached
        && cached.day === today
        && Date.now() - cached.hydratedAt < this.CACHE_TTL_MS) {
        result.set(id, cached);
      } else {
        stale.push(id);
      }
    }

    if (stale.length === 0) return result;

    const { data, error } = await supabase
      .from('account_daily_metrics')
      .select('account_id, volume, paid_count')
      .in('account_id', stale)
      .eq('day', today);

    if (error) {
      console.error('[AccountRouter] hydrateMany error:', error.message);
      for (const id of stale) {
        const fallback = { volume: 0, paidCount: 0, day: today, hydratedAt: Date.now() };
        this.daily.set(id, fallback);
        result.set(id, fallback);
      }
      return result;
    }

    const byId = new Map(data?.map(r => [r.account_id, r]) ?? []);

    for (const id of stale) {
      const row = byId.get(id);
      const metric: DailyMetric = {
        volume: row?.volume ?? 0,
        paidCount: row?.paid_count ?? 0,
        day: today,
        hydratedAt: Date.now(),
      };
      this.daily.set(id, metric);
      result.set(id, metric);
    }

    return result;
  }

  private getHealth(id: string): HealthMetric {
    return (
      this.health.get(id) ?? {
        recentFails: 0,
        lastFailAt: 0,
        consecutiveFails: 0,
      }
    );
  }

  // ─────────────────────────────────────────────
  // PROVIDERS
  // ─────────────────────────────────────────────

  getProviderInstance(provider: string) {
    switch (provider) {
      case 'stripe':
        return new StripeProvider();
      case 'airwallex':
      case 'mollie':
      case 'sumup':
      case 'viva':
        return new VivaProvider();
      case 'sibs':
        return new SibsProvider();
      case 'stripe_crypto':
        return new StripeCryptoProvider();
      case 'europago':
        throw new Error(`Provider "${provider}" not implemented yet.`);
      default:
        throw new Error(`Unknown provider: "${provider}"`);
    }
  }

  // ─────────────────────────────────────────────
  // LOAD ACCOUNTS
  // ─────────────────────────────────────────────

  async getAccounts(): Promise<ProviderAccount[]> {
    const { data, error } = await supabase
      .from('provider_accounts')
      .select('*')
      .eq('status', 'active')
      .eq('environment', 'production');

    if (error) throw new Error(`Failed to load accounts: ${error.message}`);
    return (data as ProviderAccount[]) ?? [];
  }

  // ─────────────────────────────────────────────
  // LAYER 1 — HARD FILTERS
  // ─────────────────────────────────────────────

  private supportsMethod(acc: ProviderAccount, method: string): boolean {
    if (!acc.supported_methods?.length) return false;
    const normalized = acc.supported_methods.map(m => m.toLowerCase());
    if (normalized.includes('all')) return true;
    return normalized.includes(method.toLowerCase());
  }

  private matchesContext(acc: ProviderAccount, ctx: PaymentContext): boolean {
    if (ctx.method && !this.supportsMethod(acc, ctx.method)) return false;
    if (acc.countries?.length && ctx.country) {
      const accCountries = acc.countries.map(c => c.toUpperCase());
      if (!accCountries.includes(ctx.country.toUpperCase())) return false;
    }
    if (acc.risk_levels?.length && ctx.riskLevel) {
      const accLevels = acc.risk_levels.map(r => r.toUpperCase());
      if (!accLevels.includes(ctx.riskLevel.toUpperCase())) return false;
    }
    return true;
  }

  // ─────────────────────────────────────────────
  // LAYER 2 — HEALTH FILTER (circuit breaker)
  // ─────────────────────────────────────────────

  private isHealthy(acc: ProviderAccount): boolean {
    const h = this.getHealth(acc.id);
    if (h.consecutiveFails >= this.MAX_CONSECUTIVE_FAILS) {
      const cooledDown = Date.now() - h.lastFailAt > this.COOLDOWN_MS;
      if (!cooledDown) return false;
      this.health.set(acc.id, { ...h, consecutiveFails: 0 });
    }
    return true;
  }

  // ─────────────────────────────────────────────
  // LAYER 4 — BALANCING (déficit proporcional)
  // ─────────────────────────────────────────────

  private computeDeficit(
    acc: ProviderAccount,
    candidates: ProviderAccount[],
    metrics: Map<string, DailyMetric>,
  ): number {
    const totalWeight = candidates.reduce((s, a) => s + (a.weight || 1), 0);
    const totalVolume = candidates.reduce(
      (s, a) => s + (metrics.get(a.id)?.volume ?? 0),
      0,
    );

    const myShare = (acc.weight || 1) / totalWeight;
    const idealVolume = totalVolume * myShare;
    const actualVolume = metrics.get(acc.id)?.volume ?? 0;

    return idealVolume - actualVolume;
  }

  // ─────────────────────────────────────────────
  // 🎯 ROUTING — PADRÃO (com ou sem method)
  // ─────────────────────────────────────────────

  async getCandidateAccounts(ctx: PaymentContext) {
    const accounts = await this.getAccounts();
    return this.rankCandidates(accounts, ctx);
  }

  // ─────────────────────────────────────────────
  // 🎯 ROUTING — HOSTED-ONLY
  // ─────────────────────────────────────────────

  async getHostedCandidates(
    ctx: PaymentContext & { hostedProviders: string[] },
  ) {
    const accounts = await this.getAccounts();
    const hostedSet = new Set(ctx.hostedProviders.map(p => p.toLowerCase()));

    const hosted = accounts.filter(acc =>
      hostedSet.has(String(acc.provider).toLowerCase()),
    );

    const ctxWithoutMethod = { ...ctx, method: undefined };

    return this.rankCandidates(hosted, ctxWithoutMethod);
  }

  // ─────────────────────────────────────────────
  // Pipeline compartilhado
  // ─────────────────────────────────────────────

  private async rankCandidates(
    accounts: ProviderAccount[],
    ctx: PaymentContext,
  ) {
    const eligible = accounts.filter(
      acc => this.matchesContext(acc, ctx) && this.isHealthy(acc),
    );

    if (eligible.length === 0) return [];

    const metrics = await this.hydrateMany(eligible.map(a => a.id));

    return eligible
      .map(acc => ({
        id: acc.id,
        provider: this.getProviderInstance(acc.provider),
        secretKey: null,
        deficit: this.computeDeficit(acc, eligible, metrics),
        tiebreaker: Math.random(),
      }))
      .sort((a, b) => {
        if (b.deficit !== a.deficit) return b.deficit - a.deficit;
        return b.tiebreaker - a.tiebreaker;
      });
  }

  // ─────────────────────────────────────────────
  // EXECUTION
  // ─────────────────────────────────────────────

  async executeWithProvider({
    providerAccountId,
    dto,
    transactionId,
  }: {
    providerAccountId: string;
    dto: any;
    transactionId: string;
  }) {
    const { data: account, error } = await supabase
      .from('provider_accounts')
      .select('*')
      .eq('id', providerAccountId)
      .single();

    if (error || !account) throw new Error('Provider account not found');
    if (account.status !== 'active') throw new Error('Provider account inactive');

    const provider = this.getProviderInstance(account.provider);

    try {
      const result = await this.withTimeout(
        () =>
          provider.charge({
            ...dto,
            transactionId,
            providerConfig: {
              id: account.id,
              secretKey: null,
              api_url: account.api_url,
              config:    account.metadata ?? {}
            },
          }),
        10000,
      );

      if (result.success) {
        this.resetHealth(account.id);
      } else {
        this.markSoftFailure(account.id);
      }

      return { ...result, accountId: account.id };
    } catch (err) {
      this.markHardFailure(account.id);
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // TIMEOUT
  // ─────────────────────────────────────────────

  async withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`TIMEOUT_${ms}ms`)), ms),
      ),
    ]);
  }

  // ─────────────────────────────────────────────
  // markPaid
  // ─────────────────────────────────────────────

  async markPaid(accountId: string, amount: number) {
    if (amount <= 0) return;

    const day = this.today();

    const { data, error } = await supabase.rpc('increment_account_volume', {
      p_account_id: accountId,
      p_day: day,
      p_amount: amount,
    });

    if (error) {
      console.error('[AccountRouter] markPaid RPC error:', error.message);
      return;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (row) {
      this.daily.set(accountId, {
        volume: Number(row.volume),
        paidCount: Number(row.paid_count),
        day,
        hydratedAt: Date.now(),
      });
    }
  }

  // ─────────────────────────────────────────────
  // FAILURE / HEALTH RECORDING
  // ─────────────────────────────────────────────

  private resetHealth(id: string) {
    const h = this.getHealth(id);
    this.health.set(id, { ...h, consecutiveFails: 0 });
  }

  markSoftFailure(id: string) {
    const h = this.getHealth(id);
    this.health.set(id, {
      recentFails: h.recentFails + 1,
      consecutiveFails: h.consecutiveFails + 1,
      lastFailAt: Date.now(),
    });
  }

  markHardFailure(id: string) {
    const h = this.getHealth(id);
    this.health.set(id, {
      recentFails: h.recentFails + 2,
      consecutiveFails: h.consecutiveFails + 1,
      lastFailAt: Date.now(),
    });
  }

  // ─────────────────────────────────────────────
  // Helper: extrai country (ISO-2) da provider_account
  //
  // Defensivo: aceita em vários lugares. Para Stripe, a fonte oficial é
  // o campo `country` retornado pelo Stripe Account API quando salvamos
  // a conta — costuma ir pra coluna `country` ou pra metadata.country.
  // ─────────────────────────────────────────────

  private extractAccountCountry(acc: ProviderAccount): string | null {
    const raw =
      acc.country
      ?? acc.metadata?.country
      ?? acc.metadata?.account_country
      ?? acc.config?.country
      ?? null;

    return typeof raw === 'string' ? raw.toUpperCase() : null;
  }

  // ─────────────────────────────────────────────
  // 🎯 PROVIDER FIXO — getAccountByProvider
  //
  // Usado quando seller.provider_default está set (stripe, stripe_crypto).
  //
  // NOVO: aceita customerCountry opcional. Quando passado E existe regra
  // em PROVIDER_COUNTRY_PRIORITY[provider][customerCountry], filtra o pool
  // pra apenas contas com country=preferred ANTES do balanceamento por
  // déficit. Se nenhuma conta matchar o preferred, cai pro pool completo
  // (não bloqueia pagamento).
  //
  // Pipeline:
  //   1) Filtra: provider match + seller match + healthy
  //   2) Aplica priorização por país (se houver regra + match)
  //   3) Se 0 → null. Se 1 → atalho.
  //   4) Balanceamento por déficit no subset resultante.
  // ─────────────────────────────────────────────

  async getAccountByProvider(args: {
    sellerId: string;
    provider: string;
    customerCountry?: string;
  }): Promise<ProviderAccount | null> {
    const accounts = await this.getAccounts();

    const basePool = accounts.filter(acc =>
      String(acc.provider).toLowerCase() === args.provider.toLowerCase()
      && this.isHealthy(acc),
    );

    if (basePool.length === 0) return null;

    // ── Aplica priorização por país, se houver regra ──
    const pool = this.applyCountryPriority({
      provider:        args.provider,
      customerCountry: args.customerCountry,
      basePool,
    });

    console.log(pool)
    if (pool.length === 1) return pool[0];

    // Balanceamento por déficit diário entre o subset filtrado
    const metrics = await this.hydrateMany(pool.map(a => a.id));

    const ranked = pool
      .map(acc => ({
        acc,
        deficit: this.computeDeficit(acc, pool, metrics),
        tiebreaker: Math.random(),
      }))
      .sort((a, b) => {
        if (b.deficit !== a.deficit) return b.deficit - a.deficit;
        return b.tiebreaker - a.tiebreaker;
      });

    return ranked[0].acc;
  }

  // ─────────────────────────────────────────────
  // Aplica filtro de país preferido sobre o pool base.
  // Retorna o pool filtrado se houver match, senão o pool original.
  // ─────────────────────────────────────────────

  private applyCountryPriority(args: {
    provider:        string;
    customerCountry?: string;
    basePool:        ProviderAccount[];
  }): ProviderAccount[] {
    const { provider, customerCountry, basePool } = args;

    if (!customerCountry) return basePool;

    const rules = PROVIDER_COUNTRY_PRIORITY[provider.toLowerCase()];
    if (!rules) return basePool;

    const preferredCC = rules[customerCountry.toUpperCase()];
    if (!preferredCC) return basePool;

    const filtered = basePool.filter(
      acc => this.extractAccountCountry(acc) === preferredCC,
    );

    if (filtered.length > 0) {
      console.log(
        `[AccountRouter] country priority match: provider=${provider} ` +
        `customer=${customerCountry} → preferred=${preferredCC} ` +
        `(${filtered.length}/${basePool.length} accounts)`,
      );
      return filtered;
    }

    console.warn(
      `[AccountRouter] country priority miss: provider=${provider} ` +
      `customer=${customerCountry} wanted=${preferredCC} mas seller não tem ` +
      `conta nesse país — fallback pra pool completo (${basePool.length} accounts).`,
    );
    return basePool;
  }
}