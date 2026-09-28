import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';
import { CryptoService } from '../../crypto/crypto.service';
import { ProviderAccountConfig } from '../provider-accounts.config';
import { WhopLinkedAccountRow, linkedChargeBlocker } from '../whop/whop-linked';
import {
  PAYPAL_WEBHOOK_EVENTS,
  PaypalApiError,
  PaypalCredentials,
  PaypalTokenCache,
  buildPaypalVerifyRequest,
  paypalCall,
  paypalTokens,
} from '../paypal/paypal-api';
import {
  OwnProvider,
  SellerProviderAccountRow,
  SellerProviderKind,
  chooseOwnSaleProvider,
  isPaypalOwnAccountId,
  isStripeOwnAccountId,
  normalizeCommissionPct,
  ownProviderConflict,
  providerChargeBlocker,
  rowIdFromOwnAccountId,
  toPaypalOwnAccountId,
  toStripeOwnAccountId,
  validatePaypalCredentials,
  validateStripeKeys,
} from './seller-provider-accounts';

// ============================================================================
// CONTAS STRIPE E PAYPAL PRÓPRIAS DO SELLER (provedor externo)
// ----------------------------------------------------------------------------
// O seller cola as credenciais da conta dele; a Koopfy valida contra o
// provedor, cria o webhook NA CONTA DELE (sem ele a venda nunca confirma) e
// guarda tudo cifrado. Daí em diante o roteador cobra lá.
//
// Segredo NUNCA volta para o browser: só nome, modo e situação.
// ============================================================================

const TABLE = 'seller_provider_accounts';
const LINKED_TABLE = 'whop_linked_accounts';

const STRIPE_API_URL = 'https://api.stripe.com';

/** Eventos do webhook criado na conta Stripe do seller. */
export const STRIPE_OWN_WEBHOOK_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
];

// Mesmo TTL da conta Whop própria: toda cobrança consulta, e uma revogação não
// pode ficar presa no cache por muito tempo.
const CACHE_TTL_MS = 15 * 1000;

// Métodos de quem vende só pela Stripe dele sem aprovação da Koopfy: a lista
// que a Stripe cobre no checkout embedado (Payment Element).
const STRIPE_DEFAULT_METHODS = ['credit_card', 'apple_pay', 'google_pay'];

function payPublicUrl(): string {
  return (process.env.PAY_PUBLIC_URL ?? 'https://api.koopfy.com/pay').replace(/\/+$/, '');
}

