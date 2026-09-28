import { ChargeResponse, RetrieveResponse } from './provider.types';

// ============================================================================
// SLASH — Payment Intents + Payment Elements (@slashfi/elements-react)
// Docs: https://docs.slash.com/docs/payments/quickstart
// ----------------------------------------------------------------------------
// O DESENHO EM UMA FRASE: criamos o payment intent no servidor e devolvemos o
// clientSecret; o checkout monta o PaymentElement com ele e confirma no clique.
// Quem aprova é o webhook payments.payment_intent.updated (status succeeded),
// nunca o navegador — `processing` no front só quer dizer "o comprador terminou".
//
// ⚠️ UM INTENT POR VALOR. O clientSecret só vem na resposta do POST; não dá pra
// relê-lo depois. Por isso a chave de idempotência carrega valor e moeda:
//   • mesmo pedido, mesmo total  → a Slash devolve o MESMO intent (e o secret);
//   • total mudou (frete, cupom) → intent novo. O antigo fica `pending` e morre
//     sem cobrar — o front só tem o secret do novo.
// Uma chave fixa por transação faria a Slash recusar o segundo valor ("same key,
// different request body").
//
// ⚠️ RECONCILIAÇÃO. `metadata.koopfy_transaction_id` liga o intent à transação
// daqui e volta em toda leitura. O webhook resolve por ele — é o que faz um
// intent antigo do mesmo pedido ainda achar a transação certa.
//
// Moedas: a Slash aceita só USD e EUR (enum do POST). Travado também no
// payments.service, antes de criar a transação.
// ============================================================================

export const SLASH_CURRENCIES = new Set(['USD', 'EUR']);

// Payment intent → status canônico do pay.
//   pending    → nada pago (ou cartão recusado: volta a pending para nova tentativa)
//   processing → comprador confirmou; liquidação em voo
//   succeeded  → pago (terminal)
//   canceled   → cancelado (terminal)
export function mapSlashIntentStatus(status: unknown): RetrieveResponse['status'] | 'processing' {
  switch (String(status ?? '').toLowerCase()) {
    case 'succeeded': return 'paid';
    case 'canceled':
    case 'cancelled': return 'failed';
    case 'processing': return 'processing';
    case 'pending': return 'pending';
    default: return 'unknown';
  }
}

type SlashConfig = {
  id?: string;
  apiKey?: string;
  api_url?: string;
  config?: Record<string, any>;
};

export class SlashProvider {
  name = 'slash';

  // ─────────────────────────────────────────────
  // CHARGE — cria (ou recupera, pela idempotência) o payment intent
  // ─────────────────────────────────────────────

