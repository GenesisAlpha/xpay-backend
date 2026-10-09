import Stripe from 'stripe';
import { ChargeResponse, RetrieveResponse } from './provider.types';
import { StripeRiskService } from '../stripe/stripe-risk.service';
import { maskedPlanTitle } from './whop-plan-title';
import { STRIPE_REDIRECT_METHODS } from '../seller-provider/seller-provider-accounts';

// ============================================================================
// STRIPE — Payment Intents, uma conta (um titular) por cobrança
// ----------------------------------------------------------------------------
// O DESENHO EM UMA FRASE: criamos o PaymentIntent no servidor com a chave da
// conta ESCOLHIDA PELO ROUTER e devolvemos client_secret + publishable_key da
// MESMA conta; o front confirma no Payment Element. Status final chega por
// webhook em /webhook/stripe/:accountId.
//
// ⚠️ O PAR TEM QUE SER DA MESMA CONTA. client_secret de uma conta com
// publishable_key de outra falha no confirm com um erro que não diz isso —
// buildStripeSession lê a publishable_key do config da conta pela mesma razão.
// Por isso ela volta daqui junto do client_secret, e não de uma env global.
//
// ⚠️ RECONCILIAÇÃO. `metadata.koopfy_transaction_id` é o fio que liga o
// pagamento na Stripe à transação aqui. Ele volta no webhook. Se sumir deste
// objeto, o pagamento vira órfão e só conciliação manual resolve — é a mesma
// lição que o provider da Whop aprendeu por caminho pior.
//
// ⚠️ IDEMPOTÊNCIA. A chave é o transactions.id. Sem ela, um retry de rede
// depois de a Stripe já ter criado o intent cria um SEGUNDO intent — dois
// PaymentIntents para um pedido, e o comprador com risco de ser cobrado duas
// vezes. Nunca remova, e nunca a torne aleatória.
// ============================================================================

// Moedas SEM casa decimal na Stripe: o valor é a unidade inteira, não centavos.
// Mandar 1000 para JPY cobra ¥1.000 — mas o resto do pay guarda `amount` em
// centavos, então 1000 aqui significaria ¥10. Sem esta conversão a cobrança sai
// 100x errada, e sai "com sucesso".
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

// Moedas de TRÊS casas: a Stripe exige o valor em milésimos e múltiplo de 10.
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

// Códigos de recusa que são da CONTA, não do cartão. Só estes justificam
// tentar outra conta — repetir um `card_declined` em outro titular é submeter
// o mesmo cartão recusado de novo, o que piora a taxa de autorização das duas
// contas e não converte nada.
const ACCOUNT_LEVEL_DECLINE_CODES = new Set([
  'account_invalid',
  'api_key_expired',
  'authentication_required_for_account',
  'account_closed',
  'charge_not_allowed',
  'platform_account_required',
  'processing_error',
]);

export class StripeProvider {
  name = 'stripe';

  // O risco é injetado porque a política de 3DS depende do tier da conta —
  // ver requestThreeDSecure. Opcional para que o provider continue construível
  // sem o serviço (testes, scripts de conciliação).
  constructor(private readonly risk?: StripeRiskService) { }

  // ─────────────────────────────────────────────
  // CHARGE
  // ─────────────────────────────────────────────