export function ownAccountWebhookUrl(accountId: string): string {
  const kind = isPaypalOwnAccountId(accountId) ? 'paypal' : 'stripe';
  return `${payPublicUrl()}/webhook/${kind}/${accountId}`;
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

@Injectable()
export class SellerProviderAccountsService {
  constructor(private readonly crypto: CryptoService) {}

  // Injetáveis nos testes: nada aqui fala com Stripe/PayPal de verdade lá.
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as any;
  paypalTokenCache: PaypalTokenCache = paypalTokens;

  private cache = new Map<string, { row: SellerProviderAccountRow | null; at: number }>();

  async getRow(sellerId: string, provider: SellerProviderKind): Promise<SellerProviderAccountRow | null> {
    const key = `${sellerId}:${provider}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.row;

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('seller_id', sellerId)
      .eq('provider', provider)
      .maybeSingle();
    if (error) {
      // Tabela ausente (migration pendente) não pode derrubar a cobrança.
      console.error('[SellerProviders] leitura da conta:', error.message);
      return null;
    }
    const row = (data as SellerProviderAccountRow) ?? null;
    this.cache.set(key, { row, at: Date.now() });
    return row;
  }

  private forget(sellerId: string, provider: SellerProviderKind) {
    this.cache.delete(`${sellerId}:${provider}`);
  }

  async getRowById(rowId: string): Promise<SellerProviderAccountRow | null> {
    // Id que não é uuid faria o Postgres responder erro de sintaxe: melhor nem ir.
    if (!/^[0-9a-f-]{36}$/i.test(rowId)) return null;
    const { data, error } = await supabase.from(TABLE).select('*').eq('id', rowId).maybeSingle();
    if (error) {
      console.error('[SellerProviders] leitura por id:', error.message);
      return null;
    }
    return (data as SellerProviderAccountRow) ?? null;
  }

  /** Stripe e PayPal do seller, como estão no banco (o service de status traduz). */
  async rows(sellerId: string): Promise<{ stripe: SellerProviderAccountRow | null; paypal: SellerProviderAccountRow | null }> {
    const [stripe, paypal] = await Promise.all([this.getRow(sellerId, 'stripe'), this.getRow(sellerId, 'paypal')]);
    return { stripe, paypal };
  }

  // ─── Conectar ──────────────────────────────────────────────────────────

  /**
   * Liga a Stripe do seller: confere os prefixos, pergunta à Stripe de quem é a
   * chave (GET /v1/account), recusa conta da Koopfy ou de outro seller, cria o
   * webhook na conta dele e guarda tudo cifrado.
   */
  async connectStripe(sellerId: string, input: { secretKey?: string; publishableKey?: string }, actor: string | null = null) {
    let mode: 'live' | 'test';
    try {
      mode = validateStripeKeys(String(input?.secretKey ?? ''), String(input?.publishableKey ?? '')).mode;
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
    const secretKey = String(input.secretKey).trim();
    const publishableKey = String(input.publishableKey).trim();

    await this.assertMayConnect(sellerId, 'stripe');

    const account = await this.stripeRequest(secretKey, 'GET', '/v1/account').catch((err: any) => {
      if (err?.httpStatus === 401 || err?.httpStatus === 403) {
        throw new BadRequestException(
          'A Stripe recusou esta chave. Confira se copiou a Secret key certa e, se for chave restrita, se ela pode ler a conta e gerenciar webhooks.',
        );
      }
      throw new BadRequestException(`Não foi possível validar a chave na Stripe agora (${err?.message ?? 'erro'}).`);
    });
    const accountRef = String(account?.id ?? '').trim();
    if (!accountRef.startsWith('acct_')) throw new BadRequestException('A Stripe não informou a conta desta chave.');

    // Conta do pool da Koopfy: conectar como "própria" tiraria a taxa e a
    // carteira de vendas que são da Koopfy.
    const { data: koopfyAccount } = await supabase
      .from('stripe_accounts')
      .select('id')
      .eq('stripe_account_id', accountRef)
      .maybeSingle();
    if (koopfyAccount) throw new ConflictException('Esta conta Stripe pertence à Koopfy e não pode ser conectada.');

    await this.assertNotTakenByOther(sellerId, 'stripe', accountRef, 'Esta conta Stripe já está conectada em outra conta Koopfy.');

    const current = await this.getRow(sellerId, 'stripe');
    const rowId = current?.id ?? randomUUID();
    const accountId = toStripeOwnAccountId(rowId);
    const webhook = await this.registerStripeWebhook(secretKey, accountId);

    const displayName = account?.settings?.dashboard?.display_name
      ?? account?.business_profile?.name
      ?? account?.email
      ?? accountRef;

    await this.save(sellerId, 'stripe', {
      id: rowId,
      mode,
      account_ref: accountRef,
      display_name: displayName ? String(displayName).slice(0, 120) : null,
      public_key: publishableKey,
      secret_enc: this.crypto.encrypt(secretKey),
      webhook_id: webhook.id,
      webhook_secret_enc: webhook.secret ? this.crypto.encrypt(webhook.secret) : null,
    }, actor);

    await this.prepareExternalOnlySeller(sellerId, STRIPE_DEFAULT_METHODS);
    await this.log(sellerId, actor, 'seller_provider.stripe_connected', { account_ref: accountRef, mode, webhook_id: webhook.id });
    return this.getRow(sellerId, 'stripe');
  }

  /**
   * Liga o PayPal do seller: o token OAuth é a validação (credencial errada
   * não gera token) e o webhook criado no app dele traz reembolso e disputa.
   */
  async connectPaypal(
    sellerId: string,
    input: { clientId?: string; clientSecret?: string; mode?: string },
    actor: string | null = null,
  ) {
    let creds: { clientId: string; clientSecret: string; mode: 'live' | 'test' };
    try {
      creds = validatePaypalCredentials(input ?? {});
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }

    await this.assertMayConnect(sellerId, 'paypal');
    await this.assertNotTakenByOther(sellerId, 'paypal', null, 'Este app do PayPal já está conectado em outra conta Koopfy.', creds.clientId);

    const current = await this.getRow(sellerId, 'paypal');
    const rowId = current?.id ?? randomUUID();
    const accountId = toPaypalOwnAccountId(rowId);
    const paypal: PaypalCredentials = { cacheKey: accountId, ...creds };

    this.paypalTokenCache.invalidate(accountId);
    let appId: string | null = null;
    try {
      appId = (await this.paypalTokenCache.get(paypal)).appId;
    } catch (err: any) {
      if (err instanceof PaypalApiError && (err.httpStatus === 401 || err.httpStatus === 400)) {
        throw new BadRequestException(
          `O PayPal recusou estas credenciais${creds.mode === 'test' ? ' no Sandbox' : ' em produção'}. Confira o Client ID, o Client Secret e o modo escolhido.`,
        );
      }
      throw new BadRequestException(`Não foi possível validar as credenciais no PayPal agora (${err?.message ?? 'erro'}).`);
    }

    const webhookId = await this.registerPaypalWebhook(paypal, accountId);

    await this.save(sellerId, 'paypal', {
      id: rowId,
      mode: creds.mode,
      account_ref: appId,
      display_name: null,
      public_key: creds.clientId,
      secret_enc: this.crypto.encrypt(creds.clientSecret),
      webhook_id: webhookId,
      webhook_secret_enc: null,
    }, actor);

    await this.prepareExternalOnlySeller(sellerId, []);
    await this.log(sellerId, actor, 'seller_provider.paypal_connected', { app_id: appId, mode: creds.mode, webhook_id: webhookId });
    return this.getRow(sellerId, 'paypal');
  }

  /**
   * Desliga a conta. As vendas voltam ao fluxo normal. O webhook na conta
   * dele sai em best effort: se a chave já foi revogada, não há o que fazer
   * lá — e a conexão tem que desligar do mesmo jeito.
   */
  async disconnect(sellerId: string, provider: SellerProviderKind, actor: string | null = null) {
    const row = await this.getRow(sellerId, provider);
    if (!row || row.status === 'disabled') {
      throw new NotFoundException(`Nenhuma conta ${provider === 'stripe' ? 'Stripe' : 'PayPal'} conectada.`);
    }

    const secret = this.decryptOrNull(row.secret_enc);
    if (secret && row.webhook_id) {
      try {
        if (provider === 'stripe') {
          await this.stripeRequest(secret, 'DELETE', `/v1/webhook_endpoints/${encodeURIComponent(row.webhook_id)}`);
        } else {
          await paypalCall(
            this.paypalCredsOf(row, secret),
            'DELETE',
            `/v1/notifications/webhooks/${encodeURIComponent(row.webhook_id)}`,
            undefined,
            {},
            this.paypalTokenCache,
            this.fetchImpl,
          );
        }
      } catch (err: any) {
        console.error(`[SellerProviders] webhook ${provider} de ${sellerId} não removido:`, err?.message);
      }
    }

    const { error } = await supabase
      .from(TABLE)
      .update({ status: 'disabled', updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) throw new BadRequestException(`Não foi possível desligar a conexão: ${error.message}`);

    this.forget(sellerId, provider);
    await this.log(sellerId, actor, `seller_provider.${provider}_disconnected`, {});
    return this.getRow(sellerId, provider);
  }

  // ─── Roteador ──────────────────────────────────────────────────────────

  /** Conta do roteador (`stripel_…`/`paypall_…`), SEM filtro de status: webhook de conta desligada ainda chega. */
  async getProviderAccountById(id: string): Promise<ProviderAccountConfig | null> {
    const rowId = rowIdFromOwnAccountId(id);
    if (!rowId) return null;
    const row = await this.getRowById(rowId);
    if (!row) return null;
    // Prefixo e provedor da linha têm que bater: `stripel_` de uma linha PayPal
    // seria a conta errada validando o evento.
    if ((isStripeOwnAccountId(id) && row.provider !== 'stripe') || (isPaypalOwnAccountId(id) && row.provider !== 'paypal')) {
      return null;
    }
    return this.toProviderAccount(row);
  }

  /** Conta pronta para cobrar, ou null (e a venda não sai por ela). */
  async getChargeableAccount(sellerId: string, provider: SellerProviderKind): Promise<ProviderAccountConfig | null> {
    const row = await this.getRow(sellerId, provider);
    if (!row || providerChargeBlocker(row)) return null;
    return this.toProviderAccount(row);
  }

  private toProviderAccount(row: SellerProviderAccountRow): ProviderAccountConfig | null {
    const secret = this.decryptOrNull(row.secret_enc);
    if (!secret || !row.public_key) return null;
    const status = row.status === 'active' ? 'active' : 'inactive';

    if (row.provider === 'stripe') {
      return {
        id: toStripeOwnAccountId(row.id),
        provider: 'stripe',
        status,
        weight: 1,
        supported_methods: ['all'],
        apiKey: secret,
        config: {
          // Par obrigatório com o client_secret — ver StripeProvider.charge.
          publishable_key: row.public_key,
          webhook_secret: this.decryptOrNull(row.webhook_secret_enc),
          stripe_account_id: row.account_ref,
          // `linked`: sem taxa do seller, sem carteira (o dinheiro é dele) e
          // descrição sem o nome do produto.
          linked: true,
          seller_id: row.seller_id,
          mode: row.mode,
          label: row.display_name,
        },
      };
    }

    return {
      id: toPaypalOwnAccountId(row.id),
      provider: 'paypal',
      status,
      weight: 1,
      supported_methods: ['paypal'],
      // client_id em apiKey e client_secret em apiSecret: é o par que o
      // executeWithProvider repassa ao provider em providerConfig.
      apiKey: row.public_key,
      apiSecret: secret,
      config: {
        client_id: row.public_key,
        mode: row.mode,
        webhook_id: row.webhook_id,
        linked: true,
        seller_id: row.seller_id,
      },
    };
  }

  // ─── Webhook do PayPal ─────────────────────────────────────────────────

  /**
   * Pergunta ao PayPal se o evento é autêntico, com a credencial e o
   * webhook_id DESTA conta. Evento de outra conta (ou forjado) volta FAILURE.
   */
  async verifyPaypalWebhook(account: ProviderAccountConfig, headers: Record<string, any>, event: any): Promise<boolean> {
    const webhookId = account.config?.webhook_id;
    if (!webhookId || !account.apiKey || !account.apiSecret) return false;
    const result = await paypalCall(
      {
        cacheKey: account.id,
        clientId: account.apiKey,
        clientSecret: account.apiSecret,
        mode: account.config?.mode === 'test' ? 'test' : 'live',
      },
      'POST',
      '/v1/notifications/verify-webhook-signature',
      buildPaypalVerifyRequest(headers, String(webhookId), event),
      {},
      this.paypalTokenCache,
      this.fetchImpl,
    );
    return String(result?.verification_status ?? '').toUpperCase() === 'SUCCESS';
  }

  // ─── Internos ──────────────────────────────────────────────────────────

  /**
   * Quem pode conectar: o modo não foi cortado no CRM e a combinação é válida
   * (Whop × Stripe exclusivas; PayPal combina com qualquer uma).
   */
  private async assertMayConnect(sellerId: string, provider: SellerProviderKind) {
    const { data: linked } = await supabase
      .from(LINKED_TABLE)
      .select('status, whop_account_id, api_key, last_error')
      .eq('seller_id', sellerId)
      .maybeSingle();
    if ((linked as any)?.status === 'disabled') {
      throw new BadRequestException('O modo conta externa foi desativado para esta conta. Fale com o atendimento da Koopfy.');
    }
    const conflict = ownProviderConflict(provider, {
      whop: whopLinkedOccupiesCard(linked as any),
      stripe: false,
    });
    if (conflict) throw new ConflictException(conflict);
  }

  private async assertNotTakenByOther(
    sellerId: string,
    provider: SellerProviderKind,
    accountRef: string | null,
    message: string,
    publicKey?: string,
  ) {
    let query = supabase
      .from(TABLE)
      .select('seller_id')
      .eq('provider', provider)
      .neq('seller_id', sellerId)
      .neq('status', 'disabled');
    query = accountRef ? query.eq('account_ref', accountRef) : query.eq('public_key', publicKey ?? '');
    const { data } = await query.limit(1);
    if (Array.isArray(data) && data.length > 0) throw new ConflictException(message);
  }

  private async save(
    sellerId: string,
    provider: SellerProviderKind,
    fields: Partial<SellerProviderAccountRow> & { id: string },
    actor: string | null,
  ) {
    const now = new Date().toISOString();
    const { error } = await supabase.from(TABLE).upsert(
      {
        ...fields,
        seller_id: sellerId,
        provider,
        status: 'active',
        last_error: null,
        last_checked_at: now,
        created_by: actor,
        updated_at: now,
      },
      { onConflict: 'seller_id,provider' },
    );
    if (error) {
      console.error(`[SellerProviders] gravação da conta ${provider}:`, error.message);
      throw new BadRequestException('Não foi possível salvar a conexão agora. Tente novamente.');
    }
    this.forget(sellerId, provider);
  }

  /**
   * Seller que vende só pela conta dele, sem aprovação da Koopfy: os métodos
   * são gravados na aprovação do CRM, que ele não passa. Sem isso o checkout
   * não mostraria o cartão. Seller aprovado mantém o que o CRM definiu.
   */
  private async prepareExternalOnlySeller(sellerId: string, methods: string[]) {
    if (!methods.length) return;
    const { data: seller } = await supabase
      .from('seller_profiles')
      .select('status, enabled_methods')
      .eq('id', sellerId)
      .maybeSingle();
    if (!seller || seller.status === 'active' || (seller.enabled_methods ?? []).length) return;
    const { error } = await supabase.from('seller_profiles').update({ enabled_methods: methods }).eq('id', sellerId);
    if (error) console.error(`[SellerProviders] métodos do seller ${sellerId}:`, error.message);
  }

  /**
   * Webhook na conta Stripe dele, apontando para `/webhook/stripe/stripel_<id>`.
   * Antes apaga os endpoints antigos com a MESMA url (reconexão): cada um tem o
   * seu whsec_, e só o novo fica guardado — o antigo falharia a assinatura em
   * toda entrega e a Stripe reentregaria por dias.
   */
  private async registerStripeWebhook(secretKey: string, accountId: string): Promise<{ id: string | null; secret: string | null }> {
    const url = ownAccountWebhookUrl(accountId);
    try {
      const existing = await this.stripeRequest(secretKey, 'GET', '/v1/webhook_endpoints?limit=100');
      for (const endpoint of Array.isArray(existing?.data) ? existing.data : []) {
        if (endpoint?.url === url && endpoint?.id) {
          await this.stripeRequest(secretKey, 'DELETE', `/v1/webhook_endpoints/${encodeURIComponent(endpoint.id)}`).catch(() => null);
        }
      }
    } catch (err: any) {
      // Listar é faxina: sem permissão para isso, segue e tenta criar.
      console.error('[SellerProviders] listagem de webhooks da Stripe:', err?.message);
    }

    const form = new URLSearchParams();
    form.set('url', url);
    form.set('description', 'Koopfy — confirmação das vendas do checkout');
    for (const event of STRIPE_OWN_WEBHOOK_EVENTS) form.append('enabled_events[]', event);

    try {
      const created = await this.stripeRequest(secretKey, 'POST', '/v1/webhook_endpoints', form);
      if (!created?.secret) throw new Error('a Stripe não devolveu o segredo do webhook');
      return { id: created.id ?? null, secret: created.secret };
    } catch (err: any) {
      throw new BadRequestException(
        `Não foi possível criar o webhook na sua conta Stripe (${err?.message ?? 'erro'}). `
        + 'Se a chave for restrita, ela precisa de permissão de escrita em Webhook Endpoints.',
      );
    }
  }

  /** Webhook no app PayPal dele, apontando para `/webhook/paypal/paypall_<id>`. */
  private async registerPaypalWebhook(creds: PaypalCredentials, accountId: string): Promise<string> {
    const url = ownAccountWebhookUrl(accountId);
    const call = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: any) =>
      paypalCall(creds, method, path, body, {}, this.paypalTokenCache, this.fetchImpl);

    // Reconexão: o PayPal recusa url repetida no mesmo app (WEBHOOK_URL_ALREADY_EXISTS).
    try {
      const existing = await call('GET', '/v1/notifications/webhooks');
      for (const hook of Array.isArray(existing?.webhooks) ? existing.webhooks : []) {
        if (hook?.url === url && hook?.id) {
          await call('DELETE', `/v1/notifications/webhooks/${encodeURIComponent(hook.id)}`).catch(() => null);
        }
      }
    } catch (err: any) {
      console.error('[SellerProviders] listagem de webhooks do PayPal:', err?.message);
    }

    try {
      const created = await call('POST', '/v1/notifications/webhooks', {
        url,
        event_types: PAYPAL_WEBHOOK_EVENTS.map(name => ({ name })),
      });
      if (!created?.id) throw new Error('o PayPal não devolveu o id do webhook');
      return String(created.id);
    } catch (err: any) {
      throw new BadRequestException(`Não foi possível criar o webhook no seu app PayPal (${err?.message ?? 'erro'}).`);
    }
  }

  private async stripeRequest(secretKey: string, method: 'GET' | 'POST' | 'DELETE', path: string, form?: URLSearchParams) {
    let response;
    try {
      response = await this.fetchImpl(`${STRIPE_API_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Accept: 'application/json',
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(form ? { body: form.toString() } : {}),
      });
    } catch (err: any) {
      throw Object.assign(new Error(err?.message ?? 'erro de rede'), { httpStatus: 0 });
    }
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(json?.error?.message ?? `Stripe HTTP ${response.status}`), { httpStatus: response.status });
    }
    return json;
  }

  private paypalCredsOf(row: SellerProviderAccountRow, secret: string): PaypalCredentials {
    return {
      cacheKey: toPaypalOwnAccountId(row.id),
      clientId: String(row.public_key),
      clientSecret: secret,
      mode: row.mode,
    };
  }

  private decryptOrNull(value: string | null): string | undefined {
    if (!value) return undefined;
    try {
      return this.crypto.decrypt(value);
    } catch (err: any) {
      console.error('[SellerProviders] segredo indecifrável:', err?.message);
      return undefined;
    }
  }

  private async log(sellerId: string, managerId: string | null, action: string, payload: Record<string, any>) {
    const { error } = await supabase.from('crm_action_log').insert({
      seller_id: sellerId,
      manager_id: managerId,
      action,
      resource_type: 'seller',
      resource_id: sellerId,
      payload,
      created_at: new Date().toISOString(),
    });
    if (error) console.error(`[SellerProviders] ação ${action} não registrada:`, error.message);
  }
}

