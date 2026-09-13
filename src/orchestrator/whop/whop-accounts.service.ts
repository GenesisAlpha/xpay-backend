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
// ============================================================================

export const WHOP_API_URL_DEFAULT = 'https://api.whop.com';

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
