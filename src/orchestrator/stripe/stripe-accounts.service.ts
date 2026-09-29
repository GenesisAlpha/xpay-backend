import { Injectable, Optional } from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';
import { CryptoService } from '../../crypto/crypto.service';
import { ProviderAccountConfig } from '../provider-accounts.config';
import { SellerProviderAccountsService } from '../seller-provider/seller-provider-accounts.service';
import { isStripeOwnAccountId } from '../seller-provider/seller-provider-accounts';

// ============================================================================
// STRIPE ACCOUNTS — pool dinâmico (tabela `stripe_accounts`)
// ----------------------------------------------------------------------------
// Mesmo desenho do pool Whop: N contas com TITULARES INDEPENDENTES, que entram
// e saem do pool por decisão operacional. Fixar isso em código faria "pausar a
// conta 3" custar um deploy — que é justamente o que não pode custar no dia em
// que a Stripe restringe uma delas.
//
// Duas coisas que a Whop não precisava e aqui são o núcleo:
//
//   • RAMPA DE AQUECIMENTO. Conta nova recebendo volume cheio no dia 1 é o
//     gatilho de review mais previsível que existe. O teto efetivo cresce com
//     os dias desde activated_at — e é aplicado AQUI, sobrescrevendo
//     daily_cap_amount, para que o AccountRouterService não precise saber que
//     rampa existe: o withinDailyCap dele já faz a coisa certa.
//
//   • QUARENTENA ≠ STATUS. `status` é decisão humana (operador pausou);
//     `quarantined_at` é decisão do sistema (probe viu charges_enabled=false,
//     taxa de disputa estourou, chave revogada). Misturar os dois faz o
//     operador reativar uma conta que o probe acabou de derrubar, num laço.
//     listActive() exclui as duas; getById() não exclui nenhuma — webhook de
//     conta quarentenada continua chegando e é dinheiro que já entrou.
// ============================================================================

// Plano padrão da rampa: fração do teto alvo por dias desde a ativação.
//
// Os degraus não são arbitrários — acompanham o ciclo em que a Stripe forma
// opinião sobre a conta. A primeira disputa de uma venda do dia 1 chega por
// volta do dia 20; subir para o teto cheio antes disso é decidir sem dado.
const STRIPE_WARMUP_STEPS: Array<{ untilDay: number; factor: number }> = [
  { untilDay: 3,  factor: 0.10 },
  { untilDay: 7,  factor: 0.25 },
  { untilDay: 14, factor: 0.50 },
  { untilDay: 30, factor: 0.75 },
];

const STRIPE_WARMUP_DEFAULT_DAYS = 30;

export interface StripeAccountRow {
  id: string;
  label: string | null;

  entity: string | null;
  holder_legal_name: string | null;
  holder_document: string | null;
  holder_country: string | null;
  stripe_account_id: string | null;
  country: string | null;
  default_currency: string | null;

  product_url: string | null;
  domain: string | null;
  bank_account_last4: string | null;

  secret_key: string;
  publishable_key: string;
  webhook_secret: string | null;

  status: string;
  weight: number | null;
  supported_methods: string[] | null;
  countries: string[] | null;
  risk_levels: string[] | null;
  segments: string[] | null;
  domains: string[] | null;

  daily_cap_amount: number | null;
  min_ticket: number | null;
  max_ticket: number | null;
  cooldown_until: string | null;

  activated_at: string | null;
  warmup_days: number | null;

  probe_charges_enabled: boolean | null;
  probe_payouts_enabled: boolean | null;
  probe_disabled_reason: string | null;
  probed_at: string | null;

  quarantined_at: string | null;
  quarantine_reason: string | null;

  // Auto-reembolso em Early Fraud Warning — ver StripeEfwService. Opt-in de
  // propósito: devolve dinheiro real sem aprovação humana.
  efw_auto_refund: boolean | null;
  efw_auto_refund_max_usd_cents: number | null;

  // O que foi DECLARADO à Stripe na abertura. Divergir do declarado é a causa
  // nº1 de review — ver StripeRiskService.detectVolumeAnomalies.
  declared_monthly_volume_usd_cents: number | null;
  declared_avg_ticket_usd_cents: number | null;
  declared_mcc: string | null;

  statement_descriptor: string | null;
  descriptor_suffix: string | null;
  support_email: string | null;
  support_phone: string | null;
  support_url: string | null;

  metadata: Record<string, any> | null;
}

