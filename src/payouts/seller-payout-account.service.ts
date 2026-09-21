import { createHash } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { supabase } from '../lib/supabase.client';
import {
  PayoutMethodKey,
  PayoutReadiness,
  PublicSavedPayoutMethod,
} from './payout.types';
import {
  WhopPayoutClient,
  WhopSavedPayoutMethod,
  WhopSupportedPayoutMethod,
} from './whop-payout.client';

export interface SellerPayoutAccountRow {
  sellerId: string;
  providerAccountId: string | null;
  status: PayoutReadiness['status'];
  verificationStatus: string | null;
  payoutsEnabled: boolean;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastSyncedAt: string | null;
}

export interface SellerPayoutMethodRow {
  id: string;
  sellerId: string;
  providerMethodId: string;
  providerSupportedMethodId: string;
  methodKey: PayoutMethodKey;
  deliverySpeeds: string[];
  network: string | null;
  destinationCountry: string | null;
  currency: string | null;
  nickname: string | null;
  institutionName: string | null;
  maskedReference: string;
  status: 'active' | 'inactive' | 'restricted';
  isDefault: boolean;
}

interface SellerForPayout {
  id: string;
  status: string;
  name: string | null;
  email: string;
  country: string | null;
}

export class PayoutProvisioningError extends ServiceUnavailableException {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

@Injectable()
export class SellerPayoutRepository {
  async getSeller(sellerId: string): Promise<SellerForPayout | null> {
    const { data, error } = await supabase
      .from('seller_profiles')
      .select('id, status, name, email, country')
      .eq('id', sellerId)
      .maybeSingle();
    if (error) throw persistenceError();
    if (!data) return null;
    return {
      id: String(data.id),
      status: String(data.status),
      name: typeof data.name === 'string' ? data.name : null,
      email: String(data.email),
      country: typeof data.country === 'string' ? data.country : null,
    };
  }

  async getAccount(sellerId: string): Promise<SellerPayoutAccountRow | null> {
    const { data, error } = await supabase
      .from('seller_payout_accounts')
      .select('*')
      .eq('seller_id', sellerId)
      .maybeSingle();
    if (error) throw persistenceError();
    return data ? mapAccount(data) : null;
  }

  async claimProvisioning(sellerId: string): Promise<boolean> {
    const { error } = await supabase.from('seller_payout_accounts').insert({
      seller_id: sellerId,
      provider: 'whop',
      status: 'provisioning',
      payouts_enabled: false,
    });
    if (!error) return true;
    if (error.code === '23505') return false;
    throw persistenceError();
  }

  async updateAccount(
    sellerId: string,
    patch: Partial<{
      providerAccountId: string | null;
      status: PayoutReadiness['status'];
      verificationStatus: string | null;
      payoutsEnabled: boolean;
      lastErrorCode: string | null;
      lastErrorMessage: string | null;
      lastSyncedAt: string | null;
    }>,
  ): Promise<SellerPayoutAccountRow> {
    const dbPatch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if ('providerAccountId' in patch)
      dbPatch.provider_account_id = patch.providerAccountId;
    if ('status' in patch) dbPatch.status = patch.status;
    if ('verificationStatus' in patch)
      dbPatch.verification_status = patch.verificationStatus;
    if ('payoutsEnabled' in patch)
      dbPatch.payouts_enabled = patch.payoutsEnabled;
    if ('lastErrorCode' in patch) dbPatch.last_error_code = patch.lastErrorCode;
    if ('lastErrorMessage' in patch)
      dbPatch.last_error_message = patch.lastErrorMessage;
    if ('lastSyncedAt' in patch) dbPatch.last_synced_at = patch.lastSyncedAt;

    const { data, error } = await supabase
      .from('seller_payout_accounts')
      .update(dbPatch)
      .eq('seller_id', sellerId)
      .select('*')
      .single();
    if (error || !data) throw persistenceError();
    return mapAccount(data);
  }

  async listMethods(sellerId: string): Promise<SellerPayoutMethodRow[]> {
    const { data, error } = await supabase
      .from('seller_payout_methods')
      .select('*')
      .eq('seller_id', sellerId)
      .neq('status', 'inactive')
      .order('created_at', { ascending: false });
    if (error) throw persistenceError();
    return (data ?? []).map(mapMethod);
  }

  async getMethod(id: string): Promise<SellerPayoutMethodRow | null> {
    const { data, error } = await supabase
      .from('seller_payout_methods')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw persistenceError();
    return data ? mapMethod(data) : null;
  }

