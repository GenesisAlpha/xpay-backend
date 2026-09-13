import { ChargeResponse, RetrieveResponse } from './provider.types';

// ============================================================================
// CLIP (México) — Checkout Transparente, cartão tokenizado no client
// ----------------------------------------------------------------------------
// O DESENHO EM UMA FRASE: o browser monta o iframe da Clip com a PUBLIC KEY da
// conta que o router reservou, tokeniza o cartão, e nós cobramos aqui com o
// SECRET DA MESMA CONTA.
//
// ⚠️ O TOKEN É PRESO À CONTA — É A RESTRIÇÃO QUE DEFINE TUDO.
// Um token gerado pela public key da conta A só é cobrável pelo secret da conta
// A. Três consequências que não têm contorno:
//
//   1. A conta é escolhida ANTES de o formulário existir. Rotear aqui dentro é
//      impossível: o token já chegou amarrado.
//   2. NÃO EXISTE FAILOVER. Recusou na conta A, não dá para tentar na B sem o
//      comprador redigitar o cartão. Por isso este provider marca as falhas
//      como `accountLevel: false` na maioria dos casos — abrir o circuit
//      breaker aqui tiraria do pool uma conta saudável sem ganhar nada.
//   3. Os upsells re-tokenizam o MESMO SDK vivo e caem obrigatoriamente na
//      conta da venda base. Por isso a reserva guarda folga (upsell_headroom).
//
// ⚠️ UNIDADES. O pay guarda `amount` em CENTAVOS. A Clip cobra em unidade
// decimal ("1247.63"), não em centavos. Mandar 124763 cobra $124.763,00 — cem
// vezes o valor, e cobra "com sucesso".
//
// ⚠️ MOEDA. Sempre MXN. A conta é mexicana e o teto do gateway é em peso.
//
// ⚠️ NÃO usamos binary_mode. Omitido de propósito: com binary_mode a Clip
// RECUSA em vez de abrir o desafio 3DS, e 3DS recusado é venda perdida que
// teria passado.
// ============================================================================

const CLIP_API = 'https://api.payclip.com';

// Códigos que são da CONTA, não do cartão. Só estes justificam mexer na saúde
// da conta no circuit breaker do router. Um `declined` do emissor não diz nada
// sobre a nossa conta — e, como não há failover possível, penalizar a conta por
// causa dele só reduz capacidade num momento de pico.
const ACCOUNT_LEVEL_ERROR_CODES = new Set([
  'CL2001', // credencial inválida / não autorizada
  'CL2002', // conta inativa ou suspensa
  'CL4030', // forbidden
]);

type ClipCtx = {
  transactionId: string;
  amount: number;                // CENTAVOS
  currency?: string;
  installments?: number;
  external_reference?: string;
  customer?: any;
  payment_data?: any;
  providerConfig: {
    id: string;
    apiKey?: string;             // SECRET da conta (decifrado pelo pool)
    config?: Record<string, any>; // { public_key, currency, ... }
  };
  [k: string]: any;
};

export class ClipProvider {
  name = 'clip';

  // ─────────────────────────────────────────────
  // CHARGE
  // ─────────────────────────────────────────────