  async charge(ctx: any): Promise<ChargeResponse> {
    const { transactionId, providerConfig } = ctx;
    const accountId = providerConfig?.id ?? 'stripe_unknown';
    const secretKey = providerConfig?.apiKey;
    const cfg = providerConfig?.config ?? {};

    if (!secretKey) {
      return this.failure(
        accountId, transactionId, 'config',
        `Stripe: conta ${accountId} sem secret_key utilizável (não cadastrada ou falha ao decifrar)`,
      );
    }
    if (!cfg.publishable_key) {
      // Recusa em vez de cair numa env global: o par client_secret ×
      // publishable_key tem que ser da MESMA conta, e uma pk global de outro
      // titular falharia no confirm com erro ilegível.
      return this.failure(
        accountId, transactionId, 'config',
        `Stripe: conta ${accountId} sem publishable_key — o front não tem como confirmar o intent`,
      );
    }

    const currency = String(ctx.currency ?? cfg.default_currency ?? 'BRL').toUpperCase();
    const amount = this.toStripeAmount(ctx.amount, currency);

    if (!Number.isFinite(amount) || amount <= 0) {
      return this.failure(
        accountId, transactionId, 'invalid_amount',
        `Stripe: valor inválido (${ctx.amount} ${currency})`,
      );
    }

    const stripe = this.clientFor(secretKey);

    const threeDS = this.risk?.requestThreeDSecure({
      accountId,
      amountUsdCents: ctx.amountUsdCents,
      riskLevel: ctx.riskLevel,
    }) ?? 'automatic';

    try {
      const intent = await stripe.paymentIntents.create(
        {
          amount,
          currency: currency.toLowerCase(),

          // Deixa a Stripe oferecer o que a CONTA tem habilitado e o que é
          // válido para o país/moeda do comprador. Listar métodos à mão só
          // ESCONDE o que ela mostraria — e cada método escondido é conversão
          // perdida sem ninguém perceber.
          automatic_payment_methods: {
            enabled: true,
            // Sem redirect: o checkout é embedado e um método que leva o
            // comprador para fora quebra o fluxo de upsell. A exceção é o
            // comprador ter ESCOLHIDO um método que só fecha no banco/app
            // (iDEAL, MB Way, Bancontact…): com 'never' a Stripe recusava a
            // confirmação e o método aparecia no checkout sem funcionar.
            allow_redirects: ctx.allow_redirects === true || STRIPE_REDIRECT_METHODS.has(String(ctx.method ?? '').toLowerCase()) ? 'always' : 'never',
          },

          // Descriptor por titular. É a causa nº1 de disputa "não reconheço a
          // compra" quando está errado — e a disputa que mais pesa na review.
          ...(cfg.descriptor_suffix
            ? { statement_descriptor_suffix: this.trimDescriptor(cfg.descriptor_suffix) }
            : {}),

          payment_method_options: {
            card: {
              request_three_d_secure: threeDS,
            },
          },

          // Radar pontua melhor com a sessão coletada no cliente (device,
          // comportamento). Sem ela, a Stripe julga só pelos dados do cartão.
          ...(ctx.radar_session ? { radar_options: { session: ctx.radar_session } } : {}),

          // Sem `receipt_email`: a Stripe não manda recibo (nem o do reembolso)
          // ao comprador. Quem fala com ele é a Koopfy — e-mail do provedor com
          // outro nome no remetente é causa de "não reconheço a compra".

          description: this.buildDescription(ctx, cfg),

          // ⚠️ O FIO DA RECONCILIAÇÃO. Volta no webhook. Não remova campos.
          metadata: {
            koopfy_transaction_id: String(transactionId),
            koopfy_account_id: String(accountId),
            koopfy_seller_id: String(ctx.sellerId ?? ''),
            koopfy_order_ref: String(ctx.external_reference ?? ''),
            koopfy_offer_id: String(ctx.offerId ?? ''),
          },
        },
        {
          // Ver o bloco do topo: fixa e derivada do pedido, nunca aleatória.
          idempotencyKey: `koopfy_pi_${transactionId}`,
        },
      );

      return {
        success: true,
        // 'pending': o comprador ainda não confirmou. Quem aprova é o webhook.
        // Devolver 'approved' aqui daria pedido pago sem dinheiro nenhum.
        status: 'pending',
        provider: this.name,
        accountId,
        transactionId,
        providerTransactionId: intent.id,
        providerStatus: intent.status,
        clientSecret: intent.client_secret ?? undefined,
        next_action: intent.next_action ?? undefined,
        data: {
          flow: 'client',
          cardFlow: 'elements',
          // Par obrigatório com o client_secret — mesma conta, sempre.
          publishableKey: cfg.publishable_key,
          accountId,
          holder: cfg.holder_legal_name ?? null,
          descriptor: cfg.statement_descriptor ?? null,
          threeDSecure: threeDS,
        },
      };
    } catch (err: any) {
      return this.mapError(err, accountId, transactionId);
    }
  }

