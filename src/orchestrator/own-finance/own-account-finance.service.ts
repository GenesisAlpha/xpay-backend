import { randomUUID } from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';
import { ProviderAccountConfig } from '../provider-accounts.config';
import { PaypalApiError, PaypalTokenCache, paypalCall, paypalTokens } from '../paypal/paypal-api';
import { SellerRoutingService } from '../routing/seller-routing.service';
import { OwnProvider } from '../seller-provider/seller-provider-accounts';
import { SellerProviderAccountsService } from '../seller-provider/seller-provider-accounts.service';
import { isLinkedProviderAccountId, mapLedgerBalance, mapPayoutMethods, toCents } from '../whop/whop-linked';
import { WhopLinkedAccountsService } from '../whop/whop-linked.service';
import { WHOP_PAYOUT_FINAL_STATUS, fetchWhopPayout, requestWhopPayout } from '../whop/whop-payouts-api';
import {
  OwnAccountBalance,
  OwnFinanceCapabilities,
  OwnPayoutMethod,
  OwnPayoutSchedule,
  OwnWithdrawal,
  capabilitiesOf,
  mapPaypalBalance,
  mapStripeBalance,
  mapStripePayouts,
  mapStripeSchedule,
  parseWithdrawInput,
  sumBalances,
  toStripeMinor,
  withdrawCeiling,
} from './own-account-finance';

// ============================================================================
// FINANCEIRO DAS CONTAS PRÓPRIAS DO SELLER
// ----------------------------------------------------------------------------
// Saldo, destinos, saque e histórico de CADA conta externa do seller — Whop
// principal e extras, Stripe e PayPal — e a visão que soma todas. É o
// Financeiro da Koopfy Pay para quem vende pela conta dele: o dinheiro não
// passa por nós, então tudo aqui é leitura da conta dele e pedido de saque
// para o banco dele, com a credencial que ele conectou.
//
// Uma conta fora do ar (chave revogada, sem permissão) nunca derruba a tela
// das outras: cada leitura falha sozinha e volta com o motivo.
// ============================================================================

const STRIPE_API_URL = 'https://api.stripe.com';
const WHOP_API_URL_DEFAULT = 'https://api.whop.com';
// O histórico de saques da Whop é o nosso registro (a API não lista).
const WHOP_WITHDRAWALS_TABLE = 'whop_linked_withdrawals';
const FINAL_WHOP_STATUS = WHOP_PAYOUT_FINAL_STATUS;

// O painel espera a tela inteira; um provedor lento não pode segurar as outras contas.
const PROVIDER_TIMEOUT_MS = 12_000;
const HISTORY_LIMIT = 30;

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

/** Conta do seller como o roteamento a descreve (sem credencial). */
export interface OwnAccountSummary {
  id: string;
  provider: OwnProvider;
  group: 'card' | 'paypal';
  primary: boolean;
  label: string | null;
  accountName: string | null;
  mode?: 'live' | 'test';
  /** active = cobrando; attention = credencial recusada; standby = guardada. */
  status: 'active' | 'attention' | 'standby';
  paused: boolean;
}

export interface OwnAccountFinanceRow extends OwnAccountSummary {
  capabilities: OwnFinanceCapabilities;
  balance: OwnAccountBalance | null;
  /** Por que o saldo não veio (a conta continua na lista). */
  error: string | null;
}

export interface OwnAccountWallet extends OwnAccountFinanceRow {
  payoutMethods: OwnPayoutMethod[];
  withdrawals: OwnWithdrawal[];
  schedule: OwnPayoutSchedule | null;
}

@Injectable()
export class OwnAccountFinanceService {
  constructor(
    private readonly routing: SellerRoutingService,
    private readonly whopLinked: WhopLinkedAccountsService,
    private readonly sellerProviders: SellerProviderAccountsService,
  ) {}

  // Injetáveis nos testes: nada aqui fala com provedor de verdade lá.
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as any;
  paypalTokenCache: PaypalTokenCache = paypalTokens;

  // ─── O que o painel pede ───────────────────────────────────────────────