// ─── Atalhos sem DI (caminho da venda, guards) ───────────────────────────────
//
// O serviço de pagamentos decide as taxas ANTES de resolver a conta no router,
// e os guards rodam fora do contexto de injeção — por isso consultas diretas.

/** A Whop própria ocupa o "lugar do cartão"? Conectada (ativa ou com chave recusada). */
export function whopLinkedOccupiesCard(row: Pick<WhopLinkedAccountRow, 'status' | 'whop_account_id' | 'api_key'> | null): boolean {
  if (!row?.whop_account_id || !row.api_key) return false;
  return row.status === 'active' || row.status === 'invalid';
}

/** A Stripe própria ocupa o "lugar do cartão"? Conectada (ativa ou com chave recusada). */
export function stripeOwnOccupiesCard(row: Pick<SellerProviderAccountRow, 'status' | 'secret_enc'> | null): boolean {
  if (!row?.secret_enc) return false;
  return row.status === 'active' || row.status === 'invalid';
}

async function loadSellerProviderRows(sellerId: string): Promise<SellerProviderAccountRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('provider, status, secret_enc, public_key, last_error')
    .eq('seller_id', sellerId);
  if (error) {
    // Migration pendente: sem Stripe/PayPal próprios, o resto segue igual.
    console.error('[SellerProviders] leitura das contas próprias:', error.message);
    return [];
  }
  return (Array.isArray(data) ? data : []) as SellerProviderAccountRow[];
}