  async upsertMethod(
    value: Omit<SellerPayoutMethodRow, 'id'>,
  ): Promise<SellerPayoutMethodRow> {
    if (value.isDefault) {
      const { error: defaultError } = await supabase
        .from('seller_payout_methods')
        .update({ is_default: false, updated_at: new Date().toISOString() })
        .eq('seller_id', value.sellerId)
        .eq('is_default', true);
      if (defaultError) throw persistenceError();
    }
    const { data, error } = await supabase
      .from('seller_payout_methods')
      .upsert(
        {
          seller_id: value.sellerId,
          provider_method_id: value.providerMethodId,
          provider_supported_method_id: value.providerSupportedMethodId,
          method_key: value.methodKey,
          delivery_speeds: value.deliverySpeeds,
          network: value.network,
          destination_country: value.destinationCountry,
          currency: value.currency,
          nickname: value.nickname,
          institution_name: value.institutionName,
          masked_reference: value.maskedReference,
          status: value.status,
          is_default: value.isDefault,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'provider_method_id' },
      )
      .select('*')
      .single();
    if (error || !data) throw persistenceError();
    return mapMethod(data);
  }

  async syncMethodStatus(
    sellerId: string,
    providerMethodId: string,
    status: SellerPayoutMethodRow['status'],
    isDefault: boolean,
    maskedReference: string | null,
  ): Promise<void> {
    if (isDefault) {
      const { error: defaultError } = await supabase
        .from('seller_payout_methods')
        .update({ is_default: false, updated_at: new Date().toISOString() })
        .eq('seller_id', sellerId)
        .eq('is_default', true);
      if (defaultError) throw persistenceError();
    }
    const patch: Record<string, unknown> = {
      status,
      is_default: isDefault,
      updated_at: new Date().toISOString(),
    };
    if (maskedReference) patch.masked_reference = maskedReference;
    const { error } = await supabase
      .from('seller_payout_methods')
      .update(patch)
      .eq('seller_id', sellerId)
      .eq('provider_method_id', providerMethodId);
    if (error) throw persistenceError();
  }

  async deactivateMissingMethods(
    sellerId: string,
    activeProviderMethodIds: string[],
  ): Promise<void> {
    let query = supabase
      .from('seller_payout_methods')
      .update({ status: 'inactive', updated_at: new Date().toISOString() })
      .eq('seller_id', sellerId)
      .neq('status', 'inactive');
    if (activeProviderMethodIds.length > 0) {
      query = query.not(
        'provider_method_id',
        'in',
        `(${activeProviderMethodIds.join(',')})`,
      );
    }
    const { error } = await query;
    if (error) throw persistenceError();
  }

  async deactivateMethod(sellerId: string, id: string): Promise<void> {
    const { error } = await supabase
      .from('seller_payout_methods')
      .update({
        status: 'inactive',
        is_default: false,
        updated_at: new Date().toISOString(),
      })
      .eq('seller_id', sellerId)
      .eq('id', id);
    if (error) throw persistenceError();
  }
}

@Injectable()
export class SellerPayoutAccountService {
  private readonly provisioning = new Map<
    string,
    Promise<SellerPayoutAccountRow>
  >();

  constructor(
    private readonly whop: WhopPayoutClient,
    private readonly repository: SellerPayoutRepository,
  ) {}

  async ensureConnectedAccount(
    sellerId: string,
  ): Promise<SellerPayoutAccountRow> {
    const existing = await this.repository.getAccount(sellerId);
    if (existing?.providerAccountId) return existing;

    const active = this.provisioning.get(sellerId);
    if (active) return active;

    const promise = this.provision(sellerId);
    this.provisioning.set(sellerId, promise);
    try {
      return await promise;
    } finally {
      this.provisioning.delete(sellerId);
    }
  }

  async getReadiness(sellerId: string): Promise<PayoutReadiness> {
    const account = await this.ensureConnectedAccount(sellerId);
    if (!account.providerAccountId) return this.publicReadiness(account, []);
    return this.syncReadiness(sellerId);
  }

  async startVerification(
    sellerId: string,
    returnUrl?: string,
  ): Promise<PayoutReadiness> {
    if (returnUrl) validateReturnUrl(returnUrl);
    const account = await this.requireProviderAccount(sellerId);
    await this.whop.createVerificationSession(
      account.providerAccountId,
      { kind: 'individual' },
      stableKey('verification', sellerId),
    );
    return this.syncReadiness(sellerId);
  }

