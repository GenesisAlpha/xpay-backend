import { BadRequestException, Injectable } from '@nestjs/common';
import { WhopApiError, WhopPlatformClient } from '../orchestrator/whop/whop-platform.client';
import { WhopConnectService } from '../orchestrator/whop/whop-connect.service';
import { WhopLinkedAccountsService } from '../orchestrator/whop/whop-linked.service';
import { sellerHasOwnStripe } from '../orchestrator/seller-provider/seller-provider-accounts.service';
import { OwnDomainRegistration, OwnPaymentDomainsService } from '../orchestrator/own-finance/own-payment-domains.service';
import type { SellerCtx } from './cross-service-jwt.guard';
import { sellerUsesKoopfyPayments } from '../orchestrator/seller-provider/payment-account-mode';

// Apple Pay no checkout incorporado: o domínio do site do seller precisa estar
// registrado (e verificado) na Whop, na conta que cobra. Seller com conta
// conectada cobra nela; se ela cair, o roteador cobra na master — então o
// domínio vai para as duas. Seller sem conta conectada cobra na master. Seller
// com contas próprias (Whop ou Stripe) tem o domínio registrado em cada uma
// delas, com a chave que ele conectou (ver OwnPaymentDomainsService).

export type DomainScope = 'connected' | 'master' | 'own';

export interface DomainRegistration {
  scope: DomainScope;
  accountId: string | null;
  id: string | null;
  status: 'verified' | 'pending' | 'error';
  message: string | null;
  // Só nas contas próprias (`own`): de quem é a conta e a situação de cada carteira.
  provider?: string;
  name?: string | null;
  applePay?: string;
  googlePay?: string;
}

/** Registro numa conta própria → o formato desta tela. `verified` = Apple Pay ativo. */
export function ownRegistration(item: OwnDomainRegistration): DomainRegistration {
  const base = { scope: 'own' as const, accountId: item.accountId, provider: item.provider, name: item.name };
  if (!item.domain) {
    return { ...base, id: null, status: 'error', message: item.error ?? 'not_registered' };
  }
  return {
    ...base,
    id: item.domain.id,
    status: item.domain.applePay === 'active' ? 'verified' : 'pending',
    message: item.domain.message,
    applePay: item.domain.applePay,
    googlePay: item.domain.googlePay,
  };
}

export interface PaymentDomainsResult {
  hostname: string;
  mode: 'whop' | 'external' | 'unavailable';
  registrations: DomainRegistration[];
}

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeHostname(raw: unknown): string {
  const value = String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  if (!HOSTNAME.test(value)) throw new BadRequestException('Domínio inválido.');
  if (value === 'koopfy.com' || value.endsWith('.koopfy.com') || value === 'whop.com' || value.endsWith('.whop.com')) {
    throw new BadRequestException('Informe o domínio do seu site.');
  }
  return value;
}

function items(response: any): any[] {
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response)) return response;
  return [];
}

function errorMessage(err: unknown): string {
  if (err instanceof WhopApiError) return err.message;
  return String((err as any)?.message ?? err);
}

@Injectable()
export class KoopfyPaymentDomainsService {
  constructor(
    private readonly whop: WhopPlatformClient,
    private readonly connect: WhopConnectService,
    private readonly linked: WhopLinkedAccountsService,
    private readonly ownDomains: OwnPaymentDomainsService,
  ) {}

  private async targets(sellerId: string): Promise<{ mode: PaymentDomainsResult['mode']; accounts: Array<{ scope: DomainScope; accountId: string | null }> }> {
    // Seller na Koopfy Payments: as vendas saem pelas contas da Koopfy mesmo
    // com conta própria conectada, então o domínio vai para as contas dela.
    const koopfy = await sellerUsesKoopfyPayments(sellerId).catch(() => false);
    const linked = koopfy ? null : await this.linked.getRow(sellerId).catch(() => null);
    if (linked?.whop_account_id && (linked as any).api_key) return { mode: 'external', accounts: [] };
    // Só Stripe própria (sem Whop): as vendas de cartão saem por ela.
    if (!koopfy && await sellerHasOwnStripe(sellerId).catch(() => false)) return { mode: 'external', accounts: [] };
    if (!this.whop.isConfigured()) return { mode: 'unavailable', accounts: [] };
    const connected = await this.connect.getRow(sellerId).catch(() => null);
    const accounts: Array<{ scope: DomainScope; accountId: string | null }> = [];
    if (connected?.whop_account_id) accounts.push({ scope: 'connected', accountId: connected.whop_account_id });
    accounts.push({ scope: 'master', accountId: null });
    return { mode: 'whop', accounts };
  }