  async charge(ctx: ClipCtx): Promise<ChargeResponse> {
    const { transactionId, providerConfig } = ctx;
    const accountId = providerConfig?.id ?? 'clip_unknown';
    const secretKey = providerConfig?.apiKey;
    const cfg = providerConfig?.config ?? {};
    const publicKey = cfg.public_key;

    if (!secretKey) {
      return this.failure(
        accountId, transactionId, 'config',
        `Clip: conta ${accountId} sem secret utilizável (não cadastrada ou falha ao decifrar)`,
        true,
      );
    }
    // ⚠️ O Basic auth da Clip é public_key:secret_key — NÃO secret sozinho, e
    // NÃO uma env global. Com a public key de outra conta o par não autentica,
    // e o erro que volta não diz que o problema é esse.
    if (!publicKey) {
      return this.failure(
        accountId, transactionId, 'config',
        `Clip: conta ${accountId} sem public_key — o par public:secret é o que autentica`,
        true,
      );
    }

    const token = ctx.payment_data?.clipToken ?? ctx.payment_data?.token ?? ctx.token;
    if (!token) {
      return this.failure(
        accountId, transactionId, 'validation',
        'Clip: card token ausente (o SDK do client não tokenizou)',
        false,
      );
    }

    // Centavos → decimal. Ver o aviso de UNIDADES no topo.
    const amountDecimal = Math.round(Number(ctx.amount)) / 100;
    if (!Number.isFinite(amountDecimal) || amountDecimal <= 0) {
      return this.failure(
        accountId, transactionId, 'validation',
        `Clip: amount inválido (${ctx.amount})`, false,
      );
    }

    const brand = String(cfg.brand_domain ?? cfg.domain ?? 'patioar.com');
    const payload = this.buildPayload(ctx, amountDecimal, brand);

    let res = await this.request('/payments', 'POST', payload, publicKey, secretKey);
    console.log(
      `[ClipProvider] ${accountId} tx=${transactionId} amount=${amountDecimal} `
      + `inst=${payload.installments ?? '-'} ${this.diag(res)}`,
    );

    // ── Rede de segurança do CL2200 ─────────────────────────────────────────
    //
    // CL2200 é erro de VALIDAÇÃO do request — não cria cobrança e não consome o
    // token, então reenviar não arrisca cobrança dupla. O caso que mais derruba
    // venda: e-mail do comprador inválido (ponto duplo, sem TLD) reprovando o
    // pagamento INTEIRO. Reenvia uma vez com e-mail de respaldo, preservando
    // metadata.website (sinal antifraude) e removendo só os endereços espelhados.
    //
    // Aprendido na borda em tkt-page/netlify/functions/clip-pay.js — não
    // simplificar sem reproduzir os dois casos.
    if (res.status >= 400 && /CL2200/.test(res.body)) {
      const emailBad = /email/i.test(res.body);
      console.log(
        `[ClipProvider] ${accountId} CL2200${emailBad ? ' (email inválido → fallback)' : ''} `
        + '→ reenviando sem endereços espelhados',
      );
      delete payload.location;
      if (emailBad && payload.customer) payload.customer.email = `cliente@${brand}`;
      if (payload.metadata) {
        delete payload.metadata.billing_address;
        delete payload.metadata.shipping_address;
      }
      res = await this.request('/payments', 'POST', payload, publicKey, secretKey);
      console.log(`[ClipProvider] ${accountId} retry ${this.diag(res)}`);
    }

    let body: any = {};
    try { body = JSON.parse(res.body); } catch { body = {}; }

    if (res.status >= 400 || res.status === 0) {
      const code = body?.status_detail?.code ?? body?.error_code ?? String(res.status);
      return this.failure(
        accountId, transactionId, code,
        body?.message ?? body?.detail ?? 'Clip recusou a cobrança',
        ACCOUNT_LEVEL_ERROR_CODES.has(code),
        body,
      );
    }

    const status = String(body?.status ?? '').toLowerCase();
    const paymentId = body?.id ?? null;

    // ── 3DS ─────────────────────────────────────────────────────────────────
    // `pending` com pending_action.url = desafio do emissor. NÃO é falha: a
    // venda ainda pode passar. Devolvemos a URL para o front abrir o iframe, e
    // o desfecho chega por clip-status (polling) ou pelo webhook.
    const pendingUrl = body?.pending_action?.url ?? null;
    if (status === 'pending' && pendingUrl) {
      return {
        success: true,
        status: 'pending',
        provider: this.name,
        accountId,
        transactionId,
        providerTransactionId: paymentId,
        providerStatus: status,
        next_action: { type: 'three_ds_redirect', url: pendingUrl },
        redirectUrl: pendingUrl,
        data: body,
      };
    }

    const approved = status === 'approved' || status === 'paid' || status === 'completed';

    if (!approved) {
      const code = body?.status_detail?.code ?? status ?? 'declined';
      return this.failure(
        accountId, transactionId, code,
        body?.status_detail?.message ?? 'Pagamento recusado pelo emissor',
        // Recusa do emissor é do INSTRUMENTO. Marcar como falha da conta
        // abriria o circuit breaker num pico de recusas e tiraria do pool uma
        // conta perfeitamente saudável.
        false,
        body,
      );
    }

    return {
      success: true,
      status: 'paid',
      provider: this.name,
      accountId,
      transactionId,
      providerTransactionId: paymentId,
      providerStatus: status,
      data: body,
    };
  }

