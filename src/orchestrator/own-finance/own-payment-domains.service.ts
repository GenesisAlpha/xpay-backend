import { BadRequestException, Injectable } from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';
import { ProviderAccountConfig } from '../provider-accounts.config';
import { OwnAccountFinanceService, OwnAccountSummary } from './own-account-finance.service';
import {
  AssociationFile,
  OwnPaymentDomain,
  associationFileOf,
  domainHostname,
  domainItems,
  mapStripeDomain,
  mapWhopDomain,
  platformCheckoutHosts,
  sortDomains,
  supportsPaymentDomains,
} from './own-payment-domains';

// ============================================================================
// DOMÍNIOS DE PAGAMENTO DAS CONTAS PRÓPRIAS
// ----------------------------------------------------------------------------
// Registra o domínio do checkout (e do site do seller) na conta Whop ou Stripe
// DELE, para o Apple Pay e o Google Pay aparecerem. O checkout da Koopfy é
// registrado sozinho assim que a conta conecta; os domínios dele (site com o
// checkout incorporado, domínio próprio do checkout) ele cadastra no painel.
// ============================================================================

const STRIPE_API_URL = 'https://api.stripe.com';
const WHOP_API_URL_DEFAULT = 'https://api.whop.com';
// Mesma versão da API de plataforma: `payment_method_domains` só existe nela.
const WHOP_API_VERSION_DEFAULT = '2026-09-15';
const PROVIDER_TIMEOUT_MS = 12_000;

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export interface OwnPaymentDomainsView {
  account: Pick<OwnAccountSummary, 'id' | 'provider' | 'label' | 'accountName' | 'mode'>;
  /** PayPal não tem carteira por domínio. */
  supported: boolean;
  /** Arquivo que o domínio precisa publicar para o Apple Pay. */
  file: AssociationFile | null;
  /** Domínios do checkout da Koopfy (registrados sozinhos). */
  platformHosts: string[];
  domains: OwnPaymentDomain[];
}

export interface OwnDomainRegistration {
  accountId: string;
  provider: OwnAccountSummary['provider'];
  name: string | null;
  domain: OwnPaymentDomain | null;
  /** Por que não registrou nesta conta. */
  error: string | null;
}

@Injectable()
export class OwnPaymentDomainsService {
  constructor(private readonly finance: OwnAccountFinanceService) {}

  // Injetável nos testes: nada aqui fala com provedor de verdade lá.
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as any;

  /** Domínios registrados na conta, com a situação de cada carteira. */
  async list(sellerId: string, accountId: string): Promise<OwnPaymentDomainsView> {
    const { account, credentials } = await this.finance.resolveAccount(sellerId, accountId);
    const view = this.viewOf(account);
    if (!view.supported) return view;
    return { ...view, domains: sortDomains(await this.read(account.provider, credentials), view.platformHosts) };
  }

  /** Registra o domínio na conta e pede a verificação. Devolve a lista atualizada. */
  async register(sellerId: string, accountId: string, rawHostname: unknown, actor: string | null = null) {
    const { account, credentials } = await this.finance.resolveAccount(sellerId, accountId);
    if (!supportsPaymentDomains(account.provider)) {
      throw new BadRequestException('O PayPal não usa registro de domínio: Apple Pay e Google Pay são das contas Whop e Stripe.');
    }
    let hostname: string;
    try {
      hostname = domainHostname(rawHostname);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }

    let registered: OwnPaymentDomain;
    try {
      registered = await this.ensure(account.provider, credentials, hostname);
    } catch (err: any) {
      throw new BadRequestException(`Não foi possível registrar o domínio (${err?.message ?? 'erro'}).`);
    }
    await this.log(sellerId, actor, { account_id: accountId, provider: account.provider, hostname });

    const view = this.viewOf(account);
    const domains = await this.read(account.provider, credentials).catch(() => [registered]);
    return { ...view, domains: sortDomains(domains, view.platformHosts), registered };
  }

