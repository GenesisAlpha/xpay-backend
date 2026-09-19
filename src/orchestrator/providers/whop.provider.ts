import { ChargeResponse } from './provider.types';
import { whopRenewalTerms } from './whop-subscription-terms';
import { supabase } from '../../lib/supabase.client';
import { KOOPFY_PRODUCT_EXTERNAL_ID, connectedApplicationFee } from '../whop/whop-connected';
import { maskedPlanTitle } from './whop-plan-title';

/** Membership da Whop reduzida ao que a área do cliente usa. */
export interface WhopMembershipState {
  id: string;
  /** trialing | active | past_due | completed | canceled | expired | unresolved | drafted | canceling */
  status: string | null;
  cancelAtPeriodEnd: boolean;
  /** Fim do período pago (ISO): próxima cobrança, ou fim do acesso se cancelando. */
  renewalPeriodEnd: string | null;
}

// ============================================================================
// WHOP — checkout hospedado/embedado, uma company por conta do pool
// ----------------------------------------------------------------------------
// O DESENHO EM UMA FRASE: cada company Whop tem UM produto criado, e o preço
// não mora nele. Cada compra cria uma *checkout configuration* com os termos do
// plano inline — preço, moeda e título definidos na hora. Para recorrência,
// `force_create_new_plan: false` faz a Whop reutilizar o plano compatível; a
// sessão continua nova para carregar a metadata do pedido. O mesmo produto
// atende todos os produtos da Koopfy sem duplicar containers lá dentro.
//
// POR QUE NÃO "montar o link mudando o preço": a Whop ignora preço em query
// string. O preço vive no plano, e o plano é criado junto com a sessão em
// POST /api/v1/checkout_configurations. Sem plano inline, a única alternativa
// seria pré-criar um plano por faixa de preço (API de Plans, marcada como
// experimental) e cachear — mais peças, mais coisa pra sincronizar, e ainda
// assim incapaz de cobrir preço arbitrário (bump + frete + desconto).
//
// ⚠️ RECONCILIAÇÃO. Como o produto é o mesmo pra tudo, o painel e os webhooks
// da Whop reportam toda venda como o mesmo item. O ÚNICO fio que liga um
// pagamento Whop a uma transação da Koopfy é o `metadata` daqui — ele propaga
// pro payment e pra membership e volta no webhook. Se algum campo sumir deste
// objeto, o pagamento vira órfão e só conciliação manual resolve.
//
// ⚠️ UNIDADE DO PREÇO. `initial_price` é em UNIDADE PRINCIPAL decimal (9.99),
// não em centavos — ao contrário de praticamente todo o resto do pay, que
// trabalha em centavos integer. Mandar 999 aqui cobra R$ 999,00.
//
// ─── Limites e comportamentos CONFIRMADOS contra a API real ──────────────────
// (probe em biz_Oz5cXnr6X2qoMV; planos de teste apagados depois)
//
//  • `plan.title` tem limite de 30 CARACTERES. Acima disso a API devolve 400
//    "Validation failed: Title is too long" e a compra inteira morre. Cortamos
//    aqui — nome de produto passando de 30 chars é o caso comum, não a exceção.
//  • `plan.visibility` OMITIDO nasce "visible", ou seja, cada checkout publicaria
//    um plano na vitrine da company. Com um plano por compra isso vira milhares
//    de planos públicos em semanas. Por isso mandamos 'quick_link' sempre.
//  • `plan.product.external_identifier` DEDUPLICA: dois checkouts com o mesmo
//    identificador caem no MESMO produto (confirmado — 1 produto, N planos). É
//    isso que realiza "um produto por company atendendo todo o catálogo" sem
//    precisar de produto pré-criado. `product_id` também funciona, quando a
//    company já tem o access pass.
//  • `adaptive_pricing_enabled` já vem true por padrão — é o comprador pagando
//    na moeda dele. Não mexemos no `currency` do plano por país: o valor está na
//    moeda da transação, e trocar a moeda base sem converter cobraria errado.
//  • Planos são deletáveis via DELETE /api/v1/plans/{id} — dá pra fazer faxina.
// ============================================================================

const WHOP_API_URL_DEFAULT = 'https://api.whop.com';

// Limite duro da API — ver bloco acima.
const WHOP_PLAN_TITLE_MAX = 30;

// Nomes de assinatura que chegam no metadata: produto recorrente e oferta de link.
const RECURRING_PAYMENT_TYPES = new Set(['assinatura-recorrente', 'subscription']);

// Como o plano inline aponta pro produto da company. Ambos confirmados
// funcionando; o default é external_identifier porque ele NÃO exige que alguém
// tenha criado o produto antes (e dedupa sozinho).
type ProductLinkMode = 'product_id' | 'external_identifier' | 'none';

// ─── Métodos de pagamento ────────────────────────────────────────────────────
//
// Identificadores VALIDADOS contra a API (os fora desta lista são recusados com
// "Missing required parameter: payment_method_configuration.enabled.0").
//
// ⚠️ Aceito pela API ≠ disponível no checkout. O que aparece de fato depende de
// (a) o método estar habilitado na company e (b) ser válido pro país/moeda do
// comprador. Por isso o DEFAULT aqui não é listar métodos: é
// `include_platform_defaults: true` com `disabled: []` — a Whop conhece as duas
// coisas e nós não. Listar à mão só ESCONDE o que ela mostraria.
const WHOP_PAYMENT_METHODS = new Set([
  'card', 'apple_pay', 'google_pay', 'link', 'paypal', 'crypto',
  'pix', 'boleto', 'oxxo',
  'ideal', 'bancontact', 'sepa_debit', 'multibanco', 'mb_way',
  'blik', 'p24', 'eps', 'twint', 'swish', 'revolut_pay',
  'klarna', 'affirm', 'afterpay_clearpay', 'cashapp', 'us_bank_account',
  'alipay', 'wechat_pay', 'amazon_pay', 'grabpay',
]);

// Moeda exigida por método. APM local não existe fora da moeda dele: iDEAL só em
// EUR, Pix só em BRL, OXXO só em MXN.
//
// ⚠️ É isto que evita o pior modo de falha do embed: restringir a sessão a um
// método indisponível não dá erro — a Whop renderiza o formulário VAZIO, só com
// o botão, e o comprador não tem como pagar nem como entender o motivo.
// Método fora desta tabela não tem exigência conhecida (cartão, wallets, klarna,
// paypal, crypto) e passa direto.
const WHOP_METHOD_CURRENCIES: Record<string, string[]> = {
  pix: ['BRL'],
  boleto: ['BRL'],
  oxxo: ['MXN'],
  ideal: ['EUR'],
  bancontact: ['EUR'],
  multibanco: ['EUR'],
  mb_way: ['EUR'],
  eps: ['EUR'],
  sepa_debit: ['EUR'],
  blik: ['PLN'],
  p24: ['PLN', 'EUR'],
  twint: ['CHF'],
  swish: ['SEK'],
  cashapp: ['USD'],
  us_bank_account: ['USD'],
};