  /** Contas conectadas do seller (inclusive guardadas: o saldo continua lá). */
  async accounts(sellerId: string): Promise<OwnAccountSummary[]> {
    const view = await this.routing.view(sellerId);
    // Loja Shopify (conta por link) não tem saldo nem saque na Koopfy.
    return view.accounts.filter(account => !account.link).map(account => ({
      id: account.id,
      provider: account.provider as OwnAccountSummary['provider'],
      group: account.group,
      primary: account.primary,
      label: account.label,
      accountName: account.accountName,
      ...(account.mode ? { mode: account.mode } : {}),
      status: account.status as OwnAccountSummary['status'],
      paused: account.paused,
    }));
  }

  /**
   * Todas as contas com o saldo de cada uma e o total por moeda. As leituras
   * saem em paralelo e cada uma falha sozinha.
   */
  async overview(sellerId: string) {
    const accounts = await this.accounts(sellerId);
    const rows: OwnAccountFinanceRow[] = await Promise.all(accounts.map(async account => {
      const capabilities = capabilitiesOf(account.provider, account.mode ?? null);
      try {
        const credentials = await this.credentials(sellerId, account.id);
        const { balance } = await this.readBalance(account.provider, credentials);
        return { ...account, capabilities, balance, error: null };
      } catch (err: any) {
        return { ...account, capabilities, balance: null, error: publicError(err) };
      }
    }));
    return { accounts: rows, totals: sumBalances(rows.map(row => row.balance)) };
  }

  /** Carteira de UMA conta: saldo, destinos do saque, histórico e agenda. */
  async wallet(sellerId: string, accountId: string): Promise<OwnAccountWallet> {
    const account = await this.accountOf(sellerId, accountId);
    const capabilities = capabilitiesOf(account.provider, account.mode ?? null);
    const credentials = await this.credentials(sellerId, accountId);

    let balance: OwnAccountBalance | null = null;
    let schedule: OwnPayoutSchedule | null = null;
    let error: string | null = null;
    try {
      ({ balance, schedule } = await this.readBalance(account.provider, credentials));
    } catch (err: any) {
      error = publicError(err);
    }

    // Destinos e histórico são complemento: sem eles o saldo ainda aparece.
    const [payoutMethods, withdrawals] = await Promise.all([
      this.readPayoutMethods(account.provider, credentials).catch(() => []),
      this.readWithdrawals(sellerId, account.provider, credentials).catch(() => []),
    ]);

    return { ...account, capabilities, balance, error, payoutMethods, withdrawals, schedule };
  }