async function loadLinkedRow(sellerId: string): Promise<any | null> {
  const { data } = await supabase
    .from(LINKED_TABLE)
    .select('status, whop_account_id, api_key, last_error, commission_pct')
    .eq('seller_id', sellerId)
    .maybeSingle();
  return data ?? null;
}

/** Quais contas próprias estão cobrando agora. */
export async function ownAccountsCharging(sellerId: string): Promise<{ whop: boolean; stripe: boolean; paypal: boolean; commissionPct: number }> {
  const [linked, rows] = await Promise.all([loadLinkedRow(sellerId), loadSellerProviderRows(sellerId)]);
  const charging = (provider: SellerProviderKind) =>
    rows.some(row => row.provider === provider && providerChargeBlocker(row) === null);
  return {
    whop: Boolean(linked) && linkedChargeBlocker(linked as WhopLinkedAccountRow) === null,
    stripe: charging('stripe'),
    paypal: charging('paypal'),
    commissionPct: normalizeCommissionPct(linked?.commission_pct),
  };
}

/**
 * Comissão da Koopfy (%) sobre venda em conta própria: o percentual do CRM
 * (whop_linked_accounts.commission_pct, em qualquer status) ou 3%.
 */
export async function ownAccountCommissionPct(sellerId: string): Promise<number> {
  return normalizeCommissionPct((await loadLinkedRow(sellerId))?.commission_pct);
}

