import { Injectable } from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';
import { CryptoService } from '../../crypto/crypto.service';
import { ProviderAccountConfig } from '../provider-accounts.config';

// ============================================================================
// WHOP ACCOUNTS — pool dinâmico (tabela `whop_accounts`)
// ----------------------------------------------------------------------------
// Os demais providers vivem em provider-accounts.config.ts porque são 1 conta
// cada, com credencial no env. A Whop é o caso oposto: N companies independentes
// que entram e saem do pool por decisão operacional. Fixar isso em código faria
// "pausar a conta 7" custar um deploy — que é justamente o que não pode custar.
//
// O serviço devolve as contas já no formato ProviderAccountConfig, então o
// AccountRouterService não precisa saber que essas vieram do banco.
//
// ── MODO ENV (atual) ─────────────────────────────────────────────────────────
// Com WHOP_API_KEY no env, a conta é UMA e vem do env — a tabela é ignorada no
// roteamento. A company sai de WHOP_COMPANY_ID ou, sem ela, da própria chave
// (GET /api/v5/company). O segredo do webhook é WHOP_WEBHOOK_SECRET: a API da
// Whop NÃO devolve o segredo de um webhook já criado, então ele tem que vir do
// painel (ou de quem criou o webhook).
//
// ⚠️ O id `whop_main` vai no metadata `koopfy_account_id` de cada sessão e volta
// no webhook. Renomear deixa os pagamentos em aberto sem conta pra confirmar.
// ============================================================================

export const WHOP_API_URL_DEFAULT = 'https://api.whop.com';

export const WHOP_ENV_ACCOUNT_ID = 'whop_main';

export interface WhopAccountRow {
  id: string;
  label: string | null;
  company_id: string;
  product_id: string | null;
  api_url: string | null;
  api_key: string;
  webhook_secret: string | null;
  webhook_id: string | null;
  status: string;
  weight: number | null;
  supported_methods: string[] | null;
  currency: string | null;
  countries: string[] | null;
  country: string | null;
  daily_cap_amount: number | null;
  min_ticket: number | null;
  max_ticket: number | null;
  cooldown_until: string | null;
  legal_name: string | null;
  descriptor: string | null;
  metadata: Record<string, any> | null;
}

const SELECT_COLUMNS =
  'id, label, company_id, product_id, api_url, api_key, webhook_secret, webhook_id, ' +
  'status, weight, supported_methods, currency, countries, country, ' +
  'daily_cap_amount, min_ticket, max_ticket, cooldown_until, legal_name, descriptor, metadata';

@Injectable()
export class WhopAccountsService {
  constructor(private readonly crypto: CryptoService) { }

  private cache: ProviderAccountConfig[] | null = null;
  private hydratedAt = 0;

  private readonly CACHE_TTL_MS = 30 * 1000;

  // ─────────────────────────────────────────────
  // Pool ativo (com cache curto — mesmo TTL das métricas do router)
  // ─────────────────────────────────────────────

  async listActive(): Promise<ProviderAccountConfig[]> {
    if (this.envApiKey()) {
      const envAccount = await this.getEnvAccount();
      return envAccount ? [envAccount] : [];
    }

    const fresh = this.cache && Date.now() - this.hydratedAt < this.CACHE_TTL_MS;
    if (fresh) return this.cache!;

    const { data, error } = await supabase
      .from('whop_accounts')
      .select(SELECT_COLUMNS)
      .eq('status', 'active');

    if (error) {
      // A tabela faltando é um caso à parte: não é instabilidade, é migration
      // que não rodou — e o sintoma que chega ao seller ("nenhuma conta
      // disponível") não sugere isso em nada. Vale gritar diferente.
      if (/relation .* does not exist|schema cache/i.test(error.message)) {
        console.error(
          '[WhopAccounts] tabela `whop_accounts` NÃO EXISTE. Rode a migration '
          + 'apps/pay/supabase_whop_accounts_migration.sql — sem ela nenhum '
          + 'pagamento Whop sai do lugar.',
        );
      } else {
        console.error('[WhopAccounts] listActive error:', error.message);
      }
      // Cache velho é melhor que pool vazio: pool vazio derruba TODO pagamento
      // Whop até o Supabase voltar. Sem cache anterior, aí sim devolve vazio.
      return this.cache ?? [];
    }

    const mapped = (data ?? []).map(row => this.toProviderAccount(row as unknown as WhopAccountRow));

    this.cache = mapped;
    this.hydratedAt = Date.now();
    return mapped;
  }