  // ─────────────────────────────────────────────
  // RETRIEVE — usado no polling do 3DS e na conciliação
  // ─────────────────────────────────────────────

  async retrieve(ctx: {
    providerTransactionId: string;
    providerConfig: { id: string; apiKey?: string; config?: Record<string, any> };
  }): Promise<RetrieveResponse> {
    const secretKey = ctx.providerConfig?.apiKey;
    const publicKey = ctx.providerConfig?.config?.public_key;
    if (!secretKey || !publicKey) {
      return { success: false, status: 'unknown' };
    }

    const res = await this.request(
      `/payments/${encodeURIComponent(ctx.providerTransactionId)}`,
      'GET', null, publicKey, secretKey,
    );

    let body: any = {};
    try { body = JSON.parse(res.body); } catch { body = {}; }

    if (res.status >= 400 || res.status === 0) {
      return { success: false, status: 'unknown', raw: body };
    }

    const s = String(body?.status ?? '').toLowerCase();
    const status: RetrieveResponse['status'] =
      s === 'approved' || s === 'paid' || s === 'completed' ? 'paid'
        : s === 'pending' ? 'pending'
          : s === 'rejected' || s === 'declined' || s === 'canceled' ? 'failed'
            : 'unknown';

    return {
      success: true,
      status,
      providerTransactionId: body?.id ?? ctx.providerTransactionId,
      method: 'card',
      raw: body,
    };
  }

  // ─────────────────────────────────────────────
  // PAYLOAD
  //
  // Cada campo aqui existe porque MOVE a taxa de aprovação. A Clip pontua o
  // request: titular, endereço (AVS), fingerprint do device. Enviar o mínimo
  // aprova menos — e a diferença aparece direto na receita.
  // ─────────────────────────────────────────────

  private buildPayload(ctx: ClipCtx, amountDecimal: number, brand: string) {
    const c = ctx.customer ?? {};
    const s = (v: any, max = 255) => String(v ?? '').trim().slice(0, max);

    const payload: any = {
      amount: amountDecimal,
      currency: 'MXN',
      description: s(ctx.description, 120) || 'Pedido',
      payment_method: { token: ctx.payment_data?.clipToken ?? ctx.payment_data?.token ?? ctx.token },
      customer: {
        email: s(c.email, 120) || `cliente@${brand}`,
        phone: s(c.phone, 20).replace(/\D/g, '').slice(-10) || '5555555555',
      },
    };

    if (c.first_name) payload.customer.first_name = s(c.first_name, 60);
    if (c.last_name) payload.customer.last_name = s(c.last_name, 60);

    // Referência de conciliação da Clip: só - e _, máximo 36.
    if (ctx.external_reference) {
      const ref = s(ctx.external_reference, 60).replace(/[^\w-]/g, '').slice(0, 36);
      if (ref) payload.external_reference = ref;
    }

    // Identificação oficial (INE/CURP) — reforça o antifraude.
    // ⚠️ A subchave do número é `id`, NÃO `number`, e os tipos têm casing
    // exato: INE | CURP | pasaporte. Errar qualquer um dos dois faz a Clip
    // descartar o dado em silêncio (sem erro, sem benefício).
    if (c.id_number) {
      const idNum = s(c.id_number, 30).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const t = s(c.id_type, 12).toUpperCase();
      const idType = t === 'INE' ? 'INE' : t === 'PASAPORTE' ? 'pasaporte' : 'CURP';
      if (idNum) payload.customer.identification = { id: idNum, type: idType };
    }

    // ── AVS ─────────────────────────────────────────────────────────────────
    // postal_code + exterior_number são os de maior impacto; AMEX exige
    // postal_code + street + exterior_number.
    // ⚠️ O REQUEST usa exterior_number/interior_number; a RESPONSE devolve
    // external_number/internal_number. Mandar a grafia da resposta faz a Clip
    // descartar o campo.
    const street = s(c.street ?? c.address, 120);
    const postalCode = s(c.postal_code ?? c.zip, 20).replace(/\D/g, '').slice(0, 5);
    const extNum = this.exteriorNumber(street);

    const address: any = {};
    if (postalCode) address.postal_code = postalCode;
    if (street) {
      address.street = street;
      if (extNum) address.exterior_number = extNum;
    }
    if (c.city) address.city = s(c.city, 80);
    if (c.state) address.state = s(c.state, 80);
    if (Object.keys(address).length) {
      address.country = 'MX';
      payload.customer.address = address;
    }

    // ── Antifraude: fingerprint do device ───────────────────────────────────
    // ⚠️ location.ip NÃO está no schema atual de /payments e disparava CL2200.
    // O sinal de device vai por prevention_data.session_id — não reintroduza
    // location sem confirmar no schema da Clip.
    const pd: any = {};
    const sessionId = ctx.payment_data?.clipSessionId ?? ctx.session_id;
    if (sessionId) pd.session_id = s(sessionId, 100);
    const ua = s(ctx.user_agent ?? ctx.payment_data?.userAgent, 400);
    if (ua) pd.user_agent = ua;
    if (Object.keys(pd).length) payload.prevention_data = pd;

    // metadata espelhado (billing/shipping). `colony` NÃO é campo válido aqui —
    // a Clip rejeitava com CL2200 (metadata.*_address.colony is invalid).
    if (Object.keys(address).length) {
      payload.metadata = {
        billing_address: { ...address },
        shipping_address: { ...address },
      };
    }

    // MSI (meses sem juros). A conta aceita 3 e 6 — outros valores fazem a Clip
    // recusar o pagamento inteiro, então filtramos em vez de repassar.
    const inst = Number(ctx.installments);
    if (inst === 3 || inst === 6) payload.installments = inst;

    return payload;
  }