// Métodos que NÃO restringem a sessão — ver buildPaymentMethods.
// Espelhado em WHOP_NON_RESTRICTING no AtlasCheckout.tsx.
const WHOP_NON_RESTRICTING = new Set(['card', 'apple_pay', 'google_pay', 'link']);

// Método escolhido no NOSSO checkout → identificador da Whop.
// Só existe pra um caso: quando o comprador já escolheu (ex.: clicou em Pix),
// abrir o embed direto nele em vez de pedir pra escolher duas vezes.
const KOOPFY_METHOD_TO_WHOP: Record<string, string> = {
  card: 'card',
  credit_card: 'card',
  debit_card: 'card',
  apple_pay: 'apple_pay',
  google_pay: 'google_pay',
  pix: 'pix',
  boleto: 'boleto',
  oxxo: 'oxxo',
  ideal: 'ideal',
  bancontact: 'bancontact',
  sepa: 'sepa_debit',
  sepa_debit: 'sepa_debit',
  multibanco: 'multibanco',
  mbway: 'mb_way',
  mb_way: 'mb_way',
  blik: 'blik',
  p24: 'p24',
  eps: 'eps',
  twint: 'twint',
  swish: 'swish',
  revolut_pay: 'revolut_pay',
  klarna: 'klarna',
  cashapp: 'cashapp',
  ach: 'us_bank_account',
  paypal: 'paypal',
  crypto: 'crypto',
};

export class WhopProvider {
  name = 'whop';

  // ─────────────────────────────────────────────
  // CHARGE — cria a checkout configuration
  //
  // Não existe cobrança síncrona: devolvemos 'requires_action' + a URL/embed, e
  // quem confirma é o webhook payment.succeeded. Mesma forma do Rox Pay.
  // ─────────────────────────────────────────────

