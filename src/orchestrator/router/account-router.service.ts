import { Injectable, OnModuleInit } from '@nestjs/common';
import { PaymentContext } from '../payment-context.interface';
import { supabase } from '../../lib/supabase.client';
import { CryptoService } from '../../crypto/crypto.service';
import { SetinelGateProvider } from '../providers/setinel-gate.provider';
import { ApproveblyProvider } from '../providers/approvebly.provider';
import { CoinflowProvider } from '../providers/coinflow.provider';
import { SimulatorProvider } from '../providers/simulator.provider';
import { RoxPayProvider } from '../providers/rox-pay.provider';
import { WhopProvider } from '../providers/whop.provider';
import { StripeProvider } from '../providers/stripe.provider';
import { ClipProvider } from '../providers/clip.provider';
import { WhopAccountsService } from '../whop/whop-accounts.service';
import { StripeAccountsService } from '../stripe/stripe-accounts.service';
import { ClipAccountsService } from '../clip/clip-accounts.service';
import { StripeRiskService } from '../stripe/stripe-risk.service';
import { buildFailoverOrder } from './failover.config';
import {
  PROVIDER_ACCOUNTS,
  getProviderAccountById,
  getActiveProviderAccounts,
  ProviderName,
} from '../provider-accounts.config';

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