  // ─────────────────────────────────────────────
  // Busca por id — SEM filtro de status.
  //
  // O webhook de uma conta pausada/desativada continua chegando (e precisa ser
  // processado: é dinheiro que já entrou). Filtrar por status aqui faria a
  // transação ficar pendente pra sempre quando a conta saísse do pool entre o
  // checkout e o pagamento.
  // ─────────────────────────────────────────────

  async getById(id: string): Promise<ProviderAccountConfig | null> {
    if (id === WHOP_ENV_ACCOUNT_ID) return this.getEnvAccount();

    const cached = this.cache?.find(a => a.id === id);
    if (cached && Date.now() - this.hydratedAt < this.CACHE_TTL_MS) return cached;

    const { data, error } = await supabase
      .from('whop_accounts')
      .select(SELECT_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[WhopAccounts] getById error:', error.message);
      return cached ?? null;
    }
    if (!data) return null;

    return this.toProviderAccount(data as unknown as WhopAccountRow);
  }

  // Segredo do webhook em claro, resolvido por conta. Só o handler do webhook usa.
  async getWebhookSecret(id: string): Promise<string | null> {
    const account = await this.getById(id);
    const secret = account?.config?.webhook_secret;
    return typeof secret === 'string' && secret.length > 0 ? secret : null;
  }

  invalidate() {
    this.cache = null;
    this.hydratedAt = 0;
  }

  // ─────────────────────────────────────────────
  // Conta do env
  //
  // Montada uma vez por processo: nada nela muda sem restart (env), e a única
  // parte cara — descobrir a company pela chave — não pode rodar a cada
  // pagamento. Falha nessa descoberta NÃO fica cacheada: a próxima compra tenta
  // de novo, em vez de o processo passar o dia sem Whop por um soluço de rede.
  // ─────────────────────────────────────────────

  private envAccount: ProviderAccountConfig | null = null;
  private envCompany: Promise<{ id: string; title: string | null } | null> | null = null;

  private envApiKey(): string | undefined {
    return process.env.WHOP_API_KEY?.trim() || undefined;
  }

  private async getEnvAccount(): Promise<ProviderAccountConfig | null> {
    if (this.envAccount) return this.envAccount;

    const apiKey = this.envApiKey();
    if (!apiKey) return null;

    const apiUrl = process.env.WHOP_API_URL?.trim() || WHOP_API_URL_DEFAULT;
    const company = await this.resolveEnvCompany(apiKey, apiUrl);
    if (!company) return null;

    const webhookSecret = process.env.WHOP_WEBHOOK_SECRET?.trim() || undefined;
    if (!webhookSecret) {
      // Não bloqueia a cobrança (o embed abre e o comprador paga), mas o webhook
      // é recusado — pagamento aprovado na Whop fica pendente aqui até o
      // segredo entrar no env e a Whop reentregar.
      console.error(
        '[WhopAccounts] WHOP_WEBHOOK_SECRET ausente. Pagamentos Whop vão ser COBRADOS '
        + 'e NÃO vão confirmar: o webhook é recusado sem segredo. Pegue o segredo do '
        + `webhook ${process.env.PAY_PUBLIC_URL ?? 'https://api.koopfy.com/pay'}/webhook/whop no painel da Whop.`,
      );
    }

    this.envAccount = {
      id: WHOP_ENV_ACCOUNT_ID,
      provider: 'whop',
      status: 'active',
      weight: 1,
      // 'all', não 'card': o supportsMethod do router é estrito, e com UMA conta
      // o filtro não escolhe entre contas — só barraria Pix/iDEAL antes de chegar
      // à Whop. Quem decide o método de fato é o embed.
      supported_methods: ['all'],
      api_url: apiUrl,
      apiKey,
      config: {
        company_id: company.id,
        product_id: process.env.WHOP_PRODUCT_ID?.trim() || null,
        webhook_secret: webhookSecret,
        legal_name: process.env.WHOP_LEGAL_NAME?.trim() || null,
        label: company.title,
      },
    };

    console.log(`[WhopAccounts] conta do env ativa: ${WHOP_ENV_ACCOUNT_ID} → ${company.id} (${company.title ?? 'sem título'})`);
    return this.envAccount;
  }