  async syncReadiness(sellerId: string): Promise<PayoutReadiness> {
    const account = await this.requireProviderAccount(sellerId);
    const [verifications, providerMethods] = await Promise.all([
      this.whop.listVerifications(account.providerAccountId),
      this.whop.listSavedPayoutMethods(account.providerAccountId),
    ]);
    const verification = verifications[0] ?? null;
    const mapped = mapVerification(verification?.status ?? 'not_started');

    for (const method of providerMethods) {
      await this.repository.syncMethodStatus?.(
        sellerId,
        method.id,
        providerMethodStatus(method.status),
        method.isDefault,
        method.accountReference,
      );
    }
    await this.repository.deactivateMissingMethods?.(
      sellerId,
      providerMethods.map((method) => method.id),
    );

    const updated = await this.repository.updateAccount(sellerId, {
      status: mapped.status,
      verificationStatus: verification?.status ?? 'not_started',
      payoutsEnabled: mapped.payoutsEnabled,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastSyncedAt: new Date().toISOString(),
    });
    const methods = await this.repository.listMethods(sellerId);
    return this.publicReadiness(
      updated,
      methods,
      mapped.actionRequired ? (verification?.url ?? null) : null,
    );
  }

  async listSupportedMethods(sellerId: string) {
    const account = await this.requireProviderAccount(sellerId);
    const methods = await this.whop.listSupportedPayoutMethods(
      account.providerAccountId,
    );
    return methods.map(publicSupportedMethod);
  }

  async listSavedMethods(sellerId: string): Promise<PublicSavedPayoutMethod[]> {
    await this.ensureConnectedAccount(sellerId);
    return (await this.repository.listMethods(sellerId)).map(publicMethod);
  }

  async createSavedMethod(
    sellerId: string,
    input: {
      supportedMethodId: string;
      destinationCurrency?: string;
      fields: Record<string, string>;
      nickname?: string;
      isDefault?: boolean;
    },
  ): Promise<PublicSavedPayoutMethod> {
    validateSupportedMethodInput(input);
    const account = await this.requireProviderAccount(sellerId);
    const idempotencyKey = stableKey(
      'method',
      `${sellerId}:${input.supportedMethodId}:${stableFields(input.fields)}`,
    );
    const providerMethod = await this.whop.createSavedPayoutMethod(
      {
        accountId: account.providerAccountId,
        supportedPayoutMethodId: input.supportedMethodId,
        destinationCurrency: input.destinationCurrency,
        fields: input.fields,
        nickname: input.nickname,
        isDefault: input.isDefault,
      },
      idempotencyKey,
    );

    const methodKey = classifyMethod(providerMethod);
    const row = await this.repository.upsertMethod({
      sellerId,
      providerMethodId: providerMethod.id,
      providerSupportedMethodId: input.supportedMethodId,
      methodKey,
      deliverySpeeds: deliverySpeeds(providerMethod),
      network: cryptoNetwork(providerMethod),
      destinationCountry: null,
      currency: providerMethod.destinationCurrency?.toUpperCase() ?? null,
      nickname: providerMethod.nickname,
      institutionName: providerMethod.institutionName,
      maskedReference:
        providerMethod.accountReference ||
        providerMethod.nickname ||
        'Destino protegido',
      status: providerMethodStatus(providerMethod.status),
      isDefault: providerMethod.isDefault,
    });
    return publicMethod(row);
  }

  async removeSavedMethod(
    sellerId: string,
    localMethodId: string,
  ): Promise<void> {
    const method = await this.assertOwnedActiveMethod(sellerId, localMethodId);
    await this.whop.deleteSavedPayoutMethod(method.providerMethodId);
    await this.repository.deactivateMethod(sellerId, localMethodId);
  }

  async assertOwnedActiveMethod(
    sellerId: string,
    localMethodId: string,
  ): Promise<SellerPayoutMethodRow> {
    const method = await this.repository.getMethod(localMethodId);
    if (!method || method.sellerId !== sellerId || method.status !== 'active') {
      throw new NotFoundException('Método de saque não encontrado.');
    }
    return method;
  }