const SELECT_COLUMNS =
  'id, label, entity, holder_legal_name, holder_document, holder_country, ' +
  'stripe_account_id, country, default_currency, product_url, domain, bank_account_last4, ' +
  'secret_key, publishable_key, webhook_secret, status, weight, supported_methods, ' +
  'countries, risk_levels, segments, domains, daily_cap_amount, min_ticket, max_ticket, cooldown_until, ' +
  'activated_at, warmup_days, probe_charges_enabled, probe_payouts_enabled, ' +
  'probe_disabled_reason, probed_at, quarantined_at, quarantine_reason, ' +
  'efw_auto_refund, efw_auto_refund_max_usd_cents, ' +
  'declared_monthly_volume_usd_cents, declared_avg_ticket_usd_cents, declared_mcc, ' +
  'statement_descriptor, descriptor_suffix, support_email, support_phone, support_url, metadata';

@Injectable()
export class StripeAccountsService {
  constructor(
    private readonly crypto: CryptoService,
    // Stripe PRÓPRIA do seller ('stripel_…'): mora em seller_provider_accounts,
    // não no pool. Opcional só para os testes que montam o serviço à mão.
    @Optional() private readonly sellerProviders?: SellerProviderAccountsService,
  ) { }

  private cache: ProviderAccountConfig[] | null = null;
  private hydratedAt = 0;

  // Mesmo TTL das métricas do router — o pool e o volume envelhecem juntos.
  private readonly CACHE_TTL_MS = 30 * 1000;

  // ─────────────────────────────────────────────
  // Pool roteável
  //
  // status='active' E sem quarentena. O router NÃO refiltra por status (ver
  // getAccountByProvider), então o filtro tem que ser definitivo aqui.
  // ─────────────────────────────────────────────

  async listActive(): Promise<ProviderAccountConfig[]> {
    const fresh = this.cache && Date.now() - this.hydratedAt < this.CACHE_TTL_MS;
    if (fresh) return this.cache!;

    const { data, error } = await supabase
      .from('stripe_accounts')
      .select(SELECT_COLUMNS)
      .eq('status', 'active')
      .is('quarantined_at', null);

    if (error) {
      // Tabela faltando não é instabilidade — é migration que não rodou. E o
      // sintoma que chega ao seller ("nenhuma conta disponível") não sugere isso
      // em nada. Vale gritar diferente.
      if (/relation .* does not exist|schema cache/i.test(error.message)) {
        console.error(
          '[StripeAccounts] tabela `stripe_accounts` NÃO EXISTE. Rode a migration '
          + 'apps/pay/supabase_stripe_accounts_migration.sql — sem ela nenhum '
          + 'pagamento Stripe sai do lugar.',
        );
      } else {
        console.error('[StripeAccounts] listActive error:', error.message);
      }
      // Cache velho é melhor que pool vazio: pool vazio derruba TODO pagamento
      // Stripe até o Supabase voltar. Sem cache anterior, aí sim devolve vazio.
      return this.cache ?? [];
    }

    const mapped = (data ?? []).map(row =>
      this.toProviderAccount(row as unknown as StripeAccountRow),
    );

    this.cache = mapped;
    this.hydratedAt = Date.now();
    return mapped;
  }

  // ─────────────────────────────────────────────
  // Todas as contas que o operador considera ativas — INCLUSIVE as em
  // quarentena. É o universo do probe: sem isto, uma conta quarentenada nunca
  // seria re-testada e ficaria fora do pool para sempre, mesmo depois de a
  // Stripe liberar.
  // ─────────────────────────────────────────────

  async listOperational(): Promise<StripeAccountRow[]> {
    const { data, error } = await supabase
      .from('stripe_accounts')
      .select(SELECT_COLUMNS)
      .eq('status', 'active');

    if (error) {
      console.error('[StripeAccounts] listOperational error:', error.message);
      return [];
    }
    return (data ?? []) as unknown as StripeAccountRow[];
  }

  // ─────────────────────────────────────────────
  // Busca por id — SEM filtro de status nem de quarentena.
  //
  // O webhook de uma conta pausada/quarentenada continua chegando e precisa ser
  // processado: é dinheiro que já entrou. Filtrar aqui faria a transação ficar
  // pendente para sempre quando a conta saísse do pool entre o checkout e o
  // pagamento — que é exatamente o que acontece num ban.
  // ─────────────────────────────────────────────

  async getById(id: string): Promise<ProviderAccountConfig | null> {
    // Conta do seller: a chave e o whsec_ são dele, guardados cifrados. O
    // webhook /webhook/stripe/stripel_<id> valida com o segredo DESTA conta.
    if (isStripeOwnAccountId(id)) {
      return this.sellerProviders ? this.sellerProviders.getProviderAccountById(id) : null;
    }

    const cached = this.cache?.find(a => a.id === id);
    if (cached && Date.now() - this.hydratedAt < this.CACHE_TTL_MS) return cached;

    const { data, error } = await supabase
      .from('stripe_accounts')
      .select(SELECT_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[StripeAccounts] getById error:', error.message);
      return cached ?? null;
    }
    if (!data) return null;

    return this.toProviderAccount(data as unknown as StripeAccountRow);
  }