  private resolveEnvCompany(apiKey: string, apiUrl: string) {
    const fromEnv = process.env.WHOP_COMPANY_ID?.trim();
    if (fromEnv) return Promise.resolve({ id: fromEnv, title: null });

    if (!this.envCompany) {
      this.envCompany = fetch(`${apiUrl}/api/v5/company`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      })
        .then(async res => {
          const json: any = await res.json().catch(() => ({}));
          if (!res.ok || !json?.id) {
            throw new Error(json?.error?.message ?? json?.message ?? `Whop HTTP ${res.status}`);
          }
          return { id: String(json.id), title: (json.title as string | undefined) ?? null };
        })
        .catch((err: any) => {
          console.error(
            '[WhopAccounts] não foi possível descobrir a company da WHOP_API_KEY '
            + '(defina WHOP_COMPANY_ID pra pular esta chamada):', err?.message,
          );
          this.envCompany = null;
          return null;
        });
    }
    return this.envCompany;
  }

  // ─────────────────────────────────────────────
  // Row → ProviderAccountConfig
  // ─────────────────────────────────────────────

  private toProviderAccount(row: WhopAccountRow): ProviderAccountConfig {
    return {
      id: row.id,
      provider: 'whop',
      status: row.status === 'active' ? 'active' : 'inactive',
      weight: Number(row.weight ?? 1),
      supported_methods: row.supported_methods?.length ? row.supported_methods : ['card'],
      countries: row.countries ?? undefined,
      country: row.country ?? undefined,
      api_url: row.api_url ?? WHOP_API_URL_DEFAULT,
      // A credencial global do serviço tem precedência quando configurada.
      // Mantemos a chave da conta como fallback para não quebrar ambientes que
      // ainda operam o pool Whop com uma credencial por company.
      apiKey: process.env.WHOP_API_KEY?.trim()
        || this.reveal(row.api_key, `${row.id}.api_key`),

      daily_cap_amount: row.daily_cap_amount ?? undefined,
      min_ticket: row.min_ticket ?? undefined,
      max_ticket: row.max_ticket ?? undefined,
      cooldown_until: row.cooldown_until ?? undefined,

      config: {
        company_id: row.company_id,
        product_id: row.product_id,
        webhook_secret: this.reveal(row.webhook_secret, `${row.id}.webhook_secret`),
        webhook_id: row.webhook_id,
        currency: row.currency,
        legal_name: row.legal_name,
        descriptor: row.descriptor,
        label: row.label,
        ...(row.metadata ?? {}),
      },
    };
  }

  // ─────────────────────────────────────────────
  // Decrypt tolerante
  //
  // CryptoService grava `iv:tag:content` (3 blocos hex). Qualquer outra coisa é
  // tratada como texto puro — permite seed manual da primeira conta sem ter que
  // rodar o encrypt antes. Em produção, grave sempre cifrado.
  // ─────────────────────────────────────────────

  private reveal(value: string | null, label: string): string | undefined {
    if (!value) return undefined;

    const parts = value.split(':');
    const looksEncrypted =
      parts.length === 3 && parts.every(p => /^[0-9a-f]+$/i.test(p) && p.length > 0);

    if (!looksEncrypted) {
      console.warn(`[WhopAccounts] ${label} em texto puro — cifre com CryptoService.`);
      return value;
    }

    try {
      return this.crypto.decrypt(value);
    } catch (err: any) {
      console.error(`[WhopAccounts] falha ao decifrar ${label}:`, err?.message);
      return undefined;
    }
  }
}
