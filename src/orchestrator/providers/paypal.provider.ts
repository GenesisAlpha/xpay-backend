import { ChargeResponse } from './provider.types';
import {
  PaypalApiError,
  PaypalCredentials,
  buildPaypalOrderPayload,
  extractPaypalCapture,
  paypalCall,
} from '../paypal/paypal-api';

// ============================================================================
// PAYPAL — Orders v2 na conta do PRÓPRIO seller (fluxo client)
// ----------------------------------------------------------------------------
// O DESENHO: o servidor cria a order (intent CAPTURE) e devolve o id; os botões
// do PayPal no navegador abrem a aprovação do comprador; na volta, o checkout
// chama POST /payments/:id/paypal/capture e a captura acontece AQUI, no
// servidor, com a credencial do seller. O cliente nunca cria nem captura order.
//
// ⚠️ IDEMPOTÊNCIA. `PayPal-Request-Id` fixo e derivado da transação: um retry
// de rede depois de o PayPal já ter criado a order devolve A MESMA order, e a
// captura repetida devolve a mesma captura. Nunca torne aleatório.
//
// ⚠️ APROVAÇÃO. charge devolve 'pending' sempre: a order criada não é dinheiro.
// Só a captura COMPLETED (resposta do /capture ou webhook) aprova a transação.
// ============================================================================

export type PaypalCaptureOutcome =
  | { outcome: 'paid'; captureId: string; customId: string | null; value: string | null; currency: string | null; raw: any }
  | { outcome: 'pending'; captureId: string | null; reason: string | null; raw: any }
  | { outcome: 'declined'; code: string; message: string; retryable: boolean; raw: any };

export class PaypalProvider {
  name = 'paypal';

  private credentials(providerConfig: any): PaypalCredentials | null {
    const clientId = providerConfig?.apiKey ?? providerConfig?.config?.client_id;
    const clientSecret = providerConfig?.apiSecret;
    if (!clientId || !clientSecret) return null;
    return {
      cacheKey: String(providerConfig?.id ?? clientId),
      clientId: String(clientId),
      clientSecret: String(clientSecret),
      mode: providerConfig?.config?.mode === 'test' ? 'test' : 'live',
    };
  }

  // ─────────────────────────────────────────────
  // CHARGE — cria a order e devolve o id para os botões do PayPal
  // ─────────────────────────────────────────────

  async charge(ctx: any): Promise<ChargeResponse> {
    const { transactionId, providerConfig } = ctx;
    const accountId = providerConfig?.id ?? 'paypal_unknown';
    const creds = this.credentials(providerConfig);
    if (!creds) {
      return this.failure(accountId, transactionId, 'config', `PayPal: conta ${accountId} sem credencial utilizável`, true);
    }

    const currency = String(ctx.currency ?? '').toUpperCase();
    const amount = Number(ctx.amount);
    if (!currency || !Number.isFinite(amount) || amount <= 0) {
      return this.failure(accountId, transactionId, 'invalid_amount', `PayPal: valor inválido (${ctx.amount} ${currency})`, false);
    }

    const metadata = ctx.metadata ?? {};
    const orderRef = metadata.order_number ?? metadata.orderId ?? ctx.external_reference ?? null;
    const storeName = metadata.store_name ?? metadata.storeName ?? null;

    const create = (invoiceSuffix: string | null) => paypalCall(
      creds,
      'POST',
      '/v2/checkout/orders',
      buildPaypalOrderPayload({ transactionId, orderRef, storeName, amountCents: amount, currency, invoiceSuffix }),
      {
        // Ver o bloco do topo. O sufixo só aparece na segunda tentativa, com
        // corpo diferente — reusar o id devolveria o erro guardado da primeira.
        'PayPal-Request-Id': invoiceSuffix ? `koopfy_pp_${transactionId}_inv` : `koopfy_pp_${transactionId}`,
        Prefer: 'return=representation',
      },
    );

    try {
      let order: any;
      try {
        order = await create(null);
      } catch (err: any) {
        // O mesmo número de pedido já foi pago nesta conta PayPal (outra loja
        // dele com a mesma numeração, ou a tentativa anterior do pedido). O
        // PayPal recusa invoice_id repetido; o sufixo mantém o pedido legível.
        if (err instanceof PaypalApiError && err.issue === 'DUPLICATE_INVOICE_ID') {
          order = await create(String(transactionId).slice(0, 8));
        } else {
          throw err;
        }
      }

      if (!order?.id) {
        return this.failure(accountId, transactionId, 'paypal_error', 'PayPal: order criada sem id', false);
      }

      return {
        success: true,
        // A order não é dinheiro: quem aprova é a captura (ver o topo).
        status: 'pending',
        provider: this.name,
        accountId,
        transactionId,
        providerTransactionId: order.id,
        providerStatus: String(order.status ?? 'CREATED'),
        data: {
          flow: 'client',
          paypalOrderId: order.id,
          // Público: é o client-id com que o navegador carrega o SDK do PayPal.
          clientId: creds.clientId,
          accountId,
        },
      };
    } catch (err: any) {
      const accountLevel = err instanceof PaypalApiError && (err.httpStatus === 401 || err.httpStatus === 403);
      return {
        success: false,
        status: 'failed',
        provider: this.name,
        accountId,
        transactionId,
        providerStatus: 'error',
        failureCode: String(err?.issue ?? err?.httpStatus ?? 'paypal_error'),
        failureMessage: err?.message ?? 'PayPal: falha ao criar o pagamento',
        data: { accountLevel, httpStatus: err?.httpStatus ?? null, issue: err?.issue ?? null },
      };
    }
  }