  // ─────────────────────────────────────────────
  // RETRIEVE — reconciliação (webhook perdido, conferência manual)
  // ─────────────────────────────────────────────

  async retrieve(ctx: {
    providerConfig: any;
    providerTransactionId: string;
  }): Promise<RetrieveResponse> {
    const secretKey = ctx.providerConfig?.apiKey;
    if (!secretKey) return { success: false, status: 'unknown' };

    try {
      const intent = await this.clientFor(secretKey)
        .paymentIntents.retrieve(ctx.providerTransactionId);

      return {
        success: true,
        status: this.mapIntentStatus(intent.status),
        providerTransactionId: intent.id,
        method: intent.payment_method_types?.[0],
        raw: intent,
      };
    } catch (err: any) {
      console.error('[StripeProvider] retrieve error:', err?.message);
      return { success: false, status: 'unknown', raw: err?.raw ?? null };
    }
  }

  // ─────────────────────────────────────────────
  // REFUND
  //
  // ⚠️ Tem que rodar na conta do titular que RECEBEU. É por isso que o router
  // mantém stickiness por pedido: com titulares independentes, reembolsar de
  // outra conta é impossível — o saldo está em outra entidade jurídica.
  // ─────────────────────────────────────────────

  async refund(ctx: {
    providerConfig: any;
    providerTransactionId: string;
    amount?: number;
    currency?: string;
    reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    transactionId: string;
  }): Promise<{ success: boolean; refundId?: string; message?: string }> {
    const secretKey = ctx.providerConfig?.apiKey;
    if (!secretKey) return { success: false, message: 'Stripe: conta sem secret_key' };

    try {
      const refund = await this.clientFor(secretKey).refunds.create(
        {
          payment_intent: ctx.providerTransactionId,
          ...(ctx.amount != null && ctx.currency
            ? { amount: this.toStripeAmount(ctx.amount, ctx.currency) }
            : {}),
          // 'requested_by_customer' de propósito no default. Marcar como
          // 'fraudulent' entra no histórico de fraude da CONTA na Stripe —
          // use só quando for fraude de verdade.
          reason: ctx.reason ?? 'requested_by_customer',
          metadata: { koopfy_transaction_id: String(ctx.transactionId) },
        },
        { idempotencyKey: `koopfy_rf_${ctx.transactionId}` },
      );

      return { success: true, refundId: refund.id };
    } catch (err: any) {
      console.error('[StripeProvider] refund error:', err?.message);
      return { success: false, message: err?.message ?? 'refund failed' };
    }
  }

  // ─────────────────────────────────────────────
  // Erro → ChargeResponse
  //
  // `accountLevel` é o que o router lê para decidir se vale tentar OUTRA conta.
  // Recusa de cartão não é: repetir o mesmo cartão recusado em outro titular
  // não converte e degrada a taxa de autorização das duas contas.
  // ─────────────────────────────────────────────

  private mapError(err: any, accountId: string, transactionId: string): ChargeResponse {
    const code = err?.code ?? err?.raw?.code ?? null;
    const declineCode = err?.decline_code ?? err?.raw?.decline_code ?? null;
    const status = err?.statusCode ?? err?.raw?.statusCode ?? null;
    const type = err?.type ?? err?.raw?.type ?? null;

    const accountLevel =
      status === 401
      || status === 403
      || type === 'StripeAuthenticationError'
      || type === 'StripePermissionError'
      || ACCOUNT_LEVEL_DECLINE_CODES.has(String(code))
      || ACCOUNT_LEVEL_DECLINE_CODES.has(String(declineCode));

    if (accountLevel) {
      console.error(
        `[StripeProvider] 🚨 erro de CONTA em ${accountId}: ${type} ${code ?? ''} ${declineCode ?? ''} — `
        + `${err?.message}. O probe do StripeRiskService confirma e quarentena em até 5min; `
        + 'o pagamento atual vai para a próxima conta do pool.',
      );
    }

    return {
      success: false,
      status: 'failed',
      provider: this.name,
      accountId,
      transactionId,
      providerStatus: type ?? 'error',
      failureCode: String(declineCode ?? code ?? status ?? 'stripe_error'),
      failureMessage: err?.message ?? 'Stripe: falha ao criar o pagamento',
      data: { accountLevel, type, code, declineCode, httpStatus: status },
    };
  }