  /**
   * Saque da conta do seller para o banco dele. A Koopfy só dispara o pedido:
   * o dinheiro sai do provedor dele e nunca encosta na nossa carteira.
   */
  async withdraw(
    sellerId: string,
    accountId: string,
    input: { amountCents?: unknown; currency?: unknown; payoutMethodId?: unknown },
    actor: string | null = null,
  ): Promise<OwnAccountWallet> {
    const account = await this.accountOf(sellerId, accountId);
    const capabilities = capabilitiesOf(account.provider, account.mode ?? null);
    if (!capabilities.withdraw) {
      throw new BadRequestException(
        'O saque desta conta é feito no painel do provedor: a API dele não transfere o saldo para o banco.',
      );
    }

    let request: ReturnType<typeof parseWithdrawInput>;
    try {
      request = parseWithdrawInput(input);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
    if (capabilities.chooseDestination && !request.payoutMethodId) {
      throw new BadRequestException('Escolha para qual conta bancária enviar.');
    }

    const credentials = await this.credentials(sellerId, accountId);

    // Não deixa pedir mais do que o provedor libera: o erro dele viria
    // genérico e o seller ficaria sem saber por quê.
    const { balance } = await this.readBalance(account.provider, credentials).catch((err: any) => {
      throw new BadRequestException(`Não foi possível conferir o saldo antes do saque (${publicError(err)}).`);
    });
    const ceiling = withdrawCeiling(balance, request.currency);
    if (request.amountCents > ceiling) {
      throw new BadRequestException(
        `Valor acima do disponível para saque (${(ceiling / 100).toFixed(2)} ${request.currency.toUpperCase()}).`,
      );
    }

    if (account.provider === 'whop') await this.withdrawWhop(sellerId, credentials, request, actor);
    else await this.withdrawStripe(credentials, request);

    await this.log(sellerId, actor, 'own_finance.withdrawal', {
      account_id: accountId,
      provider: account.provider,
      amount_cents: request.amountCents,
      currency: request.currency,
    });
    return this.wallet(sellerId, accountId);
  }

  // ─── Conta e credencial ────────────────────────────────────────────────

  /** Conta do seller com a credencial dela (para os serviços vizinhos: domínios de pagamento). */
  async resolveAccount(sellerId: string, accountId: string): Promise<{ account: OwnAccountSummary; credentials: ProviderAccountConfig }> {
    const account = await this.accountOf(sellerId, accountId);
    return { account, credentials: await this.credentials(sellerId, accountId) };
  }

  /** A conta tem que ser do seller e estar conectada; senão "não encontrada". */
  private async accountOf(sellerId: string, accountId: string): Promise<OwnAccountSummary> {
    const account = (await this.accounts(sellerId)).find(item => item.id === accountId);
    if (!account) throw new NotFoundException('Conta não encontrada ou desconectada.');
    return account;
  }

  private async credentials(sellerId: string, accountId: string): Promise<ProviderAccountConfig> {
    const account = isLinkedProviderAccountId(accountId)
      ? await this.whopLinked.getProviderAccountById(accountId)
      : await this.sellerProviders.getProviderAccountById(accountId);
    // `seller_id` conferido de novo aqui: a credencial nunca sai para outro seller.
    if (!account || account.config?.seller_id !== sellerId || !account.apiKey) {
      throw new BadRequestException('A credencial desta conta não pôde ser lida. Conecte a conta novamente.');
    }
    return account;
  }

  // ─── Leituras por provedor ─────────────────────────────────────────────

  private async readBalance(
    provider: OwnProvider,
    account: ProviderAccountConfig,
  ): Promise<{ balance: OwnAccountBalance; schedule: OwnPayoutSchedule | null }> {
    if (provider === 'whop') {
      const ledger = await this.whop(account, 'GET', `/api/v1/ledger_accounts/${encodeURIComponent(String(account.config?.company_id))}`);
      return { balance: mapLedgerBalance(ledger), schedule: null };
    }
    if (provider === 'stripe') {
      const [balance, profile] = await Promise.all([
        this.stripe(account, 'GET', '/v1/balance'),
        // A conta diz a moeda padrão e a agenda de repasse; sem ela o saldo ainda vale.
        this.stripe(account, 'GET', '/v1/account').catch(() => null),
      ]);
      return { balance: mapStripeBalance(balance, profile?.default_currency), schedule: mapStripeSchedule(profile) };
    }
    const balances = await this.paypal(account, 'GET', '/v1/reporting/balances?currency_code=ALL&include_crypto_currencies=false');
    return { balance: mapPaypalBalance(balances), schedule: null };
  }

  private async readPayoutMethods(provider: OwnProvider, account: ProviderAccountConfig): Promise<OwnPayoutMethod[]> {
    // Stripe e PayPal mandam para o banco padrão da conta; só a Whop deixa escolher.
    if (provider !== 'whop') return [];
    const payload = await this.whop(account, 'GET', `/api/v1/payout_methods?account_id=${encodeURIComponent(String(account.config?.company_id))}`);
    return mapPayoutMethods(payload);
  }

  private async readWithdrawals(sellerId: string, provider: OwnProvider, account: ProviderAccountConfig): Promise<OwnWithdrawal[]> {
    if (provider === 'stripe') {
      return mapStripePayouts(await this.stripe(account, 'GET', `/v1/payouts?limit=${HISTORY_LIMIT}`));
    }
    if (provider === 'paypal') return [];
    return this.whopWithdrawals(sellerId, account);
  }

  // ─── Whop ──────────────────────────────────────────────────────────────

  private async whopWithdrawals(sellerId: string, account: ProviderAccountConfig): Promise<OwnWithdrawal[]> {
    const companyId = String(account.config?.company_id ?? '');
    const { data, error } = await supabase
      .from(WHOP_WITHDRAWALS_TABLE)
      .select('*')
      .eq('seller_id', sellerId)
      .eq('whop_account_id', companyId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) {
      console.error('[OwnFinance] leitura dos saques:', error.message);
      return [];
    }
    const rows = data ?? [];

    // Enquanto o saque não termina, a Whop é a dona da verdade sobre o status.
    for (const row of rows.filter(item => item.whop_withdrawal_id && !FINAL_WHOP_STATUS.has(String(item.status)))) {
      try {
        // GET /payouts/{id} (a antiga /withdrawals responde 410) — ver whop-payouts-api.ts.
        const fresh = await fetchWhopPayout({
          apiKey: String(account.apiKey),
          apiUrl: account.api_url ?? WHOP_API_URL_DEFAULT,
          payoutId: row.whop_withdrawal_id,
          fetchImpl: this.fetchImpl,
        });
        const status = fresh.status;
        if (!status || status === row.status) continue;
        row.status = status;
        row.estimated_at = fresh.estimatedAt ?? row.estimated_at;
        await supabase
          .from(WHOP_WITHDRAWALS_TABLE)
          .update({ status, estimated_at: row.estimated_at, updated_at: new Date().toISOString() })
          .eq('id', row.id);
      } catch (err: any) {
        // Listagem não é lugar de falhar: o status antigo ainda é verdade.
        console.error(`[OwnFinance] status do saque ${row.whop_withdrawal_id}:`, err?.message);
      }
    }

    return rows.map(row => ({
      id: String(row.id),
      externalId: row.whop_withdrawal_id ?? null,
      amountCents: Number(row.amount_cents ?? 0),
      feeCents: Number(row.fee_cents ?? 0),
      currency: String(row.currency ?? '').toLowerCase(),
      status: String(row.status ?? 'requested'),
      automatic: false,
      estimatedAt: row.estimated_at ?? null,
      failureReason: row.failure_reason ?? null,
      createdAt: row.created_at,
    }));
  }

  private async withdrawWhop(
    sellerId: string,
    account: ProviderAccountConfig,
    request: { amountCents: number; currency: string; payoutMethodId: string | null },
    actor: string | null,
  ) {
    const companyId = String(account.config?.company_id ?? '');
    // A chave de idempotência é nossa e fica gravada: um retry do painel (ou um
    // duplo clique) não vira dois saques.
    const idempotencyKey = randomUUID();
    const { data: saved, error: saveError } = await supabase
      .from(WHOP_WITHDRAWALS_TABLE)
      .insert({
        seller_id: sellerId,
        whop_account_id: companyId,
        idempotency_key: idempotencyKey,
        amount_cents: request.amountCents,
        currency: request.currency,
        payout_method_id: request.payoutMethodId,
        status: 'requested',
        requested_by: actor,
      })
      .select('id')
      .single();
    if (saveError) {
      console.error('[OwnFinance] registro do saque:', saveError.message);
      throw new BadRequestException('Não foi possível registrar o saque agora. Tente novamente.');
    }

    try {
      // POST /payouts (a antiga /withdrawals responde 410) — ver whop-payouts-api.ts.
      const withdrawal = await requestWhopPayout({
        apiKey: String(account.apiKey),
        apiUrl: account.api_url ?? WHOP_API_URL_DEFAULT,
        accountId: companyId,
        payoutMethodId: String(request.payoutMethodId),
        amountCents: request.amountCents,
        currency: request.currency,
        idempotencyKey,
        metadata: { koopfy_seller_id: sellerId, koopfy_withdrawal_id: saved.id },
        fetchImpl: this.fetchImpl,
      });
      await supabase
        .from(WHOP_WITHDRAWALS_TABLE)
        .update({
          whop_withdrawal_id: withdrawal.id,
          status: withdrawal.status,
          fee_cents: withdrawal.feeCents,
          estimated_at: withdrawal.estimatedAt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', saved.id);
    } catch (err: any) {
      const reason = publicError(err).slice(0, 500);
      await supabase
        .from(WHOP_WITHDRAWALS_TABLE)
        .update({ status: 'failed', failure_reason: reason, updated_at: new Date().toISOString() })
        .eq('id', saved.id);
      throw new BadRequestException(`A Whop recusou o saque: ${reason}`);
    }
  }

  private async whop(account: ProviderAccountConfig, method: 'GET' | 'POST', path: string, body?: Record<string, any>) {
    const response = await this.send(`${account.api_url ?? WHOP_API_URL_DEFAULT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('a chave da Whop não tem permissão de saldo e saque — gere outra com essas permissões e conecte de novo');
      }
      throw new Error(json?.error?.message ?? `Whop HTTP ${response.status}`);
    }
    return json;
  }

  // ─── Stripe ────────────────────────────────────────────────────────────

  /**
   * Repasse manual para o banco padrão da conta Stripe dele. A chave de
   * idempotência vai no cabeçalho: um retry não vira dois repasses.
   */
  private async withdrawStripe(
    account: ProviderAccountConfig,
    request: { amountCents: number; currency: string },
  ) {
    const form = new URLSearchParams();
    form.set('amount', String(toStripeMinor(request.amountCents, request.currency)));
    form.set('currency', request.currency);
    form.set('description', 'Saque pedido no painel da Koopfy');
    try {
      await this.stripe(account, 'POST', '/v1/payouts', form, { 'Idempotency-Key': randomUUID() });
    } catch (err: any) {
      throw new BadRequestException(`A Stripe recusou o saque: ${publicError(err)}`);
    }
  }

  private async stripe(
    account: ProviderAccountConfig,
    method: 'GET' | 'POST',
    path: string,
    form?: URLSearchParams,
    extraHeaders: Record<string, string> = {},
  ) {
    const response = await this.send(`${STRIPE_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        Accept: 'application/json',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...extraHeaders,
      },
      ...(form ? { body: form.toString() } : {}),
    });
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('a chave da Stripe não tem permissão para saldo e repasses — se for chave restrita, libere Balance e Payouts');
      }
      throw new Error(json?.error?.message ?? `Stripe HTTP ${response.status}`);
    }
    return json;
  }