  async charge(ctx: any): Promise<ChargeResponse> {
    const { amount, currency, transactionId, providerConfig, metadata, sellerId, method } = ctx;
    const { id, apiKey, api_url, config } = providerConfig ?? {};

    const companyId = config?.company_id;
    const apiUrl = api_url ?? WHOP_API_URL_DEFAULT;

    if (!apiKey) return this.failure(id, transactionId, 'Whop: api_key ausente na conta');
    if (!companyId) return this.failure(id, transactionId, 'Whop: company_id ausente na conta');

    // Centavos integer (padrão do pay) → decimal (padrão da Whop).
    const cents = Math.round(Number(amount));
    if (!Number.isFinite(cents) || cents <= 0) {
      return this.failure(id, transactionId, `Whop: amount inválido (${amount})`);
    }
    const initialPrice = Number((cents / 100).toFixed(2));

    const cur = String(currency ?? config?.currency ?? 'USD').toLowerCase();

    // ── Teto de ticket ────────────────────────────────────────────────────
    // Comparado em USD porque é a unidade do teto (e do volume diário). O valor
    // em dólar vem do settlement, já convertido pelo FX da transação; sem ele
    // (moeda já USD ou payload sem settlement) usa o próprio amount.
    const usdCents = Number(
      ctx?.settlement?.exchange?.amount_usd_gross_cents
      ?? (cur === 'usd' ? cents : NaN),
    );

    // Teto só quando a conta define um (whop_accounts.max_ticket). Não há teto
    // padrão: um limite fixo aqui recusava toda venda acima de US$ 100, mesmo
    // com a conta sem teto nenhum no banco.
    //
    // O router já filtra por max_ticket ao escolher a conta, mas só quando o
    // caller informa `amountUsdCents` (ver withinTicketRange). Este guard é a
    // última linha para esse caso.
    const rawMaxTicket = providerConfig?.max_ticket ?? config?.max_ticket;
    const maxTicket = rawMaxTicket == null ? null : Number(rawMaxTicket);

    if (maxTicket != null && Number.isFinite(usdCents) && usdCents > maxTicket) {
      const limite = (maxTicket / 100).toFixed(2);
      const tentado = (usdCents / 100).toFixed(2);
      return this.failure(
        id,
        transactionId,
        `Valor máximo excedido para esta conta: limite de US$ ${limite}, `
        + `pedido de US$ ${tentado}.`,
      );
    }

    if (maxTicket != null && !Number.isFinite(usdCents)) {
      // Sem valor em dólar não dá pra comparar com o teto. Avisa alto em vez de
      // deixar passar em silêncio — teto que não pega é pior que teto nenhum.
      console.warn(
        `[WhopProvider] ${id}: sem amount_usd (moeda ${cur}) — teto de ticket NÃO aplicado.`,
      );
    }

    const orderRef = metadata?.order_number ?? metadata?.orderId ?? transactionId;
    const checkoutBase = process.env.CHECKOUT_PUBLIC_URL ?? 'https://checkout.koopfy.com';
    // Fallback: a página de resultado, que confirma o pedido no backend. Antes
    // era /obrigado — rota que não existe no checkout e caía na página de
    // produto, mostrando "Erro ao carregar" pra quem acabou de pagar.
    //
    // ⚠️ Só https E host público. A Whop recusa a checkout configuration INTEIRA
    // com "The redirect URL must be a valid URL, starting with https://" — tanto
    // para http quanto para https://localhost (conferido na API). Um return_url
    // de ambiente local derrubava a sessão e o embed nem abria.
    const requested = typeof metadata?.redirect_url === 'string' ? metadata.redirect_url.trim() : '';
    const redirectUrl = this.isPublicHttpsUrl(requested)
      ? requested
      : `${checkoutBase}/payment-result?orderId=${encodeURIComponent(String(orderRef))}`;

    // Título do plano = LOJA + pedido, nunca o produto (ver whop-plan-title.ts).
    // O provider não precisa saber o que a loja vende; o comprador reconhece a
    // compra pela loja, e o produto real ele lê nas nossas telas e no e-mail.
    const storeName =
      metadata?.store_name
      ?? metadata?.storeName
      ?? config?.legal_name
      ?? config?.label
      ?? null;
    const title = maskedPlanTitle(storeName, String(orderRef));

    // País do comprador — só usado pra decidir se o embed abre num método
    // específico. NÃO trocamos a moeda do plano por país: o `amount` está na
    // moeda da transação, e mudar a base sem converter cobraria outro valor.
    // Quem resolve moeda local é o adaptive pricing da própria Whop.
    const country = String(
      ctx?.billing_address?.country ?? ctx?.customer?.country ?? metadata?.country ?? '',
    ).toUpperCase() || null;

    // ── Conta conectada (cobrança direta na conta do seller) ─────────────────
    // A Koopfy só recebe o que for application fee. Sem fee válida a venda
    // sairia de graça — por isso falha fechado em vez de cobrar sem ela.
    const connected = config?.connected === true;

    // ── Upsell de um clique: cobra o meio de pagamento salvo ─────────────────
    // Não cria checkout configuration — não há embed. Ver chargeSavedPaymentMethod.
    if (ctx?.offSession?.memberId && ctx?.offSession?.paymentMethodId) {
      let upsellFee: number | null = null;
      if (connected) {
        const computed = this.connectedFee(initialPrice);
        if ('error' in computed) {
          return this.failure(id, transactionId, `Whop: taxa da plataforma inválida (${computed.error})`);
        }
        upsellFee = computed.fee;
      }
      return this.chargeSavedPaymentMethod({
        applicationFee: upsellFee,
        accountId: id,
        apiUrl,
        apiKey,
        companyId,
        transactionId,
        memberId: String(ctx.offSession.memberId),
        paymentMethodId: String(ctx.offSession.paymentMethodId),
        parentTransactionId: String(ctx.offSession.parentTransactionId ?? ''),
        currency: cur,
        initialPrice,
        orderRef: String(orderRef),
        sellerId: sellerId ?? metadata?.seller_id ?? metadata?.sellerId ?? null,
        productId: metadata?.product_id ?? metadata?.productId ?? null,
        returnUrl: redirectUrl,
        config,
      });
    }

    // Produto recorrente chega como 'assinatura-recorrente' e oferta de checkout
    // como 'subscription'. Só o primeiro nome virava assinatura: a oferta de
    // checkout ia pra Whop como pagamento único.
    const isRecurring = RECURRING_PAYMENT_TYPES.has(String(metadata?.payment_type ?? ''));
    let subscriptionTerms: {
      billingPeriodDays: number;
      trialPeriodDays: number;
      initialCharge: number;
      renewalPrice: number;
      installments: number | null;
      /** Teste enviado à Whop (o do seller, ou um ciclo para o valor inicial). */
      whopTrialDays: number;
      /** Plano novo na Whop: quem já usou teste num plano reaproveitado não ganha outro. */
      freshPlan: boolean;
    } | null = null;

    if (isRecurring) {
      const koopfyProductId = metadata?.product_id ?? metadata?.productId;
      if (!koopfyProductId) {
        return this.failure(id, transactionId, 'Whop: produto Koopfy ausente para assinatura');
      }

      const billingPeriodDays = Number(metadata?.subscription_config?.billing_period_days ?? 30);
      const trialPeriodDays = Number(metadata?.subscription_config?.trial_period_days ?? 0);
      // `amount` é o que o comprador paga HOJE (cobrança inicial, ou inicial +
      // primeira mensalidade sem teste). A renovação vem do plano, já na moeda
      // da cobrança — nunca do amount, senão a assinatura renovaria pelo valor
      // de entrada.
      const renewalPrice = this.renewalPriceInChargeCurrency(metadata, cur);
      if (!Number.isFinite(renewalPrice) || renewalPrice <= 0) {
        return this.failure(id, transactionId, 'Whop: valor da renovação ausente na moeda da cobrança');
      }
      // Valor inicial NO LUGAR da primeira mensalidade (regra da Koopfy); a Whop
      // soma initial_price à primeira cobrança. whopRenewalTerms traduz.
      const whopTerms = whopRenewalTerms({
        todayCharge: initialPrice,
        renewalPrice,
        billingPeriodDays,
        trialPeriodDays,
        planInitialPrice: Number(metadata?.pricing_plan?.initial_price ?? 0),
      });
      if ('error' in whopTerms) {
        return this.failure(id, transactionId, `Whop: ${whopTerms.error}`);
      }
      const initialCharge = whopTerms.initialPrice;
      const installments = metadata?.pricing_plan?.split_pay_required_payments == null
        ? null
        : Number(metadata.pricing_plan.split_pay_required_payments);

      if (!Number.isInteger(billingPeriodDays) || billingPeriodDays < 1 || billingPeriodDays > 730) {
        return this.failure(id, transactionId, 'Whop: período de cobrança da assinatura inválido');
      }
      if (!Number.isInteger(trialPeriodDays) || trialPeriodDays < 0 || trialPeriodDays > 365) {
        return this.failure(id, transactionId, 'Whop: período de teste da assinatura inválido');
      }
      if (!Number.isFinite(initialCharge) || initialCharge < 0) {
        // Sem teste, a primeira cobrança não pode ser menor que a renovação (ex.:
        // cupom maior que a cobrança inicial): a Whop cobraria a mensalidade cheia.
        return this.failure(id, transactionId, 'Whop: cobrança inicial inválida');
      }
      if (installments !== null && (!Number.isInteger(installments) || installments < 2 || installments > 60)) {
        return this.failure(id, transactionId, 'Whop: quantidade de cobranças inválida');
      }

      subscriptionTerms = {
        billingPeriodDays,
        trialPeriodDays,
        initialCharge,
        renewalPrice,
        installments,
        whopTrialDays: whopTerms.trialPeriodDays,
        freshPlan: whopTerms.freshPlan,
      };
    }

    // ⚠️ Ver aviso de reconciliação no topo do arquivo. É o que o webhook usa pra
    // achar a transação — vale igual pro embed e pro token do Elements.
    const koopfyMetadata = {
      koopfy_transaction_id: transactionId,
      koopfy_order_ref: String(orderRef),
      koopfy_seller_id: sellerId ?? metadata?.seller_id ?? metadata?.sellerId ?? null,
      koopfy_product_id: metadata?.product_id ?? metadata?.productId ?? null,
      koopfy_account_id: id,
      koopfy_country: country,
      koopfy_payment_type: isRecurring ? 'subscription' : 'one_time',
      koopfy_pricing_plan_id: metadata?.pricing_plan?.id ?? null,
    };

    // ── Taxa da plataforma na conta conectada ────────────────────────────────
    // Recorrente: a Whop aplica a MESMA fee a cada renovação e exige que ela
    // seja menor que o renewal_price — a base é a renovação. Se a cobrança de
    // hoje passar da renovação (adesão sem teste), a diferença ficaria na
    // conta do seller e a liberação pagaria de novo pela carteira: recusa.
    let applicationFee: number | null = null;
    if (connected) {
      if (subscriptionTerms && initialPrice > subscriptionTerms.renewalPrice) {
        return this.failure(
          id,
          transactionId,
          'Whop: assinatura com cobrança inicial maior que a renovação não é suportada em conta conectada',
        );
      }
      const computed = this.connectedFee(subscriptionTerms ? subscriptionTerms.renewalPrice : initialPrice);
      if ('error' in computed) {
        return this.failure(id, transactionId, `Whop: taxa da plataforma inválida (${computed.error})`);
      }
      applicationFee = computed.fee;
    }

    // ── Whop Elements: o navegador já escolheu o método e gerou o token ──────
    // Sem checkout configuration nem embed: POST /payments confirma o token.
    if (typeof ctx?.confirmation_token === 'string' && ctx.confirmation_token.startsWith('ctok_')) {
      return this.chargeConfirmationToken({
        applicationFee,
        accountId: id,
        apiUrl,
        apiKey,
        companyId,
        transactionId,
        confirmationToken: ctx.confirmation_token,
        currency: cur,
        // Já vem mascarado e dentro do limite. O nome do plano de preço NÃO
        // entra: "Plano anual do curso X" contaria o que o título esconde.
        title,
        initialPrice,
        subscriptionTerms,
        metadata: koopfyMetadata,
        returnUrl: redirectUrl,
        config,
      });
    }

    const body: Record<string, any> = {
      mode: 'payment',
      // Cobrança direta (docs "Collect payments for connected accounts"): a
      // Account API key da MASTER cria a checkout configuration e o
      // `account_id` do topo diz em qual conta conectada a venda nasce.
      // `plan.company_id` sozinho só define onde o plano é criado.
      ...(connected ? { account_id: companyId } : {}),
      // Conta própria do seller: a venda é atribuída à Koopfy como afiliada, e
      // é daí que sai a nossa comissão (não há application fee nessa conta).
      ...(config?.affiliate_code ? { affiliate_code: config.affiliate_code } : {}),
      plan: {
        company_id: companyId,
        currency: cur,
        // Mascarado em maskedPlanTitle, que também respeita o limite de 30
        // chars da API (acima disso a compra inteira falha com 400).
        title,
        plan_type: isRecurring ? 'renewal' : 'one_time',
        // Em renewal, a Whop soma initial_price à primeira cobrança sem teste —
        // os termos já vêm traduzidos da regra da Koopfy (whopRenewalTerms).
        initial_price: isRecurring ? subscriptionTerms?.initialCharge ?? 0 : initialPrice,
        ...(subscriptionTerms ? {
          renewal_price: subscriptionTerms.renewalPrice,
          billing_period: subscriptionTerms.billingPeriodDays,
          trial_period_days: subscriptionTerms.whopTrialDays || null,
          ...(subscriptionTerms.installments
            ? { split_pay_required_payments: subscriptionTerms.installments }
            : {}),
          // Contrato oficial da checkout configuration: permite uma sessão nova
          // (metadata por pedido) sem criar outro plano com os mesmos termos.
          // Plano reaproveitado não dá teste a quem já usou: com o ciclo de
          // teste do valor inicial, cada compra precisa de um plano próprio.
          force_create_new_plan: subscriptionTerms.freshPlan,
          internal_notes: `Koopfy ${String(metadata?.product_id).slice(0, 60)} / ${String(metadata?.pricing_plan?.id ?? 'default').slice(0, 40)}`,
        } : {}),
        // Sem isto o plano nasce 'visible' e cada compra publica um item na
        // vitrine da company. Ver bloco de achados no topo.
        visibility: 'quick_link',
        // Conta conectada: a parte da Koopfy (taxas + reserva). Na moeda do plano.
        ...(applicationFee != null ? { application_fee_amount: applicationFee } : {}),
        // Comprador paga na moeda dele. Vem true por padrão; explicitamos pra
        // não depender de default de terceiro num ponto que muda conversão.
        adaptive_pricing_enabled: config?.adaptive_pricing === false ? false : true,
        // Nível de 3DS: null herda o default da company (que a Whop calibra por
        // país/emissor). Só sobrescrevemos quando a conta pedir explicitamente —
        // forçar challenge onde não é exigido custa conversão, e forçar
        // frictionless onde a SCA é obrigatória vira recusa do emissor.
        ...(config?.three_ds_level ? { three_ds_level: config.three_ds_level } : {}),
        ...this.buildProductLink(config),
      },
      payment_method_configuration: this.buildPaymentMethods(method, config, cur),
      metadata: koopfyMetadata,
      redirect_url: redirectUrl,
    };

    try {
      const res = await fetch(`${apiUrl}/api/v1/checkout_configurations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });

      const json: any = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message = json?.error?.message ?? json?.message ?? `Whop HTTP ${res.status}`;
        return this.failure(id, transactionId, message, json);
      }

      const sessionId = json?.id ?? null;
      if (!sessionId) {
        return this.failure(id, transactionId, 'Whop: id da checkout configuration ausente', json);
      }

      const purchaseUrl = json?.purchase_url ?? null;
      const planId = this.extractPlanId(json);

      if (isRecurring && planId) {
        await this.recordRecurringPlan({
          accountId: id,
          koopfyProductId: String(metadata?.product_id),
          planId,
          whopProductId: config?.product_id ?? null,
          currency: cur,
          renewalPrice: subscriptionTerms!.renewalPrice,
          billingPeriodDays: subscriptionTerms!.billingPeriodDays,
          trialPeriodDays: subscriptionTerms!.trialPeriodDays,
          initialCharge: subscriptionTerms!.initialCharge,
          installments: subscriptionTerms!.installments,
        }).catch((err: any) => {
          // O pagamento já foi criado na Whop; falhar a resposta aqui faria o
          // cliente tentar de novo. O webhook ainda carrega toda a metadata.
          console.error('[WhopProvider] cache do plano recorrente:', err?.message);
        });
      }

      if (!planId) {
        // O embed precisa do plan id junto do session id. Sem ele, só sobra o
        // redirect pro purchase_url — degradação silenciosa que vira "por que o
        // iframe não abre?" em produção. Melhor gritar aqui.
        console.warn('[WhopProvider] plan id não resolvido na resposta:', JSON.stringify(json));
      }

      return {
        success: true,
        status: 'requires_action',
        provider: this.name,
        accountId: id,
        transactionId,
        // ch_xxx — chave de fallback do webhook quando o metadata não voltar.
        providerTransactionId: sessionId,
        providerStatus: 'pending',
        redirectUrl: purchaseUrl ?? undefined,
        checkout_url: purchaseUrl ?? undefined,
        data: {
          ...json,
          // Bloco que o frontend consome direto no loader.js da Whop.
          embed: {
            planId,
            sessionId,
            returnUrl: redirectUrl,
            // Nome do titular DESTA conta do pool. Vai pro checkout renderizar a
            // frase de termos abaixo do embed — o `hide_tos` some com a versão
            // deles, e sem isto o comprador ficaria sem nenhuma.
            //
            // Muda conforme o roteamento: é a mesma razão social que ele vai ver
            // na fatura do cartão, então mostrar aqui é o que evita o "não
            // reconheço a cobrança" 30 dias depois.
            merchantName: config?.legal_name ?? config?.label ?? null,
          },
        },
      };
    } catch (err: any) {
      console.error('[WhopProvider] charge error:', err?.message);
      return this.failure(id, transactionId, err?.message ?? 'erro desconhecido');
    }
  }

  // ─────────────────────────────────────────────
  // Status autoritativo — o webhook diz o que mudou, isto confirma o quê.
  //
  // Mesmo padrão do Rox Pay: nunca confiamos só no corpo do webhook pra virar
  // uma transação pra 'approved'.
  // ─────────────────────────────────────────────

  // ─────────────────────────────────────────────
  // Upsell de um clique — cobrança off-session do meio de pagamento salvo.
  //
  // POST /api/v1/payments com account_id + member_id + payment_method_id + plano
  // inline (https://docs.whop.com/api-reference/payments/create-payment). O cartão
  // só fica salvo se a compra-mãe passou pelo embed com setup-future-usage=off_session,
  // e só é cobrável pela MESMA company — quem garante isso é o PaymentService.
  //
  // A resposta NÃO é o resultado final: a Whop processa em segundo plano. Quem
  // aprova a transação é o webhook payment.succeeded (casado pelo metadata
  // koopfy_transaction_id, ou pelo pay_xxx gravado como provider_transaction_id).
  // Por isso a resposta de sucesso é sempre 'pending', nunca 'approved'.
  //
  // Plano inline só com os campos documentados para esta rota (currency,
  // initial_price, plan_type, produto). `title`/`visibility` do checkout
  // configuration não aparecem na spec do POST /payments — mandar campo fora do
  // contrato arrisca 400 na hora da cobrança.
  // ─────────────────────────────────────────────

  // ─────────────────────────────────────────────
  // Whop Elements — confirma o token do navegador.
  //
  // O checkout monta Payments + PaymentElement (métodos, com Pix) e os botões de
  // Apple/Google Pay (PaymentRequest). O comprador escolhe o método ali, o
  // navegador gera um `ctok_` com e-mail e endereço que o NOSSO checkout já
  // coletou, e o pay confirma aqui: POST /api/v1/payments com o token + plano
  // inline (https://docs.whop.com/api-reference/payments/create-payment).
  //
  // A resposta não é o resultado final. Pix e 3DS têm um passo do comprador: o
  // `client_secret` volta pro navegador, que chama payments.handleNextAction.
  // Quem aprova a transação é o webhook payment.succeeded (koopfy_transaction_id
  // no metadata), igual ao embed.
  // ─────────────────────────────────────────────

  // Application fee da conta conectada: tudo menos 1 centavo, para o dinheiro
  // ficar na master (ver connectedApplicationFee). A parte do seller vai para
  // a conta dele na liberação, pela carteira da Koopfy.
  private connectedFee(chargeAmount: number) {
    return connectedApplicationFee(chargeAmount);
  }

  private async chargeConfirmationToken(args: {
    accountId: string;
    apiUrl: string;
    apiKey: string;
    companyId: string;
    transactionId: string;
    confirmationToken: string;
    currency: string;
    title: string;
    initialPrice: number;
    subscriptionTerms: {
      billingPeriodDays: number;
      trialPeriodDays: number;
      initialCharge: number;
      renewalPrice: number;
      installments: number | null;
      /** Teste enviado à Whop (o do seller, ou um ciclo para o valor inicial). */
      whopTrialDays: number;
      /** Plano novo na Whop: quem já usou teste num plano reaproveitado não ganha outro. */
      freshPlan: boolean;
    } | null;
    metadata: Record<string, any>;
    returnUrl: string;
    config: any;
    // Só em conta conectada; null na master.
    applicationFee: number | null;
  }): Promise<ChargeResponse> {
    const { accountId, transactionId, subscriptionTerms } = args;

    if (subscriptionTerms?.installments) {
      // split_pay_required_payments não está no contrato do plano inline do
      // POST /payments. Falhar aqui é melhor que cobrar sem o parcelamento.
      return this.failure(accountId, transactionId, 'Whop: parcelamento não suportado no pagamento por token');
    }

    const plan: Record<string, any> = {
      currency: args.currency,
      title: args.title,
      visibility: 'quick_link',
      plan_type: subscriptionTerms ? 'renewal' : 'one_time',
      // Termos já traduzidos da regra da Koopfy (whopRenewalTerms).
      initial_price: subscriptionTerms ? subscriptionTerms.initialCharge : args.initialPrice,
      ...(subscriptionTerms ? {
        renewal_price: subscriptionTerms.renewalPrice,
        billing_period: subscriptionTerms.billingPeriodDays,
        trial_period_days: subscriptionTerms.whopTrialDays || null,
      } : {}),
      ...(args.applicationFee != null ? { application_fee_amount: args.applicationFee } : {}),
      ...this.buildProductLink(args.config),
    };

    const body = {
      account_id: args.companyId,
      confirmation_token: args.confirmationToken,
      plan,
      metadata: args.metadata,
      // Para onde o comprador volta depois de um passo fora da página (banco do
      // Pix, 3DS). Já vem validado como https público pelo charge().
      return_url: args.returnUrl,
    };

    try {
      const res = await fetch(`${args.apiUrl}/api/v1/payments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // Um token por transação nossa: retry de rede não cobra duas vezes.
          'Idempotency-Key': `koopfy_ctok_${transactionId}`,
        },
        body: JSON.stringify(body),
      });

