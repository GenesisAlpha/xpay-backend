// ============================================================================
// PAYPAL — REST v2 da conta do PRÓPRIO seller
// ----------------------------------------------------------------------------
// Sem SDK: são quatro chamadas (token, criar order, capturar, verificar
// webhook) e o fetch deixa tudo testável sem rede. As credenciais são do app
// que o seller criou em developer.paypal.com — cada conta tem o seu token.
//
// Política (2026-09-16): o nome do produto não sai da Koopfy. A descrição da
// cobrança é `<Loja> · #<pedido>` (maskedPlanTitle) e o que reconcilia a venda
// é o `custom_id` = transactions.id, que volta na captura e no webhook.
// ============================================================================

import { maskedPlanTitle } from '../providers/whop-plan-title';
import { SellerProviderMode, toPaypalValue } from '../seller-provider/seller-provider-accounts';

export const PAYPAL_LIVE_URL = 'https://api-m.paypal.com';
export const PAYPAL_SANDBOX_URL = 'https://api-m.sandbox.paypal.com';

export function paypalBaseUrl(mode: SellerProviderMode | string | null | undefined): string {
  return mode === 'test' ? PAYPAL_SANDBOX_URL : PAYPAL_LIVE_URL;
}

/** Eventos que o webhook criado na conta do seller assina. */
export const PAYPAL_WEBHOOK_EVENTS = [
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'CUSTOMER.DISPUTE.CREATED',
];

// Limite do PayPal para description/invoice_id/custom_id é 127.
const PAYPAL_TEXT_MAX = 127;

export class PaypalApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly issue: string | null,
    readonly body: any,
  ) {
    super(message);
  }
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export interface PaypalCredentials {
  /** Chave do cache: o id da conta no roteador (paypall_…). */
  cacheKey: string;
  clientId: string;
  clientSecret: string;
  mode: SellerProviderMode | string;
}

// ─── Token OAuth (client credentials), um por conta ────────────────────────
//
// O token vale ~9h. Pedir um a cada cobrança dobraria a latência do botão e
// esbarraria no rate limit do app dele. Renova um minuto antes de vencer, para
// nenhuma chamada sair com token expirando no meio do caminho.

const TOKEN_MARGIN_MS = 60 * 1000;

export class PaypalTokenCache {
  private tokens = new Map<string, { token: string; expiresAt: number; fingerprint: string }>();