  async getRowById(id: string): Promise<StripeAccountRow | null> {
    const { data, error } = await supabase
      .from('stripe_accounts')
      .select(SELECT_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[StripeAccounts] getRowById error:', error.message);
      return null;
    }
    return (data as unknown as StripeAccountRow) ?? null;
  }

  // Segredo do webhook em claro, resolvido por conta. Só o handler usa.
  async getWebhookSecret(id: string): Promise<string | null> {
    const account = await this.getById(id);
    const secret = account?.config?.webhook_secret;
    return typeof secret === 'string' && secret.length > 0 ? secret : null;
  }

  // Secret key em claro. Ponto único de leitura — o provider recebe já resolvida.
  async getSecretKey(id: string): Promise<string | null> {
    const account = await this.getById(id);
    return account?.apiKey ?? null;
  }

  // ─────────────────────────────────────────────
  // QUARENTENA
  //
  // Idempotente de propósito: o probe roda em ciclo e chamaria isto de novo a
  // cada volta para a mesma conta. Só grava se ainda não estiver quarentenada,
  // para não sobrescrever o motivo ORIGINAL (que é o que interessa na
  // investigação) por um sintoma posterior.
  // ─────────────────────────────────────────────

  async quarantine(id: string, reason: string): Promise<void> {
    const { data, error } = await supabase
      .from('stripe_accounts')
      .update({
        quarantined_at: new Date().toISOString(),
        quarantine_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .is('quarantined_at', null)
      .select('id');

    if (error) {
      console.error('[StripeAccounts] quarantine error:', error.message);
      return;
    }

    if (data?.length) {
      console.error(
        `[StripeAccounts] 🚨 QUARENTENA: ${id} saiu do pool — ${reason}. `
        + 'Pedidos já iniciados nesta conta continuam nela (stickiness); '
        + 'pedidos novos vão para as outras contas ou para o failover cross-PSP.',
      );
      this.invalidate();
    }
  }

  // Volta ao pool. Só o probe (ou um operador) chama — nunca automático a
  // partir de "parou de dar erro", que é como uma conta restringida volta a
  // receber volume e leva o segundo strike.
  async release(id: string, reason: string): Promise<void> {
    const { error } = await supabase
      .from('stripe_accounts')
      .update({
        quarantined_at: null,
        quarantine_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      console.error('[StripeAccounts] release error:', error.message);
      return;
    }

    console.log(`[StripeAccounts] ✅ ${id} liberada da quarentena — ${reason}`);
    this.invalidate();
  }

  // Cooldown = pausa temporária sem quarentena. Usado pelo governador de risco
  // para tirar a conta do pool por algumas horas sem marcar o incidente.
  async setCooldown(id: string, until: Date, reason: string): Promise<void> {
    const { error } = await supabase
      .from('stripe_accounts')
      .update({ cooldown_until: until.toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      console.error('[StripeAccounts] setCooldown error:', error.message);
      return;
    }
    console.warn(`[StripeAccounts] ${id} em cooldown até ${until.toISOString()} — ${reason}`);
    this.invalidate();
  }

  async saveProbe(id: string, probe: {
    stripe_account_id?: string | null;
    charges_enabled: boolean | null;
    payouts_enabled: boolean | null;
    disabled_reason: string | null;
    requirements: any;
  }): Promise<void> {
    const patch: Record<string, any> = {
      probe_charges_enabled: probe.charges_enabled,
      probe_payouts_enabled: probe.payouts_enabled,
      probe_disabled_reason: probe.disabled_reason,
      probe_requirements: probe.requirements ?? {},
      probed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (probe.stripe_account_id) patch.stripe_account_id = probe.stripe_account_id;

    const { error } = await supabase.from('stripe_accounts').update(patch).eq('id', id);
    if (error) console.error('[StripeAccounts] saveProbe error:', error.message);
  }

  invalidate() {
    this.cache = null;
    this.hydratedAt = 0;
  }

  // ─────────────────────────────────────────────
  // RAMPA DE AQUECIMENTO
  //
  // Devolve o teto EFETIVO do dia. Aplicado no mapeamento, não no router: o
  // router já sabe respeitar daily_cap_amount, e ensinar rampa a ele
  // significaria mais um conceito atravessando um arquivo de 900 linhas.
  //
  // Sem activated_at ou sem teto alvo, não há rampa — devolve o que veio.
  // ─────────────────────────────────────────────

  private effectiveDailyCap(row: StripeAccountRow): number | undefined {
    const target = row.daily_cap_amount ?? undefined;
    if (target == null) return undefined;
    if (!row.activated_at) return target;

    const activated = Date.parse(row.activated_at);
    if (Number.isNaN(activated)) return target;

    const days = (Date.now() - activated) / 86_400_000;
    const warmupDays = row.warmup_days ?? STRIPE_WARMUP_DEFAULT_DAYS;
    if (days >= warmupDays) return target;

    // Reescala os degraus quando warmup_days é customizado, para que o formato
    // da rampa não mude — só a duração.
    const scale = warmupDays / STRIPE_WARMUP_DEFAULT_DAYS;
    const step = STRIPE_WARMUP_STEPS.find(s => days < s.untilDay * scale);
    const factor = step?.factor ?? 1;

    if (factor >= 1) return target;

    const capped = Math.max(1, Math.floor(target * factor));
    console.log(
      `[StripeAccounts] ${row.id} em aquecimento (dia ${days.toFixed(1)}/${warmupDays}): `
      + `teto ${capped} de ${target} USD cents (${Math.round(factor * 100)}%)`,
    );
    return capped;
  }

  // ─────────────────────────────────────────────
  // Row → ProviderAccountConfig
  // ─────────────────────────────────────────────

  private toProviderAccount(row: StripeAccountRow): ProviderAccountConfig {
    const quarantined = !!row.quarantined_at;

    return {
      id: row.id,
      provider: 'stripe',
      // Quarentena aparece como inativa para quem lê o objeto (CRM, diagnóstico).
      // O pool roteável já a excluiu na query — isto é para o caminho getById.
      status: row.status === 'active' && !quarantined ? 'active' : 'inactive',
      weight: Number(row.weight ?? 1),
      supported_methods: row.supported_methods?.length ? row.supported_methods : ['card'],
      countries: row.countries ?? undefined,
      risk_levels: row.risk_levels ?? undefined,
      segments: row.segments ?? undefined,
      country: row.country ?? undefined,

      // A secret key vive em apiKey — é o campo que executeWithProvider passa
      // para o provider em providerConfig.apiKey.
      apiKey: this.reveal(row.secret_key, `${row.id}.secret_key`),

      daily_cap_amount: this.effectiveDailyCap(row),
      min_ticket: row.min_ticket ?? undefined,
      max_ticket: row.max_ticket ?? undefined,
      cooldown_until: row.cooldown_until ?? undefined,

      config: {
        publishable_key: row.publishable_key,
        webhook_secret: this.reveal(row.webhook_secret, `${row.id}.webhook_secret`),
        stripe_account_id: row.stripe_account_id,
        entity: row.entity,
        holder_legal_name: row.holder_legal_name,
        holder_country: row.holder_country,
        default_currency: row.default_currency,
        statement_descriptor: row.statement_descriptor,
        descriptor_suffix: row.descriptor_suffix,
        support_email: row.support_email,
        support_phone: row.support_phone,
        support_url: row.support_url,
        domain: row.domain,
        domains: row.domains,
        product_url: row.product_url,
        label: row.label,
        quarantined_at: row.quarantined_at,
        quarantine_reason: row.quarantine_reason,
        // Teto alvo, antes da rampa — o efetivo já foi para daily_cap_amount.
        // Guardado aqui porque o diagnóstico precisa dos dois para explicar
        // "por que só passou 10% do que eu configurei".
        target_daily_cap: row.daily_cap_amount,
        ...(row.metadata ?? {}),
      },
    };
  }

  // ─────────────────────────────────────────────
  // Decrypt tolerante — mesmo contrato do pool Whop.
  //
  // CryptoService grava `iv:tag:content` (3 blocos hex). Qualquer outra coisa é
  // tratada como texto puro, o que permite semear a primeira conta à mão. Em
  // produção, grave sempre cifrado: sk_live_ em claro no banco é a credencial
  // que move o dinheiro de um titular real.
  // ─────────────────────────────────────────────

  private reveal(value: string | null, label: string): string | undefined {
    if (!value) return undefined;

    const parts = value.split(':');
    const looksEncrypted =
      parts.length === 3 && parts.every(p => /^[0-9a-f]+$/i.test(p) && p.length > 0);

    if (!looksEncrypted) {
      console.warn(`[StripeAccounts] ${label} em texto puro — cifre com CryptoService.`);
      return value;
    }

    try {
      return this.crypto.decrypt(value);
    } catch (err: any) {
      console.error(`[StripeAccounts] falha ao decifrar ${label}:`, err?.message);
      return undefined;
    }
  }
}