  private async provision(sellerId: string): Promise<SellerPayoutAccountRow> {
    const seller = await this.repository.getSeller(sellerId);
    if (!seller) throw new NotFoundException('Seller não encontrado.');
    if (seller.status !== 'active') {
      throw new ConflictException('Conta financeira ainda não está ativa.');
    }

    const claimed = await this.repository.claimProvisioning(sellerId);
    if (!claimed) {
      const current = await this.repository.getAccount(sellerId);
      if (current) return current;
      throw new PayoutProvisioningError(
        'provisioning_in_progress',
        'A conta de saque está sendo preparada.',
      );
    }

    try {
      const provider = await this.whop.createConnectedAccount(
        {
          email: seller.email,
          title: seller.name || undefined,
          country: seller.country || undefined,
          metadata: { external_id: sellerId },
          sendCustomerEmails: false,
        },
        stableKey('account', sellerId),
      );
      return await this.repository.updateAccount(sellerId, {
        providerAccountId: provider.id,
        status: 'verification_required',
        verificationStatus: 'not_started',
        payoutsEnabled: false,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
    } catch (error) {
      await this.repository.updateAccount(sellerId, {
        status: 'error',
        payoutsEnabled: false,
        lastErrorCode: 'provider_provisioning_failed',
        lastErrorMessage: 'Não foi possível preparar a conta de saque.',
      });
      if (error instanceof PayoutProvisioningError) throw error;
      throw new PayoutProvisioningError(
        'provider_provisioning_failed',
        'Não foi possível preparar a conta de saque.',
      );
    }
  }

  private async requireProviderAccount(
    sellerId: string,
  ): Promise<SellerPayoutAccountRow & { providerAccountId: string }> {
    const account = await this.ensureConnectedAccount(sellerId);
    if (!account.providerAccountId) {
      throw new ConflictException(
        'A conta de saque ainda está sendo preparada.',
      );
    }
    return account as SellerPayoutAccountRow & { providerAccountId: string };
  }

  private publicReadiness(
    account: SellerPayoutAccountRow,
    methods: SellerPayoutMethodRow[],
    verificationActionUrl: string | null = null,
  ): PayoutReadiness {
    return {
      status: account.status,
      payoutsEnabled: account.payoutsEnabled,
      verificationActionUrl,
      blockerCode: account.lastErrorCode,
      blockerMessage: account.lastErrorMessage,
      methods: methods.map(publicMethod),
    };
  }
}

function mapAccount(row: any): SellerPayoutAccountRow {
  return {
    sellerId: String(row.seller_id),
    providerAccountId:
      typeof row.provider_account_id === 'string'
        ? row.provider_account_id
        : null,
    status: row.status,
    verificationStatus:
      typeof row.verification_status === 'string'
        ? row.verification_status
        : null,
    payoutsEnabled: Boolean(row.payouts_enabled),
    lastErrorCode:
      typeof row.last_error_code === 'string' ? row.last_error_code : null,
    lastErrorMessage:
      typeof row.last_error_message === 'string'
        ? row.last_error_message
        : null,
    lastSyncedAt:
      typeof row.last_synced_at === 'string' ? row.last_synced_at : null,
  };
}

function mapMethod(row: any): SellerPayoutMethodRow {
  return {
    id: String(row.id),
    sellerId: String(row.seller_id),
    providerMethodId: String(row.provider_method_id),
    providerSupportedMethodId: String(row.provider_supported_method_id),
    methodKey: row.method_key,
    deliverySpeeds: Array.isArray(row.delivery_speeds)
      ? row.delivery_speeds.map(String)
      : [],
    network: typeof row.network === 'string' ? row.network : null,
    destinationCountry:
      typeof row.destination_country === 'string'
        ? row.destination_country
        : null,
    currency: typeof row.currency === 'string' ? row.currency : null,
    nickname: typeof row.nickname === 'string' ? row.nickname : null,
    institutionName:
      typeof row.institution_name === 'string' ? row.institution_name : null,
    maskedReference: String(row.masked_reference),
    status: row.status,
    isDefault: Boolean(row.is_default),
  };
}

function publicMethod(row: SellerPayoutMethodRow): PublicSavedPayoutMethod {
  return {
    id: row.id,
    methodKey: row.methodKey,
    label: row.nickname || row.institutionName || methodLabel(row.methodKey),
    maskedReference: row.maskedReference,
    currency: row.currency,
    country: row.destinationCountry,
    network: row.network,
    speeds: [...row.deliverySpeeds],
    isDefault: row.isDefault,
    status: row.status,
  };
}

function publicSupportedMethod(method: WhopSupportedPayoutMethod) {
  return {
    supportedMethodId: method.id,
    name: method.name,
    iconUrl: method.iconUrl,
    deliveryType: method.deliveryType,
    speeds: [
      ...(method.supportsStandardDelivery ? ['standard'] : []),
      ...(method.supportsInstantDelivery ? ['instant'] : []),
    ],
    requiredFields: method.requiredFields,
  };
}

function mapVerification(status: string): {
  status: PayoutReadiness['status'];
  payoutsEnabled: boolean;
  actionRequired: boolean;
} {
  if (status === 'approved') {
    return { status: 'ready', payoutsEnabled: true, actionRequired: false };
  }
  if (status === 'processing' || status === 'manual_review') {
    return {
      status: 'under_review',
      payoutsEnabled: false,
      actionRequired: false,
    };
  }
  if (status === 'rejected') {
    return {
      status: 'restricted',
      payoutsEnabled: false,
      actionRequired: false,
    };
  }
  if (
    status === 'not_started' ||
    status === 'pending' ||
    status === 'action_required'
  ) {
    return {
      status: 'verification_required',
      payoutsEnabled: false,
      actionRequired: true,
    };
  }
  return { status: 'error', payoutsEnabled: false, actionRequired: false };
}

function classifyMethod(method: WhopSavedPayoutMethod): PayoutMethodKey {
  const name = (method.supportedPayoutMethod?.name ?? '').toLowerCase();
  const delivery = method.supportedPayoutMethod?.deliveryType;
  if (delivery === 'cryptocurrency') return 'crypto';
  if (name.includes('pix')) return 'pix';
  if (name.includes('wire') || name.includes('swift')) return 'bank_wire';
  if (name.includes('ach')) {
    if (name.includes('instant')) return 'ach_instant';
    if (name.includes('next day') || name.includes('next-day')) {
      return 'ach_next_day';
    }
    return 'ach_standard';
  }
  throw new BadRequestException(
    'Método de saque ainda não suportado pela Koopfy.',
  );
}

function deliverySpeeds(method: WhopSavedPayoutMethod): string[] {
  const supported = method.supportedPayoutMethod;
  if (!supported) return [];
  return [
    ...(supported.supportsStandardDelivery ? ['standard'] : []),
    ...(supported.supportsInstantDelivery ? ['instant'] : []),
  ];
}

function cryptoNetwork(method: WhopSavedPayoutMethod): string | null {
  const value =
    `${method.nickname ?? ''} ${method.supportedPayoutMethod?.name ?? ''}`.toLowerCase();
  if (value.includes('tron') || value.includes('trc20')) return 'TRON';
  if (value.includes('solana') || value.includes('spl')) return 'SOLANA';
  if (value.includes('ethereum') || value.includes('erc20')) return 'ETHEREUM';
  if (value.includes('bitcoin') || value.includes('btc')) return 'BITCOIN';
  return null;
}

function providerMethodStatus(status: string): SellerPayoutMethodRow['status'] {
  if (status === 'created' || status === 'active') return 'active';
  if (status === 'broken') return 'restricted';
  return 'inactive';
}

function methodLabel(method: PayoutMethodKey): string {
  const labels: Record<PayoutMethodKey, string> = {
    pix: 'Pix',
    bank_wire: 'Bank Wire',
    ach_instant: 'ACH Instant',
    ach_next_day: 'ACH Next Day',
    ach_standard: 'ACH Standard',
    crypto: 'Cripto',
  };
  return labels[method];
}

function validateSupportedMethodInput(input: {
  supportedMethodId: string;
  destinationCurrency?: string;
  fields: Record<string, string>;
}) {
  if (!/^podst_[A-Za-z0-9_]+$/.test(input.supportedMethodId)) {
    throw new BadRequestException('Método de saque inválido.');
  }
  if (
    !input.fields ||
    typeof input.fields !== 'object' ||
    Array.isArray(input.fields)
  ) {
    throw new BadRequestException('Dados do destino inválidos.');
  }
  const entries = Object.entries(input.fields);
  if (
    entries.length === 0 ||
    entries.length > 30 ||
    entries.some(
      ([key, value]) =>
        !/^fld_[A-Za-z0-9_]+$/.test(key) ||
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 500,
    )
  ) {
    throw new BadRequestException('Dados do destino inválidos.');
  }
  if (
    input.destinationCurrency &&
    !/^[A-Za-z]{3,5}$/.test(input.destinationCurrency)
  ) {
    throw new BadRequestException('Moeda de destino inválida.');
  }
}

function stableFields(fields: Record<string, string>): string {
  return Object.keys(fields)
    .sort()
    .map((key) => `${key}:${fields[key]}`)
    .join('|');
}

function stableKey(scope: string, value: string): string {
  return `koopfy_${scope}_${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}

function validateReturnUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new BadRequestException('URL de retorno inválida.');
  }
}

function persistenceError() {
  return new PayoutProvisioningError(
    'payout_storage_unavailable',
    'Não foi possível consultar a configuração de saque.',
  );
}