  constructor(private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init) as any) {}

  async get(creds: PaypalCredentials): Promise<{ token: string; appId: string | null }> {
    // Credencial trocada (reconexão) invalida o token antigo mesmo no prazo.
    const fingerprint = `${creds.mode}:${creds.clientId}:${creds.clientSecret.slice(-6)}`;
    const cached = this.tokens.get(creds.cacheKey);
    if (cached && cached.fingerprint === fingerprint && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) {
      return { token: cached.token, appId: null };
    }

    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    let response;
    try {
      response = await this.fetchImpl(`${paypalBaseUrl(creds.mode)}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
      });
    } catch (err: any) {
      throw new PaypalApiError(`Não foi possível falar com o PayPal (${err?.message ?? 'erro de rede'}).`, 0, null, null);
    }
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok || !json?.access_token) {
      this.tokens.delete(creds.cacheKey);
      throw new PaypalApiError(
        json?.error_description ?? `PayPal recusou as credenciais (HTTP ${response.status}).`,
        response.status,
        json?.error ?? null,
        json,
      );
    }
    const ttlMs = Math.max(0, Number(json.expires_in ?? 0)) * 1000;
    this.tokens.set(creds.cacheKey, { token: json.access_token, expiresAt: Date.now() + ttlMs, fingerprint });
    return { token: json.access_token, appId: json.app_id ?? null };
  }

  invalidate(cacheKey: string) {
    this.tokens.delete(cacheKey);
  }
}

/** Cache do processo: o token é da conta, não da requisição. */
export const paypalTokens = new PaypalTokenCache();

/**
 * Chamada autenticada. Em 401 renova o token uma vez: o PayPal às vezes revoga
 * antes do `expires_in`, e falhar a captura por isso deixaria o comprador com
 * o pagamento aprovado e o pedido em aberto.
 */
export async function paypalCall(
  creds: PaypalCredentials,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  body?: any,
  extraHeaders: Record<string, string> = {},
  cache: PaypalTokenCache = paypalTokens,
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as any,
): Promise<any> {
  const send = async () => {
    const { token } = await cache.get(creds);
    return fetchImpl(`${paypalBaseUrl(creds.mode)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };

  let response = await send();
  if (response.status === 401) {
    cache.invalidate(creds.cacheKey);
    response = await send();
  }
  if (response.status === 204) return {};
  const json: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    const issue = json?.details?.[0]?.issue ?? json?.name ?? null;
    const description = json?.details?.[0]?.description ?? json?.message ?? `PayPal HTTP ${response.status} em ${path}`;
    throw new PaypalApiError(String(description), response.status, issue, json);
  }
  return json;
}

// ─── Order ─────────────────────────────────────────────────────────────────

/**
 * Corpo do `POST /v2/checkout/orders`. `custom_id` é o fio da reconciliação
 * (volta na captura e em todo evento de captura); `invoice_id` é o pedido, que
 * o seller reconhece no painel do PayPal. Nada do catálogo vai junto.
 */
export function buildPaypalOrderPayload(args: {
  transactionId: string;
  orderRef?: string | null;
  storeName?: string | null;
  amountCents: number;
  currency: string;
  invoiceSuffix?: string | null;
}) {
  const currency = String(args.currency ?? '').toUpperCase();
  const orderRef = String(args.orderRef ?? '').trim() || args.transactionId;
  const invoiceId = args.invoiceSuffix ? `${orderRef}-${args.invoiceSuffix}` : orderRef;
  const storeName = String(args.storeName ?? '').trim();
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        custom_id: String(args.transactionId).slice(0, PAYPAL_TEXT_MAX),
        invoice_id: invoiceId.slice(0, PAYPAL_TEXT_MAX),
        description: maskedPlanTitle(storeName, orderRef, PAYPAL_TEXT_MAX),
        amount: {
          currency_code: currency,
          value: toPaypalValue(args.amountCents, currency),
        },
      },
    ],
    // Produto digital na maioria: pedir endereço no PayPal travaria o comprador
    // numa tela que nem usamos. `PAY_NOW` porque a captura é imediata.
    application_context: {
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      ...(storeName ? { brand_name: storeName.slice(0, PAYPAL_TEXT_MAX) } : {}),
    },
  };
}

/** Captura dentro da resposta de `/capture` (ou de `GET /v2/checkout/orders/:id`). */
export function extractPaypalCapture(order: any): {
  orderStatus: string;
  captureId: string | null;
  captureStatus: string | null;
  customId: string | null;
  value: string | null;
  currency: string | null;
  reason: string | null;
} {
  const unit = Array.isArray(order?.purchase_units) ? order.purchase_units[0] : null;
  const capture = Array.isArray(unit?.payments?.captures) ? unit.payments.captures[0] : null;
  return {
    orderStatus: String(order?.status ?? '').toUpperCase(),
    captureId: capture?.id ?? null,
    captureStatus: capture?.status ? String(capture.status).toUpperCase() : null,
    customId: capture?.custom_id ?? unit?.custom_id ?? null,
    value: capture?.amount?.value ?? null,
    currency: capture?.amount?.currency_code ?? null,
    reason: capture?.status_details?.reason ?? null,
  };
}

// ─── Webhook ───────────────────────────────────────────────────────────────

/**
 * Corpo do `POST /v1/notifications/verify-webhook-signature`. O PayPal confere
 * a assinatura com o certificado dele e o webhook_id DESTA conta — um evento
 * assinado para outro webhook (outra conta) volta FAILURE.
 */
export function buildPaypalVerifyRequest(headers: Record<string, any>, webhookId: string, event: any) {
  const h = (name: string) => {
    const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
    return Array.isArray(value) ? String(value[0]) : value != null ? String(value) : '';
  };
  return {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: webhookId,
    webhook_event: event,
  };
}