  // Número exterior: corta o que vier depois de um marcador de interior e pega
  // o ÚLTIMO grupo numérico, preservando sufixos como "45-A".
  //   "Av. 5 de Mayo 123" → 123 | "Juárez 45-A" → 45-A | "Insurgentes 1602 Piso 4" → 1602
  private exteriorNumber(street: string): string {
    const head = String(street ?? '').split(
      /\b(?:int\.?|interior|depto\.?|dpto\.?|departamento|piso|casa|edif\.?|edificio|mz\.?|manzana|lote|lt\.?)\b/i,
    )[0];
    const m = head.match(/\d+[A-Za-z]?(?:\s*-\s*[A-Za-z0-9]+)?/g);
    return m?.length ? m[m.length - 1].replace(/\s+/g, '').slice(0, 10) : '';
  }

  // ─────────────────────────────────────────────
  // HTTP
  // ─────────────────────────────────────────────

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body: any,
    publicKey: string,
    secretKey: string,
  ): Promise<{ status: number; body: string }> {
    const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
    try {
      const res = await fetch(CLIP_API + path, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.text() };
    } catch (e: any) {
      return { status: 0, body: JSON.stringify({ error: e?.message ?? 'network' }) };
    }
  }

  // Diagnóstico compacto. A Clip devolve o campo culpado em `detail` — sem isso
  // o CL2200 vira adivinhação.
  private diag(r: { status: number; body: string }): string {
    try {
      const e = JSON.parse(r.body);
      return JSON.stringify({
        http: r.status,
        status: e.status ?? null,
        code: e.status_detail?.code ?? e.error_code ?? null,
        detail: e.detail ?? null,
        msg: e.message ?? null,
      });
    } catch {
      return JSON.stringify({ http: r.status, raw: String(r.body).slice(0, 160) });
    }
  }

  // ⚠️ NUNCA logar o secret nem o token do cartão aqui.
  private failure(
    accountId: string,
    transactionId: string,
    code: string,
    message: string,
    accountLevel: boolean,
    raw?: any,
  ): ChargeResponse {
    return {
      success: false,
      status: 'failed',
      provider: this.name,
      accountId,
      transactionId,
      providerStatus: code,
      failureCode: code,
      failureMessage: message,
      // Lido por AccountRouterService.isAccountLevelFailure. `false` preserva a
      // saúde da conta em recusa de emissor — ver o comentário no topo.
      data: { accountLevel, raw },
    };
  }
}