  // ─── PayPal ────────────────────────────────────────────────────────────

  private async paypal(account: ProviderAccountConfig, method: 'GET', path: string) {
    try {
      return await paypalCall(
        {
          cacheKey: account.id,
          clientId: String(account.apiKey),
          clientSecret: String(account.apiSecret ?? ''),
          mode: account.config?.mode === 'test' ? 'test' : 'live',
        },
        method,
        path,
        undefined,
        {},
        this.paypalTokenCache,
        (url, init) => this.send(url, init),
      );
    } catch (err: any) {
      if (err instanceof PaypalApiError && (err.httpStatus === 403 || err.httpStatus === 401)) {
        throw new Error('o app do PayPal não tem a permissão de relatórios — ative "Transaction search" em Apps & Credentials');
      }
      throw err;
    }
  }

  // ─── Internos ──────────────────────────────────────────────────────────

  /** fetch com prazo: provedor que aceita a conexão e não responde não segura a tela. */
  private async send(url: string, init: any) {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    } catch (err: any) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new Error(timeout ? 'o provedor demorou para responder' : `erro de rede (${err?.message ?? 'sem detalhe'})`);
    }
  }

  private async log(sellerId: string, actor: string | null, action: string, payload: Record<string, any>) {
    const { error } = await supabase.from('crm_action_log').insert({
      seller_id: sellerId,
      manager_id: null,
      action,
      resource_type: 'seller',
      resource_id: sellerId,
      payload: { ...payload, actor },
      created_at: new Date().toISOString(),
    });
    if (error) console.error(`[OwnFinance] ação ${action} não registrada:`, error.message);
  }
}

/** Mensagem que pode ir para o painel: o texto do erro, sem pilha nem objeto. */
function publicError(err: any): string {
  const message = String(err?.response?.message ?? err?.message ?? err ?? 'erro').trim();
  return message || 'erro';
}
