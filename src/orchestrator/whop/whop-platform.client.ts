import { Injectable } from '@nestjs/common';

// ============================================================================
// WHOP PLATFORM API — chamadas da conta master sobre as contas conectadas
// ----------------------------------------------------------------------------
// Contratos: https://docs.whop.com/api-reference/beta/accounts/create-account
// e vizinhos (verifications, files, transfers). A chave é a Account API key da
// MASTER: é ela que torna a conta criada filha da Koopfy
// (company:create_child). WHOP_PLATFORM_API_KEY permite separar a chave de
// plataforma da chave de cobrança; sem ela, usa WHOP_API_KEY.
//
// Idempotency-Key em todo POST que cria algo: um retry de rede com a mesma
// chave devolve a resposta original (24h) em vez de criar outra conta,
// verificação ou transferência.
// ============================================================================

// Duplicado de whop-accounts.service de propósito: importar de lá fecharia um
// ciclo (whop-accounts → whop-connect → este arquivo) e a injeção do Nest
// recebe `undefined` no meio do ciclo.
const WHOP_PLATFORM_API_URL_DEFAULT = 'https://api.whop.com';

// Payouts é da API versionada da Whop (sucessora de payout_methods/withdrawals).
// A data fixa o contrato: sem ela, uma mudança da Whop mudaria a resposta.
const WHOP_PAYOUTS_API_VERSION_DEFAULT = '2026-09-15';

export class WhopApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'WhopApiError';
  }

  details: unknown = null;
}

@Injectable()
export class WhopPlatformClient {
  isConfigured(): boolean {
    return this.apiKey().length > 0;
  }

  /** Credenciais para a conta conectada no router (a cobrança usa a mesma chave de plataforma). */
  credentials(): { apiKey: string; apiUrl: string } {
    return { apiKey: this.apiKey(), apiUrl: this.apiUrl() };
  }

  createAccount(body: Record<string, any>, idempotencyKey: string) {
    return this.request('POST', '/accounts', { body, idempotencyKey });
  }

  updateAccount(accountId: string, body: Record<string, any>) {
    return this.request('PATCH', `/accounts/${encodeURIComponent(accountId)}`, { body });
  }

  /** `me` devolve a própria conta master. `balances[]` só vem com company:balance:read. */
  getAccount(accountId: string) {
    return this.request('GET', `/accounts/${encodeURIComponent(accountId)}`);
  }

  createVerification(accountId: string, body: Record<string, any>, idempotencyKey: string) {
    return this.request('POST', '/verifications', { query: { account_id: accountId }, body, idempotencyKey });
  }

  listVerifications(accountId: string) {
    return this.request('GET', '/verifications', { query: { account_id: accountId } });
  }

  /** Responde pedidos de informação: `{ requested_information: [{ id, value | address | files | documents }] }`. */
  updateVerification(verificationId: string, body: Record<string, any>) {
    return this.request('PATCH', `/verifications/${encodeURIComponent(verificationId)}`, { body });
  }

  listProducts(accountId: string) {
    return this.request('GET', '/products', { query: { account_id: accountId, first: '100' } });
  }

  getProduct(productId: string) {
    return this.request('GET', `/products/${encodeURIComponent(productId)}`);
  }

  /** Token curto da própria Whop, restrito às ações pedidas (ex.: identity:*). */
  createAccessToken(body: { account_id: string; scoped_actions: string[]; expires_at?: string }) {
    return this.request('POST', '/access_tokens', { body });
  }

  updateProduct(productId: string, body: Record<string, any>) {
    return this.request('PATCH', `/products/${encodeURIComponent(productId)}`, { body });
  }

  /**
   * Link hospedado e temporário para a conta conectada (ex.: `account_onboarding`,
   * o formulário de verificação). ⚠️ O token dele carrega permissões de saque e
   * de conta bancária: gerar na hora do clique, nunca guardar nem enviar por e-mail.
   */
  createAccountLink(body: { company_id: string; use_case: string; refresh_url: string; return_url: string }) {
    return this.request('POST', '/account_links', { body });
  }