  private masterId: string | null = null;

  /** Id (`biz_`) da própria master, para achar os domínios dela na listagem. */
  private async masterAccountId(): Promise<string | null> {
    if (this.masterId) return this.masterId;
    const me = await this.whop.getAccount('me').catch(() => null);
    this.masterId = typeof me?.id === 'string' ? me.id : null;
    return this.masterId;
  }

  private async find(hostname: string, accountId: string | null) {
    const owner = accountId ?? await this.masterAccountId();
    const list = items(await this.whop.listPaymentMethodDomains(accountId));
    // Sem o id da master, só vale o domínio sem conta: nunca confundir com o de
    // uma conectada (a listagem da master traz os das filhas também).
    return list.find(item => item?.hostname === hostname
      && (owner ? item.account_id === owner || !item.account_id : !item.account_id)) ?? null;
  }

  /** Registra (ou tenta verificar de novo) o domínio em uma conta. Nunca lança. */
  private async ensure(hostname: string, target: { scope: DomainScope; accountId: string | null }): Promise<DomainRegistration> {
    const base = { scope: target.scope, accountId: target.accountId };
    try {
      let domain = await this.find(hostname, target.accountId).catch(() => null);
      if (!domain) {
        try {
          domain = await this.whop.createPaymentMethodDomain(
            hostname,
            target.accountId,
            `pmd:${target.accountId ?? 'master'}:${hostname}`,
          );
        } catch (err) {
          // Já registrado (corrida ou cadastro no painel da Whop): busca de novo.
          if (err instanceof WhopApiError && (err.status === 409 || err.status === 400)) {
            domain = await this.find(hostname, target.accountId);
            if (!domain) throw err;
          } else {
            throw err;
          }
        }
      }
      if (domain?.status !== 'verified' && domain?.id) {
        try {
          domain = await this.whop.verifyPaymentMethodDomain(domain.id);
        } catch (err) {
          return { ...base, id: domain.id, status: 'pending', message: errorMessage(err) };
        }
      }
      return {
        ...base,
        id: domain?.id ?? null,
        status: domain?.status === 'verified' ? 'verified' : 'pending',
        message: null,
      };
    } catch (err) {
      console.error(`[PaymentDomains] ${hostname} (${target.scope}):`, errorMessage(err));
      return { ...base, id: null, status: 'error', message: errorMessage(err) };
    }
  }

  async register(ctx: SellerCtx, rawHostname: unknown): Promise<PaymentDomainsResult> {
    const sellerId = ctx.seller?.id;
    if (!sellerId) throw new BadRequestException('Conta de pagamento não encontrada.');
    const hostname = normalizeHostname(rawHostname);
    const { mode, accounts } = await this.targets(sellerId);
    if (mode === 'external') {
      return { hostname, mode, registrations: (await this.ownDomains.registerEverywhere(sellerId, hostname)).map(ownRegistration) };
    }
    const registrations: DomainRegistration[] = [];
    for (const target of accounts) registrations.push(await this.ensure(hostname, target));
    return { hostname, mode, registrations };
  }

  /** Situação atual, sem registrar nada (para a tela abrir já com o status). */
  async status(ctx: SellerCtx, rawHostname: unknown): Promise<PaymentDomainsResult> {
    const sellerId = ctx.seller?.id;
    if (!sellerId) throw new BadRequestException('Conta de pagamento não encontrada.');
    const hostname = normalizeHostname(rawHostname);
    const { mode, accounts } = await this.targets(sellerId);
    if (mode === 'external') {
      const own = await this.ownDomains.registerEverywhere(sellerId, hostname, { register: false });
      return { hostname, mode, registrations: own.map(ownRegistration) };
    }
    const registrations: DomainRegistration[] = [];
    for (const target of accounts) {
      try {
        const domain = await this.find(hostname, target.accountId);
        registrations.push({
          scope: target.scope,
          accountId: target.accountId,
          id: domain?.id ?? null,
          status: domain?.status === 'verified' ? 'verified' : domain ? 'pending' : 'error',
          message: domain ? null : 'not_registered',
        });
      } catch (err) {
        registrations.push({ scope: target.scope, accountId: target.accountId, id: null, status: 'error', message: errorMessage(err) });
      }
    }
    return { hostname, mode, registrations };
  }
}