  private failure(
    accountId: string,
    transactionId: string,
    code: string,
    message: string,
  ): ChargeResponse {
    console.error('[StripeProvider]', message);
    return {
      success: false,
      status: 'failed',
      provider: this.name,
      accountId,
      transactionId,
      providerStatus: 'error',
      failureCode: code,
      failureMessage: message,
      // Config quebrada é problema DA CONTA — outra conta do pool provavelmente
      // funciona, então o router deve tentar.
      data: { accountLevel: true },
    };
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  // `amount` chega em centavos da moeda da transação (convenção do pay inteiro).
  // A Stripe quer a menor unidade da moeda — que para JPY é a unidade inteira e
  // para KWD é o milésimo. Ver os Sets no topo.
  private toStripeAmount(amountCents: number, currency: string): number {
    const cur = String(currency).toUpperCase();
    const cents = Number(amountCents);

    if (ZERO_DECIMAL_CURRENCIES.has(cur)) {
      // 1000 centavos = 10 unidades = ¥10.
      return Math.round(cents / 100);
    }

    if (THREE_DECIMAL_CURRENCIES.has(cur)) {
      // Centavos → milésimos: ×10. O resultado já é múltiplo de 10, que é o que
      // a Stripe exige nestas moedas (o último dígito tem de ser zero).
      return Math.round(cents) * 10;
    }

    return Math.round(cents);
  }

  // A Stripe recusa o intent inteiro se o sufixo passar de 22 caracteres ou
  // trouxer < > \ " ' — e recusar a compra por causa do descriptor é o pior
  // jeito possível de descobrir que ele está errado.
  private trimDescriptor(value: string): string {
    return String(value).replace(/[<>\\"']/g, '').trim().slice(0, 22);
  }

  private buildDescription(ctx: any, cfg: any = {}): string {
    // Conta do PRÓPRIO seller: o catálogo não sai da Koopfy (política de
    // 2026-09-16, ver whop-plan-title.ts). Vai `<Loja> · #<pedido>`.
    if (cfg?.linked) {
      const metadata = ctx.metadata ?? {};
      const orderRef = metadata.order_number ?? metadata.orderId ?? ctx.external_reference ?? ctx.transactionId;
      return maskedPlanTitle(metadata.store_name ?? metadata.storeName ?? null, String(orderRef ?? ''), 350);
    }
    const parts = [ctx.product_name, ctx.offer_name, ctx.external_reference]
      .filter(Boolean)
      .map(String);
    return parts.length ? parts.join(' · ').slice(0, 350) : `Pedido ${ctx.transactionId}`;
  }

  private mapIntentStatus(status: string): 'paid' | 'failed' | 'pending' | 'unknown' {
    switch (status) {
      case 'succeeded':
        return 'paid';
      case 'canceled':
        return 'failed';
      case 'processing':
      case 'requires_action':
      case 'requires_confirmation':
      case 'requires_payment_method':
      case 'requires_capture':
        return 'pending';
      default:
        return 'unknown';
    }
  }

  private clientFor(secretKey: string): Stripe {
    return new Stripe(secretKey, {
      apiVersion: '2023-10-16',
      // Seguro porque toda escrita aqui manda idempotencyKey.
      maxNetworkRetries: 2,
      // Abaixo do timeout de 10s do executeWithProvider de propósito: preferimos
      // o erro da Stripe (que diz o que houve) ao TIMEOUT_10000ms do router.
      timeout: 9_000,
    });
  }
}