  // ─────────────────────────────────────────────
  // CAPTURE — depois que o comprador aprovou nos botões
  // ─────────────────────────────────────────────

  async capture(args: { providerConfig: any; orderId: string; transactionId: string }): Promise<PaypalCaptureOutcome> {
    const creds = this.credentials(args.providerConfig);
    if (!creds) throw new Error(`PayPal: conta ${args.providerConfig?.id ?? '?'} sem credencial utilizável`);

    let order: any;
    try {
      order = await paypalCall(
        creds,
        'POST',
        `/v2/checkout/orders/${encodeURIComponent(args.orderId)}/capture`,
        {},
        { 'PayPal-Request-Id': `koopfy_ppc_${args.transactionId}`, Prefer: 'return=representation' },
      );
    } catch (err: any) {
      if (!(err instanceof PaypalApiError)) throw err;
      // Já capturada (retry do checkout, ou o webhook chegou antes): a fonte
      // da verdade é a order — lê em vez de falhar.
      if (err.issue === 'ORDER_ALREADY_CAPTURED') {
        order = await paypalCall(creds, 'GET', `/v2/checkout/orders/${encodeURIComponent(args.orderId)}`);
      } else if (err.issue === 'INSTRUMENT_DECLINED' || err.issue === 'PAYER_ACTION_REQUIRED') {
        // O comprador pode escolher outra forma de pagamento na MESMA order
        // (actions.restart no SDK): não é falha da transação.
        return { outcome: 'declined', code: err.issue, message: err.message, retryable: true, raw: err.body };
      } else if (err.httpStatus === 422 || err.httpStatus === 400) {
        return { outcome: 'declined', code: err.issue ?? 'PAYPAL_UNPROCESSABLE', message: err.message, retryable: false, raw: err.body };
      } else {
        throw err;
      }
    }

    const capture = extractPaypalCapture(order);
    if (capture.captureStatus === 'COMPLETED' && capture.captureId) {
      return {
        outcome: 'paid',
        captureId: capture.captureId,
        customId: capture.customId,
        value: capture.value,
        currency: capture.currency,
        raw: order,
      };
    }
    if (capture.captureStatus === 'DECLINED' || capture.captureStatus === 'FAILED') {
      return {
        outcome: 'declined',
        code: `CAPTURE_${capture.captureStatus}`,
        message: capture.reason ?? 'O PayPal recusou o pagamento.',
        retryable: false,
        raw: order,
      };
    }
    // PENDING (eCheck, revisão do PayPal): o desfecho chega pelo webhook.
    return { outcome: 'pending', captureId: capture.captureId, reason: capture.reason, raw: order };
  }

  private failure(
    accountId: string,
    transactionId: string,
    code: string,
    message: string,
    accountLevel: boolean,
  ): ChargeResponse {
    console.error('[PaypalProvider]', message);
    return {
      success: false,
      status: 'failed',
      provider: this.name,
      accountId,
      transactionId,
      providerStatus: 'error',
      failureCode: code,
      failureMessage: message,
      data: { accountLevel },
    };
  }
}