/**
 * A venda sai por uma conta própria do seller? Devolve o provedor e o
 * percentual da comissão, ou null quando segue o fluxo da Koopfy.
 */
export async function resolveOwnSale(args: {
  sellerId: string;
  providerDefault?: string | null;
  method?: string | null;
}): Promise<{ provider: OwnProvider; commissionPct: number } | null> {
  const state = await ownAccountsCharging(args.sellerId);
  const provider = chooseOwnSaleProvider({
    method: args.method,
    providerDefault: args.providerDefault,
    whopCharging: state.whop,
    stripeCharging: state.stripe,
    paypalCharging: state.paypal,
  });
  return provider ? { provider, commissionPct: state.commissionPct } : null;
}

/** Alguma conta própria (Whop, Stripe ou PayPal) cobrando? */
export async function sellerChargesOnAnyOwnAccount(sellerId: string): Promise<boolean> {
  const state = await ownAccountsCharging(sellerId);
  return state.whop || state.stripe || state.paypal;
}

/** Stripe própria conectada? A Whop própria não pode ligar junto. */
export async function sellerHasOwnStripe(sellerId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('status, secret_enc')
    .eq('seller_id', sellerId)
    .eq('provider', 'stripe')
    .maybeSingle();
  if (error) return false;
  return stripeOwnOccupiesCard(data as any);
}