  /**
   * Conta recém-conectada: registra o checkout da Koopfy nela. Nunca lança —
   * a conexão não pode falhar por causa do Apple Pay.
   */
  async registerPlatformHosts(sellerId: string, accountId: string): Promise<void> {
    try {
      const { account, credentials } = await this.finance.resolveAccount(sellerId, accountId);
      if (!supportsPaymentDomains(account.provider)) return;
      for (const hostname of platformCheckoutHosts()) {
        await this.ensure(account.provider, credentials, hostname)
          .catch((err: any) => console.error(`[OwnDomains] ${hostname} em ${accountId}:`, err?.message));
      }
    } catch (err: any) {
      console.error(`[OwnDomains] registro automático em ${accountId}:`, err?.message);
    }
  }

  /** O checkout da Koopfy em todas as contas de cartão do seller (depois de uma conexão). Nunca lança. */
  async registerPlatformHostsEverywhere(sellerId: string): Promise<void> {
    const accounts = await this.finance.accounts(sellerId).catch(() => []);
    for (const account of accounts) {
      if (supportsPaymentDomains(account.provider) && account.status !== 'attention') {
        await this.registerPlatformHosts(sellerId, account.id);
      }
    }
  }

  /**
   * O mesmo domínio em TODAS as contas de cartão do seller (checkout
   * incorporado no site dele: qualquer uma pode cobrar). Cada conta responde
   * por si; uma falha não impede as outras.
   */
  async registerEverywhere(sellerId: string, rawHostname: unknown, opts: { register: boolean } = { register: true }): Promise<OwnDomainRegistration[]> {
    let hostname: string;
    try {
      hostname = domainHostname(rawHostname);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
    const accounts = (await this.finance.accounts(sellerId))
      .filter(account => supportsPaymentDomains(account.provider) && account.status !== 'attention');
    return Promise.all(accounts.map(async account => {
      const base = { accountId: account.id, provider: account.provider, name: account.label ?? account.accountName };
      try {
        const { credentials } = await this.finance.resolveAccount(sellerId, account.id);
        const domain = opts.register
          ? await this.ensure(account.provider, credentials, hostname)
          : (await this.read(account.provider, credentials)).find(item => item.hostname === hostname) ?? null;
        return { ...base, domain, error: null };
      } catch (err: any) {
        return { ...base, domain: null, error: String(err?.message ?? err) };
      }
    }));
  }

  // ─── Por provedor ──────────────────────────────────────────────────────

  private viewOf(account: OwnAccountSummary): OwnPaymentDomainsView {
    return {
      account: {
        id: account.id,
        provider: account.provider,
        label: account.label,
        accountName: account.accountName,
        ...(account.mode ? { mode: account.mode } : {}),
      },
      supported: supportsPaymentDomains(account.provider),
      file: associationFileOf(account.provider),
      platformHosts: platformCheckoutHosts(),
      domains: [],
    };
  }

  private async read(provider: OwnAccountSummary['provider'], account: ProviderAccountConfig): Promise<OwnPaymentDomain[]> {
    if (provider === 'stripe') {
      return domainItems(await this.stripe(account, 'GET', '/v1/payment_method_domains?limit=100')).map(mapStripeDomain);
    }
    return domainItems(await this.whop(account, 'GET', '/api/v1/payment_method_domains?first=100')).map(mapWhopDomain);
  }

  /** Cria o registro se não existe e pede a verificação se ainda não passou. */
  private async ensure(provider: OwnAccountSummary['provider'], account: ProviderAccountConfig, hostname: string): Promise<OwnPaymentDomain> {
    return provider === 'stripe' ? this.ensureStripe(account, hostname) : this.ensureWhop(account, hostname);
  }

  private async ensureStripe(account: ProviderAccountConfig, hostname: string): Promise<OwnPaymentDomain> {
    const existing = domainItems(await this.stripe(
      account, 'GET', `/v1/payment_method_domains?limit=100&domain_name=${encodeURIComponent(hostname)}`,
    )).find(item => String(item?.domain_name ?? '').toLowerCase() === hostname);

    let raw = existing;
    if (!raw) {
      const form = new URLSearchParams();
      form.set('domain_name', hostname);
      raw = await this.stripe(account, 'POST', '/v1/payment_method_domains', form);
    } else if (raw.enabled === false) {
      const form = new URLSearchParams();
      form.set('enabled', 'true');
      raw = await this.stripe(account, 'POST', `/v1/payment_method_domains/${encodeURIComponent(raw.id)}`, form);
    }

    // A Stripe só confere o arquivo do Apple Pay quando pedimos a validação.
    if (raw?.id && mapStripeDomain(raw).applePay !== 'active') {
      raw = await this.stripe(account, 'POST', `/v1/payment_method_domains/${encodeURIComponent(raw.id)}/validate`, new URLSearchParams())
        .catch(() => raw);
    }
    return mapStripeDomain(raw);
  }

  private async ensureWhop(account: ProviderAccountConfig, hostname: string): Promise<OwnPaymentDomain> {
    const find = async () => domainItems(await this.whop(account, 'GET', '/api/v1/payment_method_domains?first=100'))
      .find(item => String(item?.hostname ?? '').toLowerCase() === hostname);

    let raw = await find().catch(() => null);
    if (!raw) {
      try {
        raw = await this.whop(account, 'POST', '/api/v1/payment_method_domains', { hostname });
      } catch (err: any) {
        // Já registrado (corrida, ou cadastrado no painel da Whop): busca de novo.
        raw = await find().catch(() => null);
        if (!raw) throw err;
      }
    }
    if (raw?.id && raw.status !== 'verified') {
      try {
        raw = await this.whop(account, 'POST', `/api/v1/payment_method_domains/${encodeURIComponent(raw.id)}/verify`, {});
      } catch (err: any) {
        // A Whop explica o que falta (arquivo ausente ou diferente): vai para a tela.
        return { ...mapWhopDomain(raw), message: String(err?.message ?? '').trim() || null };
      }
    }
    return mapWhopDomain(raw);
  }

  private async whop(account: ProviderAccountConfig, method: 'GET' | 'POST', path: string, body?: Record<string, any>) {
    const response = await this.send(`${account.api_url ?? WHOP_API_URL_DEFAULT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        Accept: 'application/json',
        'Api-Version-Date': process.env.WHOP_PAYOUTS_API_VERSION?.trim() || WHOP_API_VERSION_DEFAULT,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('a chave da Whop não tem permissão para domínios de pagamento — gere outra com essa permissão e conecte de novo');
      }
      throw new Error(json?.error?.message ?? json?.message ?? `Whop HTTP ${response.status}`);
    }
    return json;
  }

  private async stripe(account: ProviderAccountConfig, method: 'GET' | 'POST', path: string, form?: URLSearchParams) {
    const response = await this.send(`${STRIPE_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        Accept: 'application/json',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: form.toString() } : {}),
    });
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('a chave da Stripe não tem permissão para Payment Method Domains — se for chave restrita, libere a escrita nesse recurso');
      }
      throw new Error(json?.error?.message ?? `Stripe HTTP ${response.status}`);
    }
    return json;
  }

  private async send(url: string, init: any) {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    } catch (err: any) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new Error(timeout ? 'o provedor demorou para responder' : `erro de rede (${err?.message ?? 'sem detalhe'})`);
    }
  }

  private async log(sellerId: string, actor: string | null, payload: Record<string, any>) {
    const { error } = await supabase.from('crm_action_log').insert({
      seller_id: sellerId,
      manager_id: null,
      action: 'own_finance.domain_registered',
      resource_type: 'seller',
      resource_id: sellerId,
      payload: { ...payload, actor },
      created_at: new Date().toISOString(),
    });
    if (error) console.error('[OwnDomains] registro do domínio não gravado no histórico:', error.message);
  }
}