type ProviderType = ProviderName;

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
  // Verticais atendidas (ECOMMERCE | INFO | NUTRA). Vazio = todas.
  segments?: string[];
  min_amount?: number;
  max_amount?: number;

  // Tetos de roteamento — em CENTAVOS DE USD (unidade de
  // account_daily_metrics.volume). Ver provider-accounts.config.ts.
  daily_cap_amount?: number;
  min_ticket?: number;
  max_ticket?: number;
  cooldown_until?: string;

  api_url?: string;
  apiKey?: string;
  apiSecret?: string;
  mbwayApiKey?: string;
  mid?: string;

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
    // Comprador BR → conta com settlement no BR. Além do custo (cross-border
    // cobra taxa extra e converte pior), é o que faz o descriptor aparecer em
    // português na fatura — e descriptor que o comprador não reconhece é a
    // causa nº1 da disputa que mais pesa na review da Stripe.
    BR: 'BR',
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
  constructor(
    private readonly cryptoService: CryptoService,
    private readonly whopAccounts: WhopAccountsService,
    private readonly stripeAccounts: StripeAccountsService,
    private readonly stripeRisk: StripeRiskService,
    private readonly clipAccounts: ClipAccountsService,
  ) { }

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
      case 'setinel_gate':
        return new SetinelGateProvider();
      case 'approvebly':
        return new ApproveblyProvider();
      case 'coinflow':
        return new CoinflowProvider();
      case 'simulator':
        return new SimulatorProvider();
      case 'rox_pay':
        return new RoxPayProvider();
      case 'whop':
        return new WhopProvider();
      case 'stripe':
        // Recebe o StripeRiskService porque a política de 3DS depende do tier
        // de risco da conta — ver requestThreeDSecure.
        return new StripeProvider(this.stripeRisk);
      case 'clip':
        // Sem dependências: o teto do Clip é reserva no banco (gw_hold_card),
        // resolvida ANTES de o formulário de cartão existir — não há decisão de
        // roteamento a tomar no momento da cobrança.
        return new ClipProvider();
      default:
        throw new Error(`Unknown provider: "${provider}"`);
    }
  }

  // ─────────────────────────────────────────────
  // LOAD ACCOUNTS
  //
  // Três origens, mesma forma (ProviderAccountConfig):
  //   • config in-project    → 1 conta por provider, credencial no env
  //   • tabela whop_accounts → N companies independentes, pausáveis sem deploy
  //   • tabela stripe_accounts → N titulares independentes, idem
  //
  // Falha de leitura de um pool NÃO derruba os outros: cada catch devolve o que
  // conseguiu. O contrário (deixar a exception subir) faria um hiccup do
  // Supabase bloquear pagamento de todo mundo — inclusive de quem não usa o
  // pool que falhou.
  //
  // Os dois pools são carregados em PARALELO: são round-trips independentes e
  // serializá-los soma latência no caminho quente de todo pagamento.
  // ─────────────────────────────────────────────

  async getAccounts(): Promise<ProviderAccount[]> {
    const stat = getActiveProviderAccounts() as unknown as ProviderAccount[];

    const [whop, stripe, clip] = await Promise.all([
      this.whopAccounts.listActive().catch((err: any) => {
        console.error('[AccountRouter] falha ao carregar pool Whop:', err?.message);
        return [];
      }),
      this.stripeAccounts.listActive().catch((err: any) => {
        console.error('[AccountRouter] falha ao carregar pool Stripe:', err?.message);
        return [];
      }),
      this.clipAccounts.listActive().catch((err: any) => {
        console.error('[AccountRouter] falha ao carregar pool Clip:', err?.message);
        return [];
      }),
    ]);

    return [
      ...stat,
      ...(whop as unknown as ProviderAccount[]),
      ...(stripe as unknown as ProviderAccount[]),
      ...(clip as unknown as ProviderAccount[]),
    ];
  }

  // ─────────────────────────────────────────────
  // Resolve conta por id — estática OU dinâmica.
  //
  // getProviderAccountById() só enxerga a config in-project. Toda leitura por
  // id que possa cair numa conta Whop (execução e webhook) tem que passar por
  // aqui, senão o pagamento morre com "Provider account not found".
  // ─────────────────────────────────────────────

  async resolveAccountById(id: string): Promise<ProviderAccount | null> {
    const fromConfig = getProviderAccountById(id);
    if (fromConfig) return fromConfig as unknown as ProviderAccount;

    const fromWhop = await this.whopAccounts.getById(id);
    if (fromWhop) return fromWhop as unknown as ProviderAccount;

    // Nem listActive nem getById do Stripe filtram por quarentena aqui de
    // propósito: webhook e reembolso de conta quarentenada continuam chegando,
    // e é dinheiro que já entrou. Quem barra a conta é o POOL, não este lookup.
    const fromStripe = await this.stripeAccounts.getById(id);
    if (fromStripe) return fromStripe as unknown as ProviderAccount;

    // Idem para a Clip: webhook e polling de 3DS de uma conta pausada continuam
    // chegando, e é dinheiro que já entrou. getById não filtra por status.
    const fromClip = await this.clipAccounts.getById(id);
    return (fromClip as unknown as ProviderAccount) ?? null;
  }

  // ─────────────────────────────────────────────
  // SENTINEL MIDs — credenciais por MID
  //
  // Cada MID do Sentinel tem suas credenciais (cartão + MB Way). O seller
  // aponta pra um MID (seller_profiles.provider_mid); aqui resolvemos as
  // credenciais ativas daquele MID. Null = seller usa o env default.
  // ─────────────────────────────────────────────

  async getSentinelMidCredentials(mid?: string | null): Promise<{
    apiKey: string;
    apiSecret: string;
    mbwayApiKey?: string;
    api_url?: string;
    mid: string;
  } | null> {
    if (!mid) return null;

    const { data, error } = await supabase
      .from('sentinel_mids')
      .select('mid, api_key, api_secret, mbway_api_key, api_url, status')
      .eq('mid', mid)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      console.error('[AccountRouter] getSentinelMidCredentials error:', error.message);
      return null;
    }
    if (!data) return null;

    return {
      mid: data.mid,
      apiKey: data.api_key,
      apiSecret: data.api_secret,
      mbwayApiKey: data.mbway_api_key ?? undefined,
      api_url: data.api_url ?? undefined,
    };
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
    if (!this.withinCooldown(acc)) return false;
    if (!this.withinTicketRange(acc, ctx.amountUsdCents)) return false;
    return true;
  }

  // ─────────────────────────────────────────────
  // LAYER 1b — TETOS
  //
  // O balanceamento por déficit distribui volume, mas conta de checkout
  // hospedado (Whop) não quebra por desbalanceamento: quebra por volume
  // absoluto e por ticket fora do padrão dela. São filtros DUROS, não pesos.
  //
  // ⚠️ Todos em centavos de USD — a unidade de account_daily_metrics.volume.
  // O ticket só é comparado quando o caller manda `amountUsdCents` (campo
  // separado de `amount`, que vem na moeda da transação). Um caller que não
  // converte não tem teto de ticket aplicado — e o log abaixo diz isso em voz
  // alta, porque teto que não pega em silêncio é pior do que teto nenhum.
  // ─────────────────────────────────────────────

  // ─────────────────────────────────────────────
  // LAYER 1c — SEGMENTAÇÃO (vertical e nível de risco)
  //
  // ⚠️ ESTES FILTROS SÃO O QUE FAZ O POOL SER UM POOL. Sem eles, "uma conta por
  // titular" é só N chaves girando sobre o mesmo negócio — o volume de NUTRA
  // cai na conta de e-commerce, contamina o histórico dela, e a Stripe vê uma
  // operação só (que é o que ela é, nesse caso).
  //
  // Eram aplicados apenas em matchesContext, que serve rankCandidates. O
  // caminho que roda em TODO pagamento é o getAccountByProvider, e ele não
  // chamava nenhum dos dois: as colunas existiam e não pegavam.
  //
  // Ausente (null/vazio) = sem restrição. É o que mantém compatível quem já
  // estava no ar: conta sem `segments` continua atendendo tudo.
  // ─────────────────────────────────────────────

  private matchesSegment(acc: ProviderAccount, segment?: string | null): boolean {
    if (!acc.segments?.length) return true;
    if (!segment) {
      // Conta declarou segmento e o contexto não trouxe: recusar bloquearia
      // pagamento legítimo de oferta sem classificação; aceitar em silêncio
      // furaria o isolamento. Aceita e denuncia — a correção é classificar a
      // oferta (offers.segment), não afrouxar a conta.
      console.warn(
        `[AccountRouter] ${acc.id} restringe segmento a [${acc.segments.join(', ')}] mas a `
        + 'oferta não tem `segment` — isolamento NÃO aplicado nesta decisão.',
      );
      return true;
    }
    return acc.segments.map(x => x.toUpperCase()).includes(segment.toUpperCase());
  }

  private matchesRiskLevel(acc: ProviderAccount, riskLevel?: string | null): boolean {
    if (!acc.risk_levels?.length) return true;
    if (!riskLevel) return true;
    return acc.risk_levels.map(r => r.toUpperCase()).includes(riskLevel.toUpperCase());
  }

  private withinCooldown(acc: ProviderAccount): boolean {
    if (!acc.cooldown_until) return true;

    const until = Date.parse(acc.cooldown_until);
    if (Number.isNaN(until)) return true;

    if (until > Date.now()) {
      console.log(`[AccountRouter] ${acc.id} em cooldown até ${acc.cooldown_until}`);
      return false;
    }
    return true;
  }

  private withinTicketRange(acc: ProviderAccount, amountUsdCents?: number): boolean {
    const hasCap = acc.min_ticket != null || acc.max_ticket != null;
    if (!hasCap) return true;

    if (amountUsdCents == null || !Number.isFinite(amountUsdCents)) {
      console.warn(
        `[AccountRouter] ${acc.id} tem teto de ticket mas o contexto não trouxe ` +
        `amountUsdCents — teto NÃO aplicado nesta decisão.`,
      );
      return true;
    }

    if (acc.min_ticket != null && amountUsdCents < acc.min_ticket) return false;
    if (acc.max_ticket != null && amountUsdCents > acc.max_ticket) return false;
    return true;
  }

  private withinDailyCap(acc: ProviderAccount, metrics: Map<string, DailyMetric>): boolean {
    if (acc.daily_cap_amount == null) return true;

    const volume = metrics.get(acc.id)?.volume ?? 0;
    if (volume >= acc.daily_cap_amount) {
      console.log(
        `[AccountRouter] ${acc.id} atingiu o teto diário ` +
        `(${volume}/${acc.daily_cap_amount} USD cents) — fora do pool hoje`,
      );
      return false;
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
    const matched = accounts.filter(
      acc => this.matchesContext(acc, ctx) && this.isHealthy(acc),
    );

    if (matched.length === 0) return [];

    const metricsAll = await this.hydrateMany(matched.map(a => a.id));

    // Teto diário depende das métricas — filtra depois de hidratar.
    const eligible = matched.filter(acc => this.withinDailyCap(acc, metricsAll));
    if (eligible.length === 0) return [];

    // O déficit é calculado APENAS entre as contas que sobraram (`eligible`):
    // manter as estouradas no cálculo inflaria o volume total e distorceria o
    // share ideal de quem ainda está no pool.
    return eligible
      .map(acc => ({
        id: acc.id,
        provider: this.getProviderInstance(acc.provider),
        secretKey: null,
        deficit: this.computeDeficit(acc, eligible, metricsAll),
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
    credentialsOverride,
  }: {
    providerAccountId: string;
    dto: any;
    transactionId: string;
    // Credenciais resolvidas por MID (Sentinel) — sobrescrevem as do env.
    credentialsOverride?: {
      apiKey?: string;
      apiSecret?: string;
      mbwayApiKey?: string;
      api_url?: string;
      mid?: string;
      // Store Reference por seller (Rox Pay) — ver payments.service.ts.
      storeReference?: string;
    };
  }) {
    // Config in-project OU pool dinâmico (Whop) — ver resolveAccountById.
    const account = await this.resolveAccountById(providerAccountId);

    if (!account) throw new Error('Provider account not found');
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
              apiKey: credentialsOverride?.apiKey ?? account.apiKey,
              apiSecret: credentialsOverride?.apiSecret ?? account.apiSecret,
              mbwayApiKey: credentialsOverride?.mbwayApiKey ?? account.mbwayApiKey,
              mid: credentialsOverride?.mid ?? account.mid,
              api_url: credentialsOverride?.api_url ?? account.api_url,
              storeReference: credentialsOverride?.storeReference,
              // Teto da conta (null = sem teto). O provider usa como última
              // checagem quando o router não teve amountUsdCents pra filtrar.
              max_ticket: account.max_ticket ?? null,
              config:  account.config ?? account.metadata ?? {},
            },
          }),
        10000,
      );

      if (result.success) {
        this.resetHealth(account.id);
      } else if (this.isAccountLevelFailure(result)) {
        this.markSoftFailure(account.id);
      } else {
        // Recusa do EMISSOR não é falha da conta. Sem esta distinção, três
        // cartões sem limite em sequência abriam o circuit breaker e tiravam
        // do pool uma conta perfeitamente saudável — no exato momento de pico
        // em que mais recusas acontecem. Ver StripeProvider.mapError.
        console.log(
          `[AccountRouter] ${account.id}: falha do instrumento `
          + `(${result.failureCode ?? 'sem código'}) — não conta para a saúde da conta`,
        );
      }

      return { ...result, accountId: account.id };
    } catch (err) {
      this.markHardFailure(account.id);
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // Falha da CONTA vs falha do INSTRUMENTO
  //
  // Providers que classificam mandam `data.accountLevel`. Os que não classificam
  // (Sentinel, Coinflow, Rox Pay, Whop) caem no default `true`, que preserva o
  // comportamento anterior — este método não muda a saúde de ninguém que já
  // estava funcionando.
  // ─────────────────────────────────────────────

  private isAccountLevelFailure(result: any): boolean {
    const flag = result?.data?.accountLevel;
    return typeof flag === 'boolean' ? flag : true;
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
    // Vertical da oferta (ECOMMERCE | INFO | NUTRA) e nível de risco do seller.
    // São os eixos de ISOLAMENTO entre titulares — ver LAYER 1c.
    segment?: string | null;
    riskLevel?: string | null;
    // Ticket em centavos de USD — necessário pros tetos min/max_ticket.
    // Ausente = tetos de ticket não se aplicam (compat com os callers antigos).
    amountUsdCents?: number;
    // Pedido (external_reference). Quando presente, o pool é ignorado se este
    // pedido JÁ tem conta — ver resolveStickyAccountId.
    orderRef?: string | null;
  }): Promise<ProviderAccount | null> {
    // ── Whop em modo conectado ──
    // Seller com conta conectada ativa cobra SÓ nela: nem sticky, nem pool.
    // Com a conta fora do ar, o WhopConnectService decide: 'master' (fallback
    // de até 72h, segue para o pool abaixo) ou 'blocked' (reserva acionada,
    // fallback cortado no CRM ou janela vencida).
    if (args.provider.toLowerCase() === 'whop') {
      const routing = await this.whopAccounts.resolveSellerRouting(args.sellerId);
      if (routing.mode === 'connected') return routing.account as unknown as ProviderAccount;
      if (routing.mode === 'blocked') {
        console.warn(`[AccountRouter] Whop bloqueada para o seller ${args.sellerId}: ${routing.reason}`);
        return null;
      }
    }

    const accounts = await this.getAccounts();

    // ── Stickiness por pedido ──
    // Toda tentativa/complemento do mesmo pedido tem que cair na MESMA conta.
    // Com titulares independentes (caso da Whop), reembolso parcial atravessando
    // duas contas é insolúvel: o saldo está em CNPJs diferentes. A rotação
    // acontece ENTRE pedidos, nunca dentro de um.
    if (args.orderRef) {
      const stickyId = await this.resolveStickyAccountId({
        sellerId: args.sellerId,
        provider: args.provider,
        orderRef: args.orderRef,
      });

      if (stickyId) {
        const sticky = accounts.find(a => a.id === stickyId)
          ?? await this.resolveAccountById(stickyId);

        if (sticky && sticky.status === 'active') {
          console.log(`[AccountRouter] sticky ${args.provider}: ${args.orderRef} → ${stickyId}`);
          return sticky;
        }

        // Conta ficou inativa entre uma tentativa e outra: seguir preso a ela
        // travaria o pedido. Cai pro pool — e o reembolso desse pedido passa a
        // exigir atenção manual, por isso o warn.
        console.warn(
          `[AccountRouter] sticky ${stickyId} indisponível para o pedido ` +
          `${args.orderRef} — roteando para outra conta (atenção no refund)`,
        );
      }
    }

    const basePool = accounts.filter(acc =>
      String(acc.provider).toLowerCase() === args.provider.toLowerCase()
      && this.isHealthy(acc)
      && this.withinCooldown(acc)
      && this.withinTicketRange(acc, args.amountUsdCents)
      // Isolamento por vertical e por nível de risco. Ver o bloco LAYER 1c:
      // estavam definidos e não eram aplicados neste caminho, que é o que roda
      // em todo pagamento.
      && this.matchesSegment(acc, args.segment)
      && this.matchesRiskLevel(acc, args.riskLevel),
    );

    if (basePool.length === 0) return null;

    // ── Aplica priorização por país, se houver regra ──
    const pool = this.applyCountryPriority({
      provider:        args.provider,
      customerCountry: args.customerCountry,
      basePool,
    });

    const metrics = await this.hydrateMany(pool.map(a => a.id));

    // Teto diário: filtro duro, aplicado depois de hidratar as métricas.
    const capped = pool.filter(acc => this.withinDailyCap(acc, metrics));
    if (capped.length === 0) return null;

    if (capped.length === 1) return capped[0];

    // Balanceamento por déficit diário entre o subset filtrado
    const ranked = capped
      .map(acc => ({
        acc,
        deficit: this.computeDeficit(acc, capped, metrics),
        tiebreaker: Math.random(),
      }))
      .sort((a, b) => {
        if (b.deficit !== a.deficit) return b.deficit - a.deficit;
        return b.tiebreaker - a.tiebreaker;
      });

    return ranked[0].acc;
  }

  // ─────────────────────────────────────────────
  // 🎯 FAILOVER CROSS-PSP — resolveWithFailover
  //
  // Percorre a cadeia do método (ver failover.config.ts) até achar uma conta
  // elegível. É o que impede que a restrição de um PSP inteiro pare a operação:
  // getAccountByProvider sozinho devolve null e o pagamento morre ali.
  //
  // ⚠️ STICKINESS VEM ANTES DE TUDO. Se este pedido já tocou uma conta — de
  // QUALQUER provider — ele volta para ela. Com titulares independentes,
  // reembolso parcial atravessando dois PSPs não tem solução: o saldo está em
  // entidades jurídicas diferentes. A troca acontece ENTRE pedidos.
  //
  // Devolve também `degraded`: true quando não foi o provider preferido. O
  // caller precisa disso para decidir o que renderizar (métodos disponíveis
  // mudam com o PSP) e para o alerta — cair no failover em silêncio é como
  // descobrir semanas depois que o preferido está fora do ar desde sempre.
  // ─────────────────────────────────────────────

  async resolveWithFailover(args: {
    sellerId: string;
    preferredProvider?: string | null;
    method?: string;
    customerCountry?: string;
    segment?: string | null;
    riskLevel?: string | null;
    amountUsdCents?: number;
    orderRef?: string | null;
  }): Promise<{
    account: ProviderAccount;
    provider: string;
    degraded: boolean;
    attempted: string[];
  } | null> {
    // ── 0. Whop em modo conectado ──
    // Seller isolado numa conta conectada e bloqueado lá não vende por outro
    // PSP: o failover levaria o risco dele para um pool compartilhado — o
    // contágio que a conta conectada existe para evitar.
    const whopRouting = await this.whopAccounts.resolveSellerRouting(args.sellerId);
    if (whopRouting.mode === 'blocked') {
      console.error(
        `[AccountRouter] 🚫 seller ${args.sellerId}: conta conectada da Whop bloqueada `
        + `(${whopRouting.reason}) — pagamento recusado, sem failover`,
      );
      return null;
    }

    // ── 1. Stickiness cross-provider ──
    if (args.orderRef) {
      const sticky = await this.resolveStickyAccountAnyProvider({
        sellerId: args.sellerId,
        orderRef: args.orderRef,
      });

      if (sticky) {
        const account = await this.resolveAccountById(sticky.accountId);
        // Pedido que começou na master antes de o seller entrar no modo
        // conectado não volta para a master. Cai no aviso abaixo (atenção no
        // reembolso) e segue para a conta conectada.
        const leavesConnectedAccount = whopRouting.mode === 'connected'
          && String(account?.provider) === 'whop'
          && account?.id !== whopRouting.account.id;
        if (account && account.status === 'active' && !leavesConnectedAccount) {
          console.log(
            `[AccountRouter] sticky cross-PSP: pedido ${args.orderRef} → `
            + `${sticky.provider}/${sticky.accountId}`,
          );
          return {
            account,
            provider: String(account.provider),
            degraded: false,
            attempted: [String(account.provider)],
          };
        }

        // A conta saiu do ar entre uma tentativa e outra (quarentena, pausa).
        // Seguir preso a ela travaria o pedido; soltar significa que um
        // eventual reembolso desse pedido vai precisar de atenção manual.
        console.warn(
          `[AccountRouter] conta sticky ${sticky.accountId} indisponível para o pedido `
          + `${args.orderRef} — seguindo para o failover (ATENÇÃO no reembolso: `
          + 'o pedido pode acabar dividido entre dois titulares)',
        );
      }
    }

    // ── 2. Cadeia ──
    const chain = buildFailoverOrder({
      preferred: args.preferredProvider,
      method: args.method,
    });

    const attempted: string[] = [];

    for (const provider of chain) {
      attempted.push(provider);

      const account = await this.getAccountByProvider({
        sellerId: args.sellerId,
        provider,
        customerCountry: args.customerCountry,
        segment: args.segment,
        riskLevel: args.riskLevel,
        amountUsdCents: args.amountUsdCents,
        // orderRef já foi tratado acima, cross-provider. Passar de novo faria
        // getAccountByProvider repetir a consulta a cada elo da cadeia.
        orderRef: null,
      });

      if (!account) continue;

      const degraded = attempted.length > 1;

      if (degraded) {
        // O diagnóstico é best-effort e vai num try: já temos conta, e deixar
        // uma consulta de LOG derrubar um pagamento que ia dar certo seria o
        // pior desfecho possível deste método.
        let motivo = 'não apurado';
        try {
          motivo = await this.explainEmptyPool({
            provider: chain[0],
            amountUsdCents: args.amountUsdCents,
            segment: args.segment,
            riskLevel: args.riskLevel,
          });
        } catch (err: any) {
          console.error('[AccountRouter] explainEmptyPool falhou no failover:', err?.message);
        }

        console.error(
          `[AccountRouter] ⚠️ FAILOVER: ${attempted.slice(0, -1).join(' → ')} sem conta elegível, `
          + `pagamento roteado para ${provider}/${account.id}. Motivo do preferido: ${motivo}`,
        );
      }

      return { account, provider, degraded, attempted };
    }

    console.error(
      `[AccountRouter] 🚨 CADEIA ESGOTADA para method=${args.method ?? 'any'}: `
      + `${attempted.join(' → ')} — nenhum PSP com conta elegível. `
      + 'Nenhum pagamento deste método sai até alguém agir.',
    );
    return null;
  }

  // ─────────────────────────────────────────────
  // STICKINESS CROSS-PROVIDER
  //
  // Igual ao resolveStickyAccountId, sem o filtro de provider — porque com
  // failover o pedido pode ter começado em qualquer PSP. Não olha o status da
  // transação de propósito: uma tentativa recusada ainda "reserva" a conta,
  // senão o retry cairia em outro titular.
  // ─────────────────────────────────────────────

  async resolveStickyAccountAnyProvider(args: {
    sellerId: string;
    orderRef: string;
  }): Promise<{ accountId: string; provider: string } | null> {
    const { data, error } = await supabase
      .from('transactions')
      .select('provider_account_id, provider')
      .eq('seller_id', args.sellerId)
      .eq('external_reference', args.orderRef)
      .not('provider_account_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[AccountRouter] resolveStickyAccountAnyProvider error:', error.message);
      return null;
    }
    if (!data?.provider_account_id) return null;

    return {
      accountId: String(data.provider_account_id),
      provider: String(data.provider ?? ''),
    };
  }

  // ─────────────────────────────────────────────
  // DIAGNÓSTICO — por que o pool ficou vazio?
  //
  // getAccountByProvider devolve null por SEIS motivos diferentes, e o caller só
  // consegue dizer "nenhuma conta disponível". Com o pool da Whop isso é
  // especialmente ruim: "não cadastrei", "cadastrei mas não ativei" e "bateu o
  // teto do dia" exigem ações opostas e davam exatamente a mesma mensagem.
  //
  // Roda SÓ no caminho de erro — nenhum custo no fluxo feliz.
  // ─────────────────────────────────────────────

  async explainEmptyPool(args: {
    provider: string;
    amountUsdCents?: number;
    segment?: string | null;
    riskLevel?: string | null;
  }): Promise<string> {
    const accounts = await this.getAccounts();
    const ofProvider = accounts.filter(
      a => String(a.provider).toLowerCase() === args.provider.toLowerCase(),
    );

    if (ofProvider.length === 0) {
      // Stripe some do pool por QUARENTENA (decisão do sistema), e o pool já a
      // filtrou no banco — então "0 contas" aqui pode significar "todas foram
      // restringidas", que é o oposto de "não cadastrei". Confundir os dois no
      // dia do ban custa horas.
      if (args.provider === 'stripe') return this.explainEmptyStripePool();

      return args.provider === 'whop'
        ? 'nenhuma conta Whop no pool — cadastre em Administração → Contas Whop. '
          + '(Se você já cadastrou, procure "[WhopAccounts] listActive error" nos logs: '
          + 'normalmente é a migration supabase_whop_accounts_migration.sql que não rodou.)'
        : 'nenhuma conta ativa configurada para este provider';
    }

    const inactive = ofProvider.filter(a => a.status !== 'active');
    if (inactive.length === ofProvider.length) {
      return `${ofProvider.length} conta(s) cadastrada(s), todas INATIVAS — ative no CRM. `
        + '(Contas provisionadas entram inativas de propósito.)';
    }

    const active = ofProvider.filter(a => a.status === 'active');

    const cooling = active.filter(a => !this.withinCooldown(a));
    const unhealthy = active.filter(a => this.withinCooldown(a) && !this.isHealthy(a));
    const offTicket = active.filter(
      a => this.withinCooldown(a) && this.isHealthy(a)
        && !this.withinTicketRange(a, args.amountUsdCents),
    );

    // Isolamento é a causa NOVA de pool vazio, e a mais confusa: a conta está
    // ativa, saudável, dentro do teto — e mesmo assim não recebe, porque não
    // atende aquela vertical. Sem aparecer aqui, o sintoma é indistinguível de
    // "não tenho conta".
    const offSegment = active.filter(
      a => this.withinCooldown(a) && this.isHealthy(a)
        && this.withinTicketRange(a, args.amountUsdCents)
        && !this.matchesSegment(a, args.segment),
    );
    const offRisk = active.filter(
      a => this.withinCooldown(a) && this.isHealthy(a)
        && this.withinTicketRange(a, args.amountUsdCents)
        && this.matchesSegment(a, args.segment)
        && !this.matchesRiskLevel(a, args.riskLevel),
    );

    const survivors = active.filter(
      a => this.withinCooldown(a) && this.isHealthy(a)
        && this.withinTicketRange(a, args.amountUsdCents)
        && this.matchesSegment(a, args.segment)
        && this.matchesRiskLevel(a, args.riskLevel),
    );

    if (survivors.length === 0) {
      const partes = [
        cooling.length ? `${cooling.length} em cooldown` : null,
        unhealthy.length ? `${unhealthy.length} em circuit breaker (falhas seguidas)` : null,
        offTicket.length
          ? `${offTicket.length} fora da faixa de ticket (${args.amountUsdCents ?? '?'} USD cents)`
          : null,
        offSegment.length
          ? `${offSegment.length} não atende(m) o segmento "${args.segment ?? 'não informado'}" `
            + `(${offSegment.map(a => `${a.id}:[${(a.segments ?? []).join('|')}]`).join(', ')})`
          : null,
        offRisk.length
          ? `${offRisk.length} não atende(m) o nível de risco "${args.riskLevel ?? 'não informado'}"`
          : null,
      ].filter(Boolean);
      return `${active.length} conta(s) ativa(s), nenhuma elegível: ${partes.join(', ')}`;
    }

    // Sobrou gente nos filtros duros → só pode ter sido o teto diário.
    const metrics = await this.hydrateMany(survivors.map(a => a.id));
    const capped = survivors.filter(a => !this.withinDailyCap(a, metrics));

    if (capped.length === survivors.length) {
      const detalhe = capped
        .map(a => `${a.id}: ${metrics.get(a.id)?.volume ?? 0}/${a.daily_cap_amount}`)
        .join(', ');
      return `${capped.length} conta(s) elegível(is), todas com o TETO DIÁRIO atingido `
        + `(USD cents — ${detalhe}). Aumente o teto ou adicione conta ao pool.`;
    }

    return 'nenhuma conta elegível (motivo não identificado — ver logs do AccountRouter)';
  }

  // ─────────────────────────────────────────────
  // Por que o pool STRIPE ficou vazio?
  //
  // Três causas com ações opostas e que davam a mesma mensagem:
  //   • nunca cadastrado          → cadastrar
  //   • cadastrado mas inativo    → ativar (contas nascem inativas de propósito)
  //   • quarentenado pelo sistema → NÃO reativar sem resolver com a Stripe;
  //     reativar uma conta restringida é como se ganha o segundo strike
  // ─────────────────────────────────────────────

  private async explainEmptyStripePool(): Promise<string> {
    const rows = await this.stripeAccounts.listOperational();

    if (rows.length === 0) {
      return 'nenhuma conta Stripe cadastrada como ativa. Cadastre em `stripe_accounts` '
        + '(uma linha por titular). Se você já cadastrou, procure '
        + '"[StripeAccounts] listActive error" nos logs — normalmente é a migration '
        + 'supabase_stripe_accounts_migration.sql que não rodou.';
    }

    const quarantined = rows.filter(r => r.quarantined_at);

    if (quarantined.length === rows.length) {
      const detalhe = quarantined
        .map(r => `${r.id} (${r.quarantine_reason ?? 'motivo não registrado'})`)
        .join('; ');
      return `TODAS as ${rows.length} contas Stripe estão em QUARENTENA: ${detalhe}. `
        + 'Isto não se resolve reativando no banco — resolva com a Stripe primeiro. '
        + 'Enquanto isso, o failover cross-PSP deveria estar cobrindo (ver FAILOVER_CHAIN).';
    }

    if (quarantined.length > 0) {
      return `${quarantined.length} de ${rows.length} contas Stripe em quarentena `
        + `(${quarantined.map(r => r.id).join(', ')}); as demais não passaram nos filtros `
        + 'de cooldown/ticket/teto diário nesta requisição.';
    }

    return `${rows.length} conta(s) Stripe ativa(s), nenhuma elegível para este contexto `
      + '(método, país, faixa de ticket, cooldown ou teto diário — provavelmente rampa '
      + 'de aquecimento, se as contas são novas). Ver logs do AccountRouter.';
  }

  // ─────────────────────────────────────────────
  // STICKINESS — última conta usada por este pedido neste provider.
  //
  // Lê de `transactions` (índice idx_transactions_whop_sticky). Não olha o
  // status da transação de propósito: uma tentativa recusada ainda "reserva" a
  // conta do pedido, senão um retry cairia em outro titular.
  // ─────────────────────────────────────────────

  async resolveStickyAccountId(args: {
    sellerId: string;
    provider: string;
    orderRef: string;
  }): Promise<string | null> {
    const { data, error } = await supabase
      .from('transactions')
      .select('provider_account_id')
      .eq('seller_id', args.sellerId)
      .eq('external_reference', args.orderRef)
      .eq('provider', args.provider)
      .not('provider_account_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[AccountRouter] resolveStickyAccountId error:', error.message);
      return null;
    }

    return data?.provider_account_id ?? null;
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