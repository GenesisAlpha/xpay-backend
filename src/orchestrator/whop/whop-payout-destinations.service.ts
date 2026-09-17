import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { WhopConnectedPayoutService } from './whop-connected-payout.service';
import {
  checkPayoutFields,
  pickPayoutMethod,
  toSavedDestination,
  toSupportedMethod,
} from './whop-connected-payout';
import { WhopApiError, WhopPlatformClient } from './whop-platform.client';

// ============================================================================
// Conta bancária do saque, para seller com conta conectada.
//
// O seller escolhe uma conta já salva na Whop ou informa uma nova no próprio
// pedido de saque. A Whop não aceita dados bancários soltos no payout: a conta
// nova é cadastrada antes (POST /payouts/methods) e o saque aponta para ela.
// Os campos sensíveis são cofrados pela Whop; aqui fica só o id `potk_` e a
// referência mascarada.
// ============================================================================

export interface WhopDestinationInput {
  whopPayoutMethodId?: unknown;
  whopSupportedPayoutMethodId?: unknown;
  whopFields?: unknown;
  whopDestinationCurrency?: unknown;
  whopNickname?: unknown;
  whopCountry?: unknown;
}

/** O que vai para wallet_ledger.metadata.destination de um saque pela Whop. */
export interface WhopPayoutDestination {
  whopPayoutMethodId: string;
  whopMethodName: string | null;
  bankName: string | null;
  accountReference: string | null;
  destinationCurrency: string | null;
}

const COUNTRY = /^[A-Z]{2}$/;
const CURRENCY = /^[a-z]{3}$/;
const WHOP_ID = /^(potk|podst)_[A-Za-z0-9]+$/;

@Injectable()
export class WhopPayoutDestinationsService {
  constructor(
    private readonly whop: WhopPlatformClient,
    private readonly payouts: WhopConnectedPayoutService,
  ) { }

  /**
   * Como o seller recebe: `whop` (conta conectada — contas da Whop) ou
   * `manual` (ACH/IBAN/Pix digitados, pagos pela equipe).
   */
  async overview(sellerId: string, country?: unknown) {
    const accountId = await this.payouts.eligibleAccount(sellerId);
    if (!accountId) return { mode: 'manual' as const, saved: [], supported: [] };

    const code = this.country(country);
    const [saved, supported] = await Promise.all([
      this.call(() => this.whop.listSavedPayoutMethods(accountId)),
      this.call(() => this.whop.listSupportedPayoutMethods({ accountId, country: code })),
    ]);
    return {
      mode: 'whop' as const,
      country: code,
      saved: this.items(saved).filter((m: any) => m?.status !== 'broken').map(toSavedDestination),
      supported: this.items(supported).map(toSupportedMethod),
    };
  }

  /** Só o modo, sem ir à Whop — é o que o pedido de saque precisa saber. */
  async overviewMode(sellerId: string): Promise<'whop' | 'manual'> {
    return (await this.payouts.eligibleAccount(sellerId)) ? 'whop' : 'manual';
  }

  /** Campos que o trilho escolhido pede (variam por país e moeda). */
  async fields(sellerId: string, query: { supportedPayoutMethodId?: unknown; country?: unknown; destinationCurrency?: unknown }) {
    const accountId = await this.requireAccount(sellerId);
    const supportedPayoutMethodId = this.whopId(query.supportedPayoutMethodId, 'podst_', 'Escolha como receber.');
    const response = await this.call(() => this.whop.listSupportedPayoutMethods({
      accountId,
      supportedPayoutMethodId,
      country: this.country(query.country),
      destinationCurrency: this.currency(query.destinationCurrency),
    }));
    const method = this.items(response)[0];
    if (!method) throw new BadRequestException('Essa forma de recebimento não está disponível para a sua conta.');
    return toSupportedMethod(method);
  }

  /**
   * Resolve a conta do saque: confere a escolhida ou cadastra a nova. Chamado
   * antes de debitar o saldo — se a Whop recusar os dados, nada é debitado.
   *
   * `idempotencyKey` vem do pedido de saque: repetir o pedido cadastra a MESMA
   * conta, e o hash do saque (que inclui o destino) bate.
   */
  async resolveForRequest(sellerId: string, input: WhopDestinationInput, idempotencyKey?: string | null): Promise<WhopPayoutDestination> {
    const accountId = await this.requireAccount(sellerId);

    const chosen = typeof input.whopPayoutMethodId === 'string' ? input.whopPayoutMethodId.trim() : '';
    if (chosen) {
      this.whopId(chosen, 'potk_', 'Conta bancária inválida.');
      const saved = this.items(await this.call(() => this.whop.listSavedPayoutMethods(accountId)));
      const choice = pickPayoutMethod(saved, chosen);
      if (!choice.ok) throw new BadRequestException('Essa conta bancária não está mais disponível. Escolha outra.');
      return this.toDestination(saved.find((m: any) => m.id === chosen));
    }

    const supportedPayoutMethodId = this.whopId(input.whopSupportedPayoutMethodId, 'podst_', 'Escolha uma conta salva ou informe uma nova.');
    const destinationCurrency = this.currency(input.whopDestinationCurrency) ?? 'usd';
    const country = this.country(input.whopCountry);

    const schema = await this.fields(sellerId, { supportedPayoutMethodId, country, destinationCurrency });
    const checked = checkPayoutFields(schema.fields ?? [], input.whopFields as Record<string, unknown>);
    if (!checked.ok) {
      throw new BadRequestException({ message: 'Confira os dados da conta bancária.', fieldErrors: checked.errors });
    }

    const nickname = typeof input.whopNickname === 'string' && input.whopNickname.trim()
      ? input.whopNickname.trim().slice(0, 60)
      : undefined;

    let created: any;
    try {
      created = await this.whop.createSavedPayoutMethod({
        account_id: accountId,
        supported_payout_method_id: supportedPayoutMethodId,
        destination_currency: destinationCurrency,
        fields: checked.fields,
        ...(nickname ? { nickname } : {}),
      }, this.methodKey(sellerId, idempotencyKey));
    } catch (err) {
      if (err instanceof WhopApiError && err.status >= 400 && err.status < 500) {
        throw new BadRequestException(`A Whop recusou a conta bancária: ${err.message}`);
      }
      throw new ServiceUnavailableException('Não foi possível cadastrar a conta bancária agora. Tente de novo.');
    }
    if (!created?.id) throw new ServiceUnavailableException('A Whop não confirmou a conta bancária.');
    return this.toDestination(created);
  }

  private toDestination(method: any): WhopPayoutDestination {
    const view = toSavedDestination(method);
    return {
      whopPayoutMethodId: view.id,
      whopMethodName: view.method ?? view.name,
      bankName: view.institution,
      accountReference: view.reference,
      destinationCurrency: view.currency,
    };
  }

  private async requireAccount(sellerId: string): Promise<string> {
    const accountId = await this.payouts.eligibleAccount(sellerId);
    if (!accountId) throw new BadRequestException('Sua conta não recebe saques pela Whop.');
    return accountId;
  }

  // Sem chave no pedido (painel antigo), cada envio cadastra uma conta: não há
  // como reconhecer a repetição sem guardar os dados, e eles não são guardados.
  private methodKey(sellerId: string, idempotencyKey?: string | null): string {
    const key = String(idempotencyKey ?? '').trim();
    return key ? `koopfy_pm_${sellerId}_${key}`.slice(0, 200) : `koopfy_pm_${sellerId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      console.error('[WhopDestinations]', err?.message ?? err);
      throw new ServiceUnavailableException('Contas de recebimento indisponíveis agora. Tente de novo em instantes.');
    }
  }

  private items(response: any): any[] {
    if (Array.isArray(response)) return response;
    return Array.isArray(response?.data) ? response.data : [];
  }

  private country(value: unknown): string | undefined {
    const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return COUNTRY.test(code) ? code : undefined;
  }

  private currency(value: unknown): string | undefined {
    const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return CURRENCY.test(code) ? code : undefined;
  }

  private whopId(value: unknown, prefix: string, message: string): string {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id.startsWith(prefix) || !WHOP_ID.test(id)) throw new BadRequestException(message);
    return id;
  }
}