      const json: any = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message = json?.error?.message ?? json?.message ?? `Whop HTTP ${res.status}`;
        const code = whopDeclineCode(json);
        return {
          ...this.failure(accountId, transactionId, message, json),
          ...(code ? { failureCode: code } : {}),
        };
      }

      const paymentId = typeof json?.id === 'string' ? json.id : null;
      const status = String(json?.status ?? '').toLowerCase();
      const substatus = String(json?.substatus ?? '').toLowerCase();
      const clientSecret = typeof json?.client_secret === 'string' ? json.client_secret : undefined;

      if (substatus === 'failed' || status === 'uncollectible' || status === 'void') {
        const reason = json?.failure_message
          ?? (json?.decline_code ? `Pagamento recusado (${json.decline_code})` : 'Pagamento recusado.');
        return {
          ...this.failure(accountId, transactionId, reason, json),
          providerTransactionId: paymentId ?? undefined,
          failureCode: whopDeclineCode(json) ?? 'WHOP_TOKEN_PAYMENT_FAILED',
        };
      }

      return {
        success: true,
        // requires_action enquanto houver passo do comprador possível (Pix, 3DS):
        // o navegador chama handleNextAction com o clientSecret, que resolve na
        // hora quando não há nada pendente.
        status: status === 'paid' ? 'pending' : 'requires_action',
        provider: this.name,
        accountId,
        transactionId,
        providerTransactionId: paymentId ?? undefined,
        providerStatus: substatus || status || 'pending',
        clientSecret,
        data: json,
      };
    } catch (err: any) {
      console.error('[WhopProvider] token charge error:', err?.message);
      return this.failure(accountId, transactionId, err?.message ?? 'erro desconhecido');
    }
  }

  private async chargeSavedPaymentMethod(args: {
    accountId: string;
    apiUrl: string;
    apiKey: string;
    companyId: string;
    transactionId: string;
    memberId: string;
    paymentMethodId: string;
    parentTransactionId: string;
    currency: string;
    initialPrice: number;
    orderRef: string;
    sellerId: string | null;
    productId: string | null;
    returnUrl: string;
    config: any;
    // Só em conta conectada; null na master.
    applicationFee: number | null;
  }): Promise<ChargeResponse> {
    const { accountId, transactionId } = args;

    const body = {
      account_id: args.companyId,
      member_id: args.memberId,
      payment_method_id: args.paymentMethodId,
      plan: {
        currency: args.currency,
        initial_price: args.initialPrice,
        plan_type: 'one_time',
        ...(args.applicationFee != null ? { application_fee_amount: args.applicationFee } : {}),
        ...this.buildProductLink(args.config),
      },
      metadata: {
        koopfy_transaction_id: transactionId,
        koopfy_order_ref: args.orderRef,
        koopfy_seller_id: args.sellerId,
        koopfy_product_id: args.productId,
        koopfy_account_id: accountId,
        koopfy_payment_type: 'upsell',
        koopfy_parent_transaction_id: args.parentTransactionId || null,
      },
      // Para onde o comprador volta se o banco exigir 3DS e ele autenticar pela
      // recovery_url da Whop.
      return_url: args.returnUrl,
    };

    try {
      const res = await fetch(`${args.apiUrl}/api/v1/payments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // Uma cobrança por transação nossa: retry de rede não cobra duas vezes
          // (a Whop devolve a resposta original por 24h).
          'Idempotency-Key': `koopfy_upsell_${transactionId}`,
        },
        body: JSON.stringify(body),
      });

      const json: any = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message = json?.error?.message ?? json?.message ?? `Whop HTTP ${res.status}`;
        const code = whopDeclineCode(json);
        return {
          ...this.failure(accountId, transactionId, message, json),
          ...(code ? { failureCode: code } : {}),
        };
      }

      const paymentId = typeof json?.id === 'string' ? json.id : null;
      const status = String(json?.status ?? '').toLowerCase();
      const substatus = String(json?.substatus ?? '').toLowerCase();

      if (substatus === 'failed' || status === 'uncollectible' || status === 'void') {
        const reason = json?.failure_message
          ?? (json?.decline_code ? `Cartão recusado (${json.decline_code})` : 'Cobrança recusada.');
        return {
          ...this.failure(accountId, transactionId, reason, json),
          providerTransactionId: paymentId ?? undefined,
          failureCode: whopDeclineCode(json) ?? 'WHOP_OFF_SESSION_FAILED',
        };
      }

      const recoveryUrl = typeof json?.recovery_url === 'string' ? json.recovery_url : null;
      if (recoveryUrl && status !== 'paid') {
        // Banco desafiou a cobrança (3DS): o comprador autentica na página da Whop.
        return {
          success: true,
          status: 'requires_action',
          provider: this.name,
          accountId,
          transactionId,
          providerTransactionId: paymentId ?? undefined,
          providerStatus: substatus || status || 'requires_action',
          redirectUrl: recoveryUrl,
          next_action: { type: 'redirect', url: recoveryUrl },
          data: json,
        };
      }

      return {
        success: true,
        status: 'pending',
        provider: this.name,
        accountId,
        transactionId,
        providerTransactionId: paymentId ?? undefined,
        providerStatus: substatus || status || 'pending',
        data: json,
      };
    } catch (err: any) {
      console.error('[WhopProvider] off-session charge error:', err?.message);
      return this.failure(accountId, transactionId, err?.message ?? 'erro desconhecido');
    }
  }

  async getPaymentStatus(
    paymentId: string,
    providerConfig: { api_url?: string; apiKey?: string },
  ): Promise<{ status: string | null; raw: any }> {
    const apiUrl = providerConfig.api_url ?? WHOP_API_URL_DEFAULT;

    const res = await fetch(`${apiUrl}/api/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${providerConfig.apiKey}`,
        Accept: 'application/json',
      },
    });

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message ?? `Whop HTTP ${res.status}`);

    return { status: json?.status ?? null, raw: json };
  }

  // ─────────────────────────────────────────────
  // ASSINATURA — membership da Whop (área do cliente)
  //
  // Cancelar é sempre no fim do período (`at_period_end`): o comprador já pagou
  // o ciclo e mantém o acesso até lá. Reativar (uncancel) desfaz o agendamento
  // enquanto o período não acabou.
  // ─────────────────────────────────────────────

  async getMembership(
    membershipId: string,
    providerConfig: { api_url?: string; apiKey?: string },
  ): Promise<WhopMembershipState> {
    return this.membershipRequest('GET', membershipId, '', providerConfig);
  }

  async cancelMembershipAtPeriodEnd(
    membershipId: string,
    providerConfig: { api_url?: string; apiKey?: string },
  ): Promise<WhopMembershipState> {
    return this.membershipRequest('POST', membershipId, '/cancel', providerConfig, {
      cancellation_mode: 'at_period_end',
    });
  }

  async uncancelMembership(
    membershipId: string,
    providerConfig: { api_url?: string; apiKey?: string },
  ): Promise<WhopMembershipState> {
    return this.membershipRequest('POST', membershipId, '/uncancel', providerConfig);
  }

  private async membershipRequest(
    method: 'GET' | 'POST',
    membershipId: string,
    action: '' | '/cancel' | '/uncancel',
    providerConfig: { api_url?: string; apiKey?: string },
    body?: Record<string, unknown>,
  ): Promise<WhopMembershipState> {
    const apiUrl = providerConfig.api_url ?? WHOP_API_URL_DEFAULT;
    const res = await fetch(`${apiUrl}/api/v1/memberships/${encodeURIComponent(membershipId)}${action}`, {
      method,
      headers: {
        Authorization: `Bearer ${providerConfig.apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json?.id) {
      throw new Error(json?.error?.message ?? json?.message ?? `Whop HTTP ${res.status}`);
    }

    return {
      id: String(json.id),
      status: typeof json.status === 'string' ? json.status : null,
      cancelAtPeriodEnd: json.cancel_at_period_end === true,
      renewalPeriodEnd: typeof json.renewal_period_end === 'string' ? json.renewal_period_end : null,
    };
  }

  // ─────────────────────────────────────────────
  // Registro do webhook da conta (usado no onboarding de uma company nova).
  //
  // N contas = N webhooks = N segredos. Fazer isso na mão em cada company é
  // exatamente onde se erra — e um webhook não registrado só aparece como
  // "pagamento que nunca confirma", horas depois.
  // ─────────────────────────────────────────────

  async registerWebhook(args: {
    apiUrl?: string;
    apiKey: string;
    companyId: string;
    accountId: string;
    publicApiUrl?: string;
  }): Promise<{ webhookId: string; webhookSecret: string }> {
    const apiUrl = args.apiUrl ?? WHOP_API_URL_DEFAULT;
    const base = args.publicApiUrl ?? process.env.PAY_PUBLIC_URL ?? 'https://api.koopfy.com/pay';

    const res = await fetch(`${apiUrl}/api/v1/webhooks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        // ⚠️ `resource_id`, NÃO `company_id`. Este endpoint é a exceção: em
        // products/plans a company vai como `company_id` (query), aqui isso dá
        // 400 "Invalid value for parameter 'company_id'". Sem nenhum dos dois,
        // dá "Please provide a resource id or have a current company in context"
        // — a chave de API não carrega company em contexto. Confirmado na API.
        resource_id: args.companyId,
        // O account id viaja no metadata de toda checkout configuration e o
        // handler compartilhado usa esse valor para resolver o segredo correto.
        url: `${base}/webhook/whop`,
        events: [
          'payment.succeeded',
          'payment.failed',
          'membership.activated',
          'membership.deactivated',
          'membership.cancel_at_period_end_changed',
          'refund.created',
          'dispute.created',
          // Alerta antecipado de chargeback (Visa/Mastercard): a Whop pode estornar
          // a venda sozinha — a taxa de chargeback é cobrada do seller.
          'dispute_alert.created',
        ],
        api_version: 'v1',
        enabled: true,
      }),
    });

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message ?? `Whop HTTP ${res.status}`);

    return { webhookId: json?.id, webhookSecret: json?.webhook_secret };
  }

  // ─────────────────────────────────────────────
  // Descobre a company a partir da CHAVE.
  //
  // É o que permite cadastrar uma conta nova colando só a API key: a chave já
  // está amarrada a uma company, e este endpoint devolve qual. Pedir o
  // company_id no formulário seria pedir um dado que a própria chave carrega —
  // e é justamente o campo que a pessoa erra copiando.
  // ─────────────────────────────────────────────

  async discoverCompany(
    apiKey: string,
    apiUrl?: string,
  ): Promise<{ id: string; title: string | null }> {
    const base = apiUrl ?? WHOP_API_URL_DEFAULT;

    // /api/v5 (não v1): é a única rota que resolve a company sem já saber o id.
    const res = await fetch(`${base}/api/v5/company`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json?.id) {
      throw new Error(json?.message ?? json?.error?.message ?? `Whop HTTP ${res.status}`);
    }

    return { id: json.id, title: json.title ?? null };
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  // ─────────────────────────────────────────────
  // MÉTODOS DE PAGAMENTO
  //
  // Regra em duas linhas:
  //   • comprador ainda NÃO escolheu → todos, e a Whop filtra por país/moeda
  //   • comprador JÁ escolheu (Pix, iDEAL…) → abre o embed direto naquele
  //
  // O primeiro caso é o que responde "habilita todos e seja inteligente por
  // país": `include_platform_defaults: true` entrega tudo que a company tem
  // ativo E é válido pro comprador. Montar a lista à mão aqui só conseguiria
  // ESCONDER método — nós não sabemos o que cada company habilitou nem quais
  // gates de país/moeda a Whop aplica.
  //
  // ⚠️ `enabled` é obrigatório mesmo vazio: omitir dá 400
  // "Missing required parameter: payment_method_configuration.enabled".
  // ─────────────────────────────────────────────

  private buildPaymentMethods(method: string | undefined, config: any, currency?: string) {
    // Trava por conta (opcional): titular que só quer cartão, por exemplo.
    const blocked: string[] = Array.isArray(config?.disabled_methods)
      ? config.disabled_methods.filter((m: string) => WHOP_PAYMENT_METHODS.has(m))
      : [];

    const chosen = KOOPFY_METHOD_TO_WHOP[String(method ?? '').toLowerCase()];

    // ⚠️ Cartão e CARTEIRAS não restringem. Apple Pay, Google Pay e Link são
    // renderizados DENTRO do formulário de cartão do embed — não são entradas
    // independentes. Mandar `enabled: ['apple_pay']` deixa a sessão presa numa
    // carteira só: some o cartão, e se o dispositivo do comprador não suportar
    // Apple Pay ele fica sem NENHUMA forma de pagar.
    //
    // Isto precisa espelhar WHOP_NON_RESTRICTING no AtlasCheckout: lá o front
    // decide quando recriar a sessão. Se as duas listas divergirem, o comprador
    // troca de método na nossa UI e continua na sessão anterior.
    // ⚠️ RESTRIÇÃO É OPT-IN, e desligada por padrão.
    //
    // Restringir a sessão a um método (`include_platform_defaults: false`) é só
    // uma comodidade — abrir o embed direto no método que o comprador clicou.
    // Mas o modo de falha é catastrófico: quando o método não está disponível
    // (moeda errada, não habilitado na company, gate de país), a Whop NÃO dá
    // erro — renderiza o formulário vazio, só com o botão. O comprador não tem
    // como pagar nem como entender por quê.
    //
    // Aconteceu em produção com iDEAL (NL) e Bancontact (BE). A API aceita a
    // configuração normalmente nos dois casos, então não há como validar pelo
    // retorno: só olhando o iframe, que é cross-origin.
    //
    // Trocamos comodidade por robustez. Com `include_platform_defaults: true` a
    // Whop mostra o que a company tem ativo E é válido pro comprador — inclusive
    // o método que ele escolheu, quando ele existe. Ele só precisa clicar de novo
    // lá dentro.
    //
    // Pra reativar numa conta específica (depois de conferir no navegador que o
    // método renderiza): whop_accounts.metadata.restrict_to_selected_method = true.
    const restringir = config?.restrict_to_selected_method === true;

    if (restringir && chosen && !WHOP_NON_RESTRICTING.has(chosen) && !blocked.includes(chosen)) {
      const exigidas = WHOP_METHOD_CURRENCIES[chosen];
      const cur = String(currency ?? '').toUpperCase();

      if (exigidas && !exigidas.includes(cur)) {
        console.warn(
          `[WhopProvider] método "${chosen}" exige ${exigidas.join('/')} mas a `
          + `transação é em ${cur || '(sem moeda)'} — sessão NÃO restrita.`,
        );
      } else {
        return { enabled: [chosen], disabled: [], include_platform_defaults: false };
      }
    }

    return { enabled: [], disabled: blocked, include_platform_defaults: true };
  }

  // ─────────────────────────────────────────────
  // PRODUTO
  //
  // `external_identifier` é o default porque DEDUPLICA (confirmado na API): o
  // mesmo identificador sempre cai no mesmo produto, então N compras viram N
  // planos sob UM produto — que é exatamente o desenho pedido, e sem depender de
  // alguém ter criado o produto antes na company.
  //
  // ⚠️ O identificador é CONSTANTE por conta, nunca o id do produto da Koopfy:
  // usar o produto da Koopfy criaria um produto Whop por SKU, o oposto do que
  // se quer. O nome que o comprador lê vem do `plan.title`, não daqui.
  // ─────────────────────────────────────────────

  // https + hostname com domínio. Fora: localhost, IPs de loopback, *.local e
  // hosts sem ponto — a Whop recusa todos como redirect_url.
  private isPublicHttpsUrl(value: string): boolean {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return false;
      const host = url.hostname.toLowerCase();
      if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
      if (host === '127.0.0.1' || host === '::1' || host === '[::1]') return false;
      return host.includes('.');
    } catch {
      return false;
    }
  }

  private buildProductLink(config: any) {
    const mode: ProductLinkMode = config?.product_link_mode
      ?? (config?.product_id ? 'product_id' : 'external_identifier');

    if (mode === 'none') return {};

    if (mode === 'product_id') {
      return config?.product_id ? { product_id: config.product_id } : {};
    }

    return {
      product: {
        // O mesmo produto em que o sync grava o descritor da fatura (ver
        // KOOPFY_PRODUCT_EXTERNAL_ID em whop-connected.ts).
        external_identifier: String(config?.product_external_id ?? KOOPFY_PRODUCT_EXTERNAL_ID),
        title: String(config?.product_title ?? 'Koopfy').slice(0, WHOP_PLAN_TITLE_MAX),
      },
    };
  }

  private async recordRecurringPlan(args: {
    accountId: string;
    koopfyProductId: string;
    planId: string;
    whopProductId: string | null;
    currency: string;
    renewalPrice: number;
    billingPeriodDays: number;
    trialPeriodDays: number;
    initialCharge: number;
    installments: number | null;
  }): Promise<void> {
    const terms = {
      currency: args.currency,
      renewal_price: args.renewalPrice,
      billing_period_days: args.billingPeriodDays,
      trial_period_days: args.trialPeriodDays,
      initial_price: args.initialCharge,
      split_pay_required_payments: args.installments,
    };
    // Inclui o produto: dois sellers/produtos com o mesmo preço não são a mesma
    // versão comercial, mesmo que a Whop os mantenha no container compartilhado.
    const fingerprint = `${args.koopfyProductId}:${args.currency}:${args.renewalPrice}:${args.initialCharge}:${args.billingPeriodDays}:${args.trialPeriodDays}:${args.installments ?? 'unlimited'}`;
    const { error } = await supabase.from('whop_plan_mappings').upsert({
      koopfy_product_id: args.koopfyProductId,
      whop_account_id: args.accountId,
      terms_fingerprint: fingerprint,
      whop_product_id: args.whopProductId,
      whop_plan_id: args.planId,
      terms,
      status: 'active',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'koopfy_product_id,whop_account_id,terms_fingerprint' });
    if (error && !/relation .* does not exist|schema cache/i.test(error.message)) {
      throw error;
    }
  }

  // purchase_url vem como `/checkout/plan_xxx?session=ch_yyy`. O plan id nem
  // sempre aparece como campo próprio, então lemos os dois caminhos.
  // Renovação na moeda da cobrança. O checkout manda `subscription_charge` já
  // convertido (plano em USD, checkout em BRL); sem ele, só vale o plano quando
  // a moeda é a mesma. NaN = não dá pra saber sem converter no escuro.
  private renewalPriceInChargeCurrency(metadata: any, cur: string): number {
    const charge = metadata?.subscription_charge;
    if (charge && String(charge.currency ?? '').toLowerCase() === cur) {
      return Number(charge.renewal_price);
    }
    const plan = metadata?.pricing_plan;
    if (plan && String(plan.currency ?? '').toLowerCase() === cur) {
      return Number(plan.renewal_price);
    }
    return NaN;
  }

  private extractPlanId(json: any): string | null {
    const direct = json?.plan_id ?? json?.plan?.id ?? null;
    if (direct) return String(direct);

    const url = json?.purchase_url;
    if (typeof url !== 'string') return null;

    const match = url.match(/\/checkout\/(plan_[A-Za-z0-9]+)/);
    return match ? match[1] : null;
  }

  private failure(
    accountId: string,
    transactionId: string,
    message: string,
    raw?: any,
  ): ChargeResponse {
    console.error('[WhopProvider] failure:', message, raw ? JSON.stringify(raw) : '');
    return {
      success: false,
      status: 'failed',
      provider: this.name,
      accountId,
      transactionId,
      providerStatus: 'failed',
      failureMessage: message,
      data: raw,
    };
  }
}

/**
 * Código da recusa na resposta da Whop (`insufficient_funds`, `expired_card`…).
 * O checkout traduz o código para o comprador; a mensagem crua vem em inglês.
 */
export function whopDeclineCode(json: any): string | null {
  const candidates = [
    json?.decline_code,
    json?.last_payment_error?.decline_code,
    json?.error?.decline_code,
    json?.last_payment_error?.code,
    json?.error?.code,
  ];
  const code = candidates.find((c) => typeof c === 'string' && /^[a-z0-9_]{3,64}$/i.test(c));
  return code ? code.toLowerCase() : null;
}
