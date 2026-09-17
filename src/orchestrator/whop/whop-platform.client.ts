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

  // Contas bancárias que o seller cadastrou na conta conectada (portal da Whop).
  listPayoutMethods(accountId: string) {
    return this.request('GET', '/payout_methods', { query: { account_id: accountId, first: '50' } });
  }

  // Saque da conta conectada para a conta bancária dela. A chave de plataforma
  // saca em nome da filha; como na transferência, a chave vai no header e no
  // corpo (`idempotency_key`, que é o nome que este endpoint usa).
  createWithdrawal(body: Record<string, any>, idempotencyKey: string) {
    return this.request('POST', '/withdrawals', { body: { ...body, idempotency_key: idempotencyKey }, idempotencyKey });
  }

  getWithdrawal(withdrawalId: string) {
    return this.request('GET', `/withdrawals/${encodeURIComponent(withdrawalId)}`);
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
    opts: { body?: Record<string, any>; query?: Record<string, string>; idempotencyKey?: string } = {},
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

    const res = await fetch(`${this.apiUrl()}/api/v1${path}${qs}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = json?.error ?? {};
      throw new WhopApiError(
        error.message ?? json?.message ?? `Whop HTTP ${res.status}`,
        res.status,
        error.type ?? null,
        error.code ?? null,
      );
    }
    return json;
  }
}