  /**
   * Sobe um arquivo privado e devolve o `file_` para usar em respostas de RFI.
   * Dois passos: cria o registro (POST /files) e manda os bytes para a URL
   * assinada que ele devolve.
   */
  async uploadFile(args: { filename: string; contentType: string; data: Buffer }): Promise<string> {
    const file = await this.request('POST', '/files', { body: { filename: args.filename, visibility: 'private' } });
    const id = typeof file?.id === 'string' ? file.id : null;
    const uploadUrl = typeof file?.upload_url === 'string' ? file.upload_url : null;
    if (!id || !uploadUrl) throw new WhopApiError('Whop não devolveu a URL de upload do arquivo', 502, 'upload', null);

    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': args.contentType, ...(file?.upload_headers ?? {}) },
      // Uint8Array, não Buffer: o fetch nativo não tipa Buffer como corpo.
      body: new Uint8Array(args.data),
    });
    if (!res.ok) throw new WhopApiError(`Upload do arquivo recusado (HTTP ${res.status})`, res.status, 'upload', null);

    return id;
  }

  // A chave vai no header E no corpo (`idempotence_key`): o corpo é o que a
  // Whop usa para devolver a MESMA transferência num retry depois das 24h.
  createTransfer(body: Record<string, any>, idempotencyKey: string) {
    return this.request('POST', '/transfers', { body: { ...body, idempotence_key: idempotencyKey }, idempotencyKey });
  }

  getTransfer(transferId: string) {
    return this.request('GET', `/transfers/${encodeURIComponent(transferId)}`);
  }

  // ── Payouts (API versionada) ─────────────────────────────────────────────
  // A chave de plataforma age em nome da conta filha: cadastra a conta
  // bancária dela e saca para essa conta.

  /** Contas bancárias/carteiras salvas na conta conectada. */
  listSavedPayoutMethods(accountId: string) {
    return this.payouts('GET', '/payouts/methods', { query: { account_id: accountId, first: '50' } });
  }

  /**
   * Trilhos que a conta pode cadastrar num país. Com
   * `supportedPayoutMethodId`, vem `required_fields` — os campos a pedir.
   */
  listSupportedPayoutMethods(args: {
    accountId: string;
    country?: string | null;
    supportedPayoutMethodId?: string | null;
    destinationCurrency?: string | null;
  }) {
    const query: Record<string, string> = { account_id: args.accountId, first: '100' };
    if (args.country) query.country = args.country;
    if (args.supportedPayoutMethodId) query.supported_payout_method_id = args.supportedPayoutMethodId;
    if (args.destinationCurrency) query.destination_currency = args.destinationCurrency;
    return this.payouts('GET', '/payouts/supported_methods', { query });
  }

  /**
   * Cadastra a conta bancária com os dados digitados pelo seller. Os campos
   * sensíveis são cofrados pela Whop em trânsito; a Koopfy não os guarda.
   */
  createSavedPayoutMethod(body: Record<string, any>, idempotencyKey: string) {
    return this.payouts('POST', '/payouts/methods', { body, idempotencyKey });
  }

  /**
   * Cotação do saque. Conta com `payout_quote_required` recusa payout sem o
   * `quote_token` devolvido aqui (erro `invalid_payout_quote`). A cotação
   * expira em pouco tempo; nada se move até o POST /payouts.
   */
  createPayoutQuote(body: Record<string, any>, idempotencyKey: string) {
    return this.payouts('POST', '/payouts/quotes', { body, idempotencyKey });
  }

  /** Saque da conta conectada para uma conta salva. Devolve o pedido (`cofr_`). */
  createPayout(body: Record<string, any>, idempotencyKey: string) {
    return this.payouts('POST', '/payouts', { body, idempotencyKey });
  }

  /** Aceita o `cofr_` devolvido na criação ou o `wdrl_` da listagem. */
  getPayout(payoutId: string) {
    return this.payouts('GET', `/payouts/${encodeURIComponent(payoutId)}`);
  }

  private payouts(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: Record<string, any>; query?: Record<string, string>; idempotencyKey?: string } = {},
  ) {
    const version = process.env.WHOP_PAYOUTS_API_VERSION?.trim() || WHOP_PAYOUTS_API_VERSION_DEFAULT;
    return this.request(method, path, { ...opts, headers: { 'Api-Version-Date': version } });
  }

  private apiKey(): string {
    return process.env.WHOP_PLATFORM_API_KEY?.trim() || process.env.WHOP_API_KEY?.trim() || '';
  }

  private apiUrl(): string {
    return process.env.WHOP_API_URL?.trim() || WHOP_PLATFORM_API_URL_DEFAULT;
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    opts: {
      body?: Record<string, any>;
      query?: Record<string, string>;
      idempotencyKey?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<any> {
    const apiKey = this.apiKey();
    if (!apiKey) throw new WhopApiError('Whop: WHOP_API_KEY ausente', 0, 'configuration', null);

    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    Object.assign(headers, opts.headers ?? {});

    const res = await fetch(`${this.apiUrl()}/api/v1${path}${qs}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = json?.error ?? {};
      const failure = new WhopApiError(
        error.message ?? json?.message ?? `Whop HTTP ${res.status}`,
        res.status,
        error.type ?? null,
        error.code ?? null,
      );
      // Cadastro de conta recusado: a Whop devolve o schema dos campos junto.
      failure.details = error.details ?? error.required_fields ?? json?.required_fields ?? null;
      throw failure;
    }
    return json;
  }
}
