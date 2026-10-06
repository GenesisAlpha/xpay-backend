import { Injectable } from '@nestjs/common';
import { ProviderAccountConfig } from '../provider-accounts.config';
import { PaypalApiError, PaypalTokenCache, paypalCall, paypalTokens } from '../paypal/paypal-api';
import { OwnAccountFinanceService, OwnAccountSummary } from './own-account-finance.service';
import {
  PERMISSION_PROBES,
  PermissionCheck,
  PermissionProbe,
  PermissionStatus,
  CustomerEmailsStatus,
  customerEmailsStatus,
  probeStatus,
  summarizePermissions,
} from './own-account-permissions';

// Confere, com leituras, o que a chave da conta própria consegue fazer além de
// vender (saldo e saque; Apple Pay e Google Pay). Ver own-account-permissions.ts.

const STRIPE_API_URL = 'https://api.stripe.com';
const WHOP_API_URL_DEFAULT = 'https://api.whop.com';
const WHOP_API_VERSION_DEFAULT = '2026-09-15';
const PROVIDER_TIMEOUT_MS = 12_000;

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export interface OwnAccountPermissions {
  accountId: string;
  provider: OwnAccountSummary['provider'];
  checks: PermissionCheck[];
  /** Nenhuma permissão faltando (o que não deu para conferir não conta como falta). */
  complete: boolean;
  /** Só Whop: a Whop manda e-mail ao comprador em nome desta conta? */
  customerEmails?: CustomerEmailsStatus;
}

@Injectable()
export class OwnAccountPermissionsService {
  constructor(private readonly finance: OwnAccountFinanceService) {}

  // Injetáveis nos testes: nada aqui fala com provedor de verdade lá.
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as any;
  paypalTokenCache: PaypalTokenCache = paypalTokens;

  async check(sellerId: string, accountId: string): Promise<OwnAccountPermissions> {
    const { account, credentials } = await this.finance.resolveAccount(sellerId, accountId);
    const [results, customerEmails] = await Promise.all([
      Promise.all(PERMISSION_PROBES[account.provider].map(async probe => ({
        probe,
        status: await this.probe(account.provider, credentials, probe),
      }))),
      account.provider === 'whop' ? this.whopCustomerEmails(credentials) : Promise.resolve(undefined),
    ]);
    const checks = summarizePermissions(account.provider, results);
    return {
      accountId,
      provider: account.provider,
      checks,
      complete: checks.every(item => item.status !== 'missing'),
      ...(customerEmails ? { customerEmails } : {}),
    };
  }

  /** GET /accounts/me com a chave dele: lê `send_customer_emails` (ver customerEmailsStatus). */
  private async whopCustomerEmails(account: ProviderAccountConfig): Promise<CustomerEmailsStatus> {
    try {
      const response = await this.fetchImpl(`${account.api_url ?? WHOP_API_URL_DEFAULT}/api/v1/accounts/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${account.apiKey}`,
          Accept: 'application/json',
          'Api-Version-Date': process.env.WHOP_PAYOUTS_API_VERSION?.trim() || WHOP_API_VERSION_DEFAULT,
        },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      const body = response.ok ? await response.json().catch(() => null) : null;
      return customerEmailsStatus(response.status, body);
    } catch {
      return 'unknown';
    }
  }

  private async probe(provider: OwnAccountSummary['provider'], account: ProviderAccountConfig, probe: PermissionProbe): Promise<PermissionStatus> {
    try {
      if (provider === 'paypal') return await this.probePaypal(account, probe.path);
      const whop = provider === 'whop';
      const path = probe.path.replaceAll('{company}', encodeURIComponent(String(account.config?.company_id ?? '')));
      const response = await this.fetchImpl(`${whop ? account.api_url ?? WHOP_API_URL_DEFAULT : STRIPE_API_URL}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${account.apiKey}`,
          Accept: 'application/json',
          ...(whop ? { 'Api-Version-Date': process.env.WHOP_PAYOUTS_API_VERSION?.trim() || WHOP_API_VERSION_DEFAULT } : {}),
        },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      return probeStatus(provider, response.status);
    } catch {
      return 'unknown';
    }
  }

  private async probePaypal(account: ProviderAccountConfig, path: string): Promise<PermissionStatus> {
    try {
      await paypalCall(
        {
          cacheKey: account.id,
          clientId: String(account.apiKey),
          clientSecret: String(account.apiSecret ?? ''),
          mode: account.config?.mode === 'test' ? 'test' : 'live',
        },
        'GET',
        path,
        undefined,
        {},
        this.paypalTokenCache,
        (url, init) => this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }),
      );
      return 'ok';
    } catch (err: any) {
      return err instanceof PaypalApiError ? probeStatus('paypal', err.httpStatus) : 'unknown';
    }
  }
}