  async charge(ctx: any): Promise<ChargeResponse> {
    const { transactionId } = ctx;
    const providerConfig: SlashConfig = ctx.providerConfig ?? {};
    const accountId = providerConfig.id ?? 'slash_main';

    if (!providerConfig.apiKey) {
      return this.failure(accountId, transactionId, 'config', 'Slash: SLASH_API_KEY ausente');
    }

    const currency = String(ctx.currency ?? '').toUpperCase();
    if (!SLASH_CURRENCIES.has(currency)) {
      return this.failure(
        accountId, transactionId, 'CURRENCY_NOT_SUPPORTED',
        `Slash: moeda ${currency || '(vazia)'} não suportada (só USD e EUR)`,
        false,
      );
    }

    // `amount` do pay já está em centavos, e USD/EUR têm duas casas.
    const amount = Math.round(Number(ctx.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return this.failure(accountId, transactionId, 'invalid_amount', `Slash: valor inválido (${ctx.amount})`, false);
    }

    // ⚠️ Corpo DETERMINÍSTICO: a Slash amarra a chave ao corpo da primeira
    // chamada. Nada que mude entre duas chamadas do mesmo pedido/valor (nome,
    // endereço, horário) pode entrar aqui — senão o retry é recusado.
    const body = {
      amount,
      currency: currency.toLowerCase(),
      metadata: {
        koopfy_transaction_id: String(transactionId),
        koopfy_account_id: String(accountId),
        koopfy_seller_id: String(ctx.sellerId ?? ''),
        koopfy_order_ref: String(ctx.metadata?.order_number ?? ctx.metadata?.orderId ?? ''),
      },
    };

    const res = await this.request(providerConfig, 'POST', '/payments/payment-intent', body, {
      'X-Idempotency-Key': `koopfy_pi_${transactionId}_${currency.toLowerCase()}_${amount}`,
    });

    if (!res.ok) {
      return this.failure(
        accountId, transactionId,
        res.json?.name ?? res.json?.identifier ?? `http_${res.status}`,
        `Slash: falha ao criar o payment intent (${res.status}) ${this.errorMessage(res.json)}`.trim(),
        // 4xx de valor/moeda é do pedido; o resto (401/403/5xx) é da conta.
        !(res.status === 400 || res.status === 422),
        { http_status: res.status, error: res.json ?? null },
      );
    }

    const intent = res.json?.paymentIntent ?? res.json;
    if (!intent?.id || !intent?.clientSecret) {
      return this.failure(
        accountId, transactionId, 'missing_client_secret',
        'Slash: resposta sem id/clientSecret — o checkout não tem como montar o formulário',
      );
    }

    return {
      success: true,
      // O comprador ainda não digitou o cartão — como no Rox Pay e na Whop, a
      // transação só "conta" (KPI, pendente no painel) quando ele pagar. O
      // checkout refaz esta chamada quando o total ou os dados mudam; com
      // 'pending' cada uma somaria um pendente nas métricas. Quem aprova é o
      // webhook.
      status: 'requires_action',
      provider: this.name,
      accountId,
      transactionId,
      providerTransactionId: intent.id,
      providerStatus: intent.status ?? 'pending',
      clientSecret: intent.clientSecret,
      data: { flow: 'client', cardFlow: 'slash' },
    };
  }

  // ─────────────────────────────────────────────
  // RETRIEVE — estado autoritativo (webhook e conferência)
  // ─────────────────────────────────────────────

  async retrieve(ctx: { providerConfig: SlashConfig; providerTransactionId: string }): Promise<RetrieveResponse> {
    const intent = await this.getPaymentIntent(ctx.providerConfig, ctx.providerTransactionId);
    if (!intent) return { success: false, status: 'unknown' };
    const mapped = mapSlashIntentStatus(intent.status);
    return {
      success: true,
      status: mapped === 'processing' ? 'pending' : mapped,
      providerTransactionId: intent.id,
      method: 'card',
      raw: intent,
    };
  }

  async getPaymentIntent(config: SlashConfig, id: string): Promise<any | null> {
    const res = await this.request(config, 'GET', `/payments/payment-intent/${encodeURIComponent(id)}`);
    if (!res.ok) {
      console.error(`[SlashProvider] GET payment-intent ${id} → ${res.status}`, this.errorMessage(res.json));
      return null;
    }
    return res.json?.paymentIntent ?? res.json ?? null;
  }

  async getRefund(config: SlashConfig, id: string): Promise<any | null> {
    const res = await this.request(config, 'GET', `/payments/refund/${encodeURIComponent(id)}`);
    if (!res.ok) {
      console.error(`[SlashProvider] GET refund ${id} → ${res.status}`, this.errorMessage(res.json));
      return null;
    }
    return res.json?.refund ?? res.json ?? null;
  }

  // Reembolsos do intent. Usado para saber se o total já foi devolvido (parcial
  // não vira `refunded` aqui — ver WebhookService.handleSlashRefund).
  async listRefunds(config: SlashConfig, paymentIntentId: string): Promise<any[] | null> {
    const all: any[] = [];
    let cursor: string | null = null;
    // Poucos reembolsos por intent; o teto só impede laço infinito se a API
    // devolver o mesmo cursor.
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ 'filter:paymentIntentId': paymentIntentId });
      if (cursor) qs.set('cursor', cursor);
      const res = await this.request(config, 'GET', `/payments/refund?${qs.toString()}`);
      if (!res.ok) {
        console.error(`[SlashProvider] GET refunds ${paymentIntentId} → ${res.status}`, this.errorMessage(res.json));
        return null;
      }
      const items = res.json?.items;
      if (!Array.isArray(items)) return null;
      all.push(...items);
      const next = res.json?.metadata?.nextCursor ?? null;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return all;
  }

  // ─────────────────────────────────────────────
  // REFUND — valor na unidade mínima da moeda do intent (a Slash não converte).
  // A contabilidade daqui NÃO muda aqui: entra quando o webhook confirmar
  // (payments.refund.updated → succeeded), mesmo caminho de um estorno feito
  // no painel da Slash.
  // ─────────────────────────────────────────────

  async refund(ctx: {
    providerConfig: SlashConfig;
    providerTransactionId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<{ success: boolean; refundId?: string; status?: string; message?: string }> {
    const amount = Math.round(Number(ctx.amountMinor));
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: 'Slash: valor de reembolso inválido' };
    }
    const res = await this.request(
      ctx.providerConfig, 'POST', '/payments/refund',
      { paymentIntentId: ctx.providerTransactionId, amount },
      { 'X-Idempotency-Key': ctx.idempotencyKey },
    );
    if (!res.ok) {
      return { success: false, message: `Slash: reembolso recusado (${res.status}) ${this.errorMessage(res.json)}`.trim() };
    }
    const refund = res.json?.refund ?? res.json;
    return { success: true, refundId: refund?.id, status: refund?.status };
  }

  // ─────────────────────────────────────────────
  // HTTP
  // ─────────────────────────────────────────────

  private async request(
    config: SlashConfig,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ ok: boolean; status: number; json: any }> {
    const base = (config.api_url || 'https://api.slash.com').replace(/\/+$/, '');
    const headers: Record<string, string> = {
      'X-API-Key': String(config.apiKey ?? ''),
      Accept: 'application/json',
      ...extraHeaders,
    };
    // Chave de usuário atende várias entidades e exige o cabeçalho; a chave da
    // entidade (a recomendada no quickstart) dispensa.
    const legalEntity = config.config?.legal_entity_id;
    if (legalEntity) headers['x-legal-entity'] = String(legalEntity);
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
      return { ok: res.ok, status: res.status, json };
    } catch (err: any) {
      console.error(`[SlashProvider] ${method} ${path} falhou:`, err?.message);
      return { ok: false, status: 0, json: { message: err?.message ?? 'network error' } };
    }
  }

  private errorMessage(json: any): string {
    const msg = json?.message ?? json?.error?.message ?? json?.error;
    return typeof msg === 'string' ? msg.slice(0, 300) : '';
  }

  private failure(
    accountId: string,
    transactionId: string,
    code: string,
    message: string,
    accountLevel = true,
    extra: Record<string, any> = {},
  ): ChargeResponse {
    console.error(`[SlashProvider] ${message}`);
    return {
      success: false,
      status: 'failed',
      provider: this.name,
      accountId,
      transactionId,
      failureCode: code,
      failureMessage: message,
      // Falha de configuração/conta derruba a saúde da conta no router; valor ou
      // moeda inválidos são do pedido e não devem tirar a conta do pool.
      data: { accountLevel, ...extra },
    };
  }
}
