import { createHash, randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { supabase } from '../lib/supabase.client';
import {
  calculateKoopfyFee,
  mapWhopPayoutState,
  providerIdempotencyKey,
  providerPayoutMinor,
  signPreviewConfirmation,
  verifyPreviewConfirmation,
} from './payout-domain';
import {
  ConfirmPayoutRequest,
  FeeRule,
  PayoutMethodKey,
  PayoutPreview,
} from './payout.types';
import {
  SellerPayoutAccountService,
  SellerPayoutMethodRow,
} from './seller-payout-account.service';
import {
  WhopMoney,
  WhopPayout,
  WhopPayoutApiError,
  WhopPayoutClient,
  WhopPayoutQuote,
} from './whop-payout.client';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYOUT_METHOD_KEYS: readonly PayoutMethodKey[] = [
  'pix',
  'bank_wire',
  'ach_instant',
  'ach_next_day',
  'ach_standard',
  'crypto',
];

export interface PayoutReservationInput {
  sellerId: string;
  idempotencyKey: string;
  requestHash: string;
  localMethodId: string;
  methodKey: PayoutMethodKey;
  speed: string | null;
  sourceCurrency: 'USD';
  destinationCurrency: string;
  grossMinor: number;
  koopfyFeeMinor: number;
  providerFeeMinor: number;
  providerPayoutMinor: number;
  netMinor: number;
  destinationAmountMinor: number;
  quoteId: string;
  quoteExpiresAt: string;
  exchangeRate: string | null;
  estimatedArrival: string | null;
  confirmedMinimumNetMinor: number;
  providerIdempotencyKey: string;
}

export interface PayoutReservationResult {
  payoutId: string;
  status: string;
  replayed: boolean;
}

export interface RequoteExecution {
  id: string;
  sellerId: string;
  localMethodId: string;
  methodKey: PayoutMethodKey;
  speed: string | null;
  sourceCurrency: string;
  providerPayoutMinor: number;
  localState: string;
}

export interface DispatchExecution extends RequoteExecution {
  ledgerEntryId: string;
  providerAccountId: string;
  providerPayoutId: string | null;
  providerIdempotencyKey: string;
  confirmedMinimumNetMinor: number;
  grossMinor: number;
  koopfyFeeMinor: number;
  providerFeeMinor: number;
  netMinor: number;
  destinationCurrency: string;
  destinationAmountMinor: number;
  exchangeRate: string | null;
  estimatedArrival: string | null;
  acceptedAt: string | null;
  claimedAt: string | null;
  attemptToken: string | null;
  providerCreateStartedAt: string | null;
  providerCreateResolvedAt: string | null;
}

export interface PayoutAdminContext {
  managerId: string;
  role: string;
}

const EXECUTION_COLUMNS = [
  'id',
  'ledger_entry_id',
  'seller_id',
  'seller_payout_method_id',
  'provider_account_id',
  'provider_payout_id',
  'provider_idempotency_key',
  'method_key',
  'delivery_speed',
  'source_currency',
  'destination_currency',
  'gross_minor',
  'koopfy_fee_minor',
  'provider_fee_minor',
  'provider_payout_minor',
  'net_minor',
  'destination_amount_minor',
  'confirmed_minimum_net_minor',
  'exchange_rate',
  'estimated_arrival',
  'accepted_at',
  'claimed_at',
  'dispatch_attempt_token',
  'provider_create_started_at',
  'provider_create_resolved_at',
  'local_state',
].join(', ');

function isMissingPayoutTables(error: { code?: string } | null | undefined): boolean {
  return !!error && ['42P01', 'PGRST205'].includes(error.code ?? '');
}

@Injectable()
export class PayoutExecutionRepository {
  async getFeeRule(methodKey: PayoutMethodKey): Promise<FeeRule> {
    const { data, error } = await supabase
      .from('payout_fee_rules')
      .select('percentage_bps, fixed_fee_usd_cents')
      .eq('method_key', methodKey)
      .eq('enabled', true)
      .lte('effective_at', new Date().toISOString())
      .order('effective_at', { ascending: false })
      .maybeSingle();
    if (error) throw storageUnavailable();
    if (!data) {
      throw new ConflictException(
        'Método de saque temporariamente indisponível.',
      );
    }
    return {
      percentageBps: Number(data.percentage_bps),
      fixedUsdCents: Number(data.fixed_fee_usd_cents),
    };
  }

  async findRequestReplay(
    sellerId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<PayoutReservationResult | null> {
    const { data, error } = await supabase
      .from('payout_request_keys')
      .select('request_hash, response')
      .eq('seller_id', sellerId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (error) throw storageUnavailable();
    if (!data) return null;
    if (data.request_hash !== requestHash) {
      throw new ConflictException(
        'Esta chave de idempotência já foi usada em outro saque.',
      );
    }
    if (!data.response) {
      throw new ServiceUnavailableException(
        'Um saque com esta chave ainda está em processamento.',
      );
    }
    return parseReservationResult(data.response, true);
  }

  async reserve(
    input: PayoutReservationInput,
  ): Promise<PayoutReservationResult> {
    const { data, error } = await supabase.rpc(
      'request_provider_payout_idempotent',
      {
        p_seller_id: input.sellerId,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
        p_seller_payout_method_id: input.localMethodId,
        p_method_key: input.methodKey,
        p_speed: input.speed,
        p_source_currency: input.sourceCurrency,
        p_destination_currency: input.destinationCurrency,
        p_gross_minor: input.grossMinor,
        p_koopfy_fee_minor: input.koopfyFeeMinor,
        p_provider_fee_minor: input.providerFeeMinor,
        p_provider_payout_minor: input.providerPayoutMinor,
        p_net_minor: input.netMinor,
        p_destination_amount_minor: input.destinationAmountMinor,
        p_quote_id: input.quoteId,
        p_quote_expires_at: input.quoteExpiresAt,
        p_exchange_rate: input.exchangeRate,
        p_estimated_arrival: input.estimatedArrival,
        p_confirmed_minimum_net_minor: input.confirmedMinimumNetMinor,
        p_provider_idempotency_key: input.providerIdempotencyKey,
      },
    );
    if (error) throw mapRpcError(error);
    return parseReservationResult(data, false);
  }

  async getRequoteExecution(
    sellerId: string,
    payoutId: string,
  ): Promise<RequoteExecution> {
    const { data, error } = await supabase
      .from('payout_executions')
      .select(
        'id, seller_id, seller_payout_method_id, method_key, delivery_speed, source_currency, provider_payout_minor, local_state',
      )
      .eq('id', payoutId)
      .eq('seller_id', sellerId)
      .maybeSingle();
    if (error) throw storageUnavailable();
    if (!data) throw new NotFoundException('Saque não encontrado.');
    return {
      id: String(data.id),
      sellerId: String(data.seller_id),
      localMethodId: String(data.seller_payout_method_id),
      methodKey: data.method_key as PayoutMethodKey,
      speed:
        typeof data.delivery_speed === 'string' ? data.delivery_speed : null,
      sourceCurrency: String(data.source_currency),
      providerPayoutMinor: Number(data.provider_payout_minor),
      localState: String(data.local_state),
    };
  }

  async requeueRequoted(
    payoutId: string,
    input: {
      providerFeeMinor: number;
      netMinor: number;
      destinationAmountMinor: number;
      quoteId: string;
      quoteExpiresAt: string;
      exchangeRate: string | null;
      estimatedArrival: string | null;
      confirmedMinimumNetMinor: number;
    },
  ): Promise<{ payoutId: string; status: 'pending_review'; replayed: false }> {
    const { data, error } = await supabase.rpc('requeue_requoted_payout', {
      p_payout_id: payoutId,
      p_provider_fee_minor: input.providerFeeMinor,
      p_net_minor: input.netMinor,
      p_destination_amount_minor: input.destinationAmountMinor,
      p_quote_id: input.quoteId,
      p_quote_expires_at: input.quoteExpiresAt,
      p_exchange_rate: input.exchangeRate,
      p_estimated_arrival: input.estimatedArrival,
      p_confirmed_minimum_net_minor: input.confirmedMinimumNetMinor,
    });
    if (error) throw mapRpcError(error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.requeued) {
      throw new InternalServerErrorException(
        'Não foi possível confirmar a nova cotação.',
      );
    }
    return { payoutId, status: 'pending_review', replayed: false };
  }

  async findByReference(reference: string): Promise<DispatchExecution | null> {
    const byLedger = await supabase
      .from('payout_executions')
      .select(EXECUTION_COLUMNS)
      .eq('ledger_entry_id', reference)
      .maybeSingle();
    // Banco sem a migration do saque pela master: nenhum saque é deste fluxo e
    // o CRM segue pelo fluxo de conta conectada (não pode travar aprovação).
    if (isMissingPayoutTables(byLedger.error)) return null;
    if (byLedger.error) throw storageUnavailable();
    if (byLedger.data) return mapDispatchExecution(byLedger.data);
    if (!UUID_PATTERN.test(reference)) return null;

    const byId = await supabase
      .from('payout_executions')
      .select(EXECUTION_COLUMNS)
      .eq('id', reference)
      .maybeSingle();
    if (byId.error) throw storageUnavailable();
    return byId.data ? mapDispatchExecution(byId.data) : null;
  }

  async findByProviderPayoutId(
    providerPayoutId: string,
  ): Promise<DispatchExecution | null> {
    const { data, error } = await supabase
      .from('payout_executions')
      .select(EXECUTION_COLUMNS)
      .eq('provider_payout_id', providerPayoutId)
      .maybeSingle();
    if (error) throw storageUnavailable();
    return data ? mapDispatchExecution(data) : null;
  }

  async listStaleExecutions(
    staleBefore: string,
    limit: number,
  ): Promise<DispatchExecution[]> {
    const { data, error } = await supabase
      .from('payout_executions')
      .select(EXECUTION_COLUMNS)
      .in('local_state', ['dispatching', 'processing'])
      .or('provider_payout_id.not.is.null,provider_create_started_at.is.null')
      .lte('updated_at', staleBefore)
      .order('updated_at', { ascending: true })
      .limit(limit);
    if (error) throw storageUnavailable();
    return (data ?? []).map(mapDispatchExecution);
  }

  async countUnresolvedProviderCreates(staleBefore: string): Promise<number> {
    const { count, error } = await supabase
      .from('payout_executions')
      .select('id', { count: 'exact', head: true })
      .eq('local_state', 'dispatching')
      .is('provider_payout_id', null)
      .not('provider_create_started_at', 'is', null)
      .is('provider_create_resolved_at', null)
      .lte('updated_at', staleBefore);
    if (error) throw storageUnavailable();
    return count ?? 0;
  }

  async claimDispatch(
    reference: string,
    managerId: string,
  ): Promise<DispatchExecution | null> {
    const execution = await this.findByReference(reference);
    if (!execution) throw new NotFoundException('Saque não encontrado.');
    if (execution.localState !== 'pending_review') return null;

    const { data, error } = await supabase.rpc('claim_payout_dispatch', {
      p_payout_id: execution.id,
      p_manager_id: managerId,
    });
    if (error) throw mapRpcError(error);
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.claimed) return null;
    return {
      ...execution,
      localState: 'dispatching',
      claimedAt:
        typeof result.claimedAt === 'string'
          ? result.claimedAt
          : execution.claimedAt,
      attemptToken:
        typeof result.attemptToken === 'string'
          ? result.attemptToken
          : execution.attemptToken,
    };
  }

  async claimRetry(
    reference: string,
    managerId: string,
  ): Promise<DispatchExecution | null> {
    const execution = await this.findByReference(reference);
    if (!execution) throw new NotFoundException('Saque não encontrado.');
    if (execution.localState !== 'dispatch_failed') return null;
    const attemptToken = randomUUID();
    const { data, error } = await supabase
      .from('payout_executions')
      .update({
        local_state: 'dispatching',
        claimed_by: managerId,
        claimed_at: new Date().toISOString(),
        dispatch_attempt_token: attemptToken,
        provider_create_started_at: null,
        provider_create_resolved_at: null,
        error_code: null,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', execution.id)
      .eq('local_state', 'dispatch_failed')
      .select(EXECUTION_COLUMNS)
      .maybeSingle();
    if (error) throw storageUnavailable();
    return data ? mapDispatchExecution(data) : null;
  }

  async markRequoteRequired(
    payoutId: string,
    snapshot: {
      providerFeeMinor: number;
      netMinor: number;
      destinationCurrency: string;
      destinationAmountMinor: number;
      quoteId: string;
      quoteExpiresAt: string;
      exchangeRate: string | null;
      estimatedArrival: string | null;
    },
    attemptToken: string | null,
  ) {
    const { data, error } = await supabase.rpc(
      'mark_payout_requote_required',
      {
        p_payout_id: payoutId,
        p_provider_fee_minor: snapshot.providerFeeMinor,
        p_net_minor: snapshot.netMinor,
        p_destination_currency: snapshot.destinationCurrency,
        p_destination_amount_minor: snapshot.destinationAmountMinor,
        p_quote_id: snapshot.quoteId,
        p_quote_expires_at: snapshot.quoteExpiresAt,
        p_exchange_rate: snapshot.exchangeRate,
        p_estimated_arrival: snapshot.estimatedArrival,
        p_attempt_token: attemptToken,
      },
    );
    if (error) throw mapRpcError(error);
    const result = Array.isArray(data) ? data[0] : data;
    return {
      payoutId,
      state: String(result?.state ?? 'requote_required'),
    };
  }

  async persistApprovalQuote(
    payoutId: string,
    snapshot: {
      providerFeeMinor: number;
      netMinor: number;
      destinationCurrency: string;
      destinationAmountMinor: number;
      quoteId: string;
      quoteExpiresAt: string;
      exchangeRate: string | null;
      estimatedArrival: string | null;
    },
    attemptToken: string | null,
  ) {
    const { data, error } = await supabase
      .from('payout_executions')
      .update({
        provider_fee_minor: snapshot.providerFeeMinor,
        net_minor: snapshot.netMinor,
        destination_currency: snapshot.destinationCurrency,
        destination_amount_minor: snapshot.destinationAmountMinor,
        quote_id: snapshot.quoteId,
        quote_expires_at: snapshot.quoteExpiresAt,
        exchange_rate: snapshot.exchangeRate,
        estimated_arrival: snapshot.estimatedArrival,
        updated_at: new Date().toISOString(),
      })
      .eq('id', payoutId)
      .eq('local_state', 'dispatching')
      .eq('dispatch_attempt_token', attemptToken)
      .is('provider_create_started_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw storageUnavailable();
    if (!data) throw new ConflictException('O saque não está mais em despacho.');
  }

  async claimReconciliation(
    reference: string,
    managerId: string,
    staleBefore: string,
  ): Promise<DispatchExecution | null> {
    const execution = await this.findByReference(reference);
    if (!execution) throw new NotFoundException('Saque não encontrado.');
    const { data, error } = await supabase.rpc('claim_payout_reconciliation', {
      p_payout_id: execution.id,
      p_manager_id: managerId,
      p_stale_before: staleBefore,
    });
    if (error) throw mapRpcError(error);
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.claimed) return null;
    return {
      ...execution,
      localState: 'dispatching',
      claimedAt:
        typeof result.claimedAt === 'string'
          ? result.claimedAt
          : new Date().toISOString(),
      attemptToken:
        typeof result.attemptToken === 'string'
          ? result.attemptToken
          : execution.attemptToken,
    };
  }

  async updateDispatchState(
    payoutId: string,
    state: 'dispatching' | 'dispatch_failed',
    detail: { code: string; message: string; retryable: boolean },
    attemptToken: string,
  ) {
    const { data, error } = await supabase
      .from('payout_executions')
      .update({
        local_state: state,
        error_code: detail.code,
        error_message: detail.message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', payoutId)
      .eq('local_state', 'dispatching')
      .eq('dispatch_attempt_token', attemptToken)
      .is('provider_create_started_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw storageUnavailable();
    return Boolean(data);
  }

  async markProviderCreateStarted(payoutId: string, attemptToken: string) {
    const { data, error } = await supabase.rpc('mark_payout_create_started', {
      p_payout_id: payoutId,
      p_attempt_token: attemptToken,
    });
    if (error) throw mapRpcError(error);
    const result = Array.isArray(data) ? data[0] : data;
    return Boolean(result?.started);
  }

  async resolveProviderCreateFailure(
    payoutId: string,
    attemptToken: string,
    detail: { code: string; message: string },
  ) {
    const { data, error } = await supabase.rpc(
      'resolve_payout_create_failure',
      {
        p_payout_id: payoutId,
        p_attempt_token: attemptToken,
        p_error_code: detail.code,
        p_error_message: detail.message,
      },
    );
    if (error) throw mapRpcError(error);
    const result = Array.isArray(data) ? data[0] : data;
    return { payoutId, state: String(result?.state ?? 'dispatch_failed') };
  }

  async attachRecoveredProviderPayout(
    payoutId: string,
    providerPayoutId: string,
    providerStatus: string,
    attemptToken: string,
  ) {
    const { data, error } = await supabase.rpc(
      'attach_recovered_provider_payout',
      {
        p_payout_id: payoutId,
        p_provider_payout_id: providerPayoutId,
        p_provider_status: providerStatus,
        p_attempt_token: attemptToken,
      },
    );
    if (error) throw mapRpcError(error);
    const result = Array.isArray(data) ? data[0] : data;
    return { payoutId, state: String(result?.state ?? 'processing') };
  }

  async recordUncertainCreate(
    payoutId: string,
    attemptToken: string,
    detail: { code: string; message: string },
  ) {
    const { data, error } = await supabase
      .from('payout_executions')
      .update({
        error_code: detail.code,
        error_message: detail.message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', payoutId)
      .eq('local_state', 'dispatching')
      .eq('dispatch_attempt_token', attemptToken)
      .is('provider_create_resolved_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw storageUnavailable();
    return Boolean(data);
  }

  async recordProviderPayoutId(
    payoutId: string,
    providerPayoutId: string,
    providerStatus: string,
    attemptToken: string,
  ) {
    const { data, error } = await supabase
      .from('payout_executions')
      .update({
        provider_payout_id: providerPayoutId,
        provider_status: providerStatus,
        provider_create_resolved_at: new Date().toISOString(),
        dispatched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', payoutId)
      .eq('local_state', 'dispatching')
      .eq('dispatch_attempt_token', attemptToken)
      .not('provider_create_started_at', 'is', null)
      .is('provider_create_resolved_at', null)
      .is('provider_payout_id', null)
      .is('accepted_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw storageUnavailable();
    if (!data) {
      const current = await this.findByReference(payoutId);
      if (current?.providerPayoutId === providerPayoutId) return;
      throw new ConflictException(
        'A tentativa de despacho não pode mais registrar este payout.',
      );
    }
  }

  async finalizeAccepted(
    payoutId: string,
    providerPayoutId: string,
    providerStatus: string,
  ) {
    const { data, error } = await supabase.rpc('finalize_payout_outflow', {
      p_payout_id: payoutId,
      p_provider_payout_id: providerPayoutId,
      p_provider_status: providerStatus,
    });
    if (error) throw mapRpcError(error);
    const result = Array.isArray(data) ? data[0] : data;
    return { payoutId, state: String(result?.state ?? 'processing') };
  }

  async releaseReservation(
    payoutId: string,
    managerId: string,
    reason: string,
  ) {
    const { data, error } = await supabase.rpc('release_payout_reservation', {
      p_payout_id: payoutId,
      p_manager_id: managerId,
      p_reason: reason,
    });
    if (error) throw mapRpcError(error);
    const result = Array.isArray(data) ? data[0] : data;
    return { payoutId, state: String(result?.state ?? 'rejected') };
  }

  async applyProviderState(
    payoutId: string,
    _ledgerEntryId: string,
    payout: WhopPayout,
  ) {
    const state = mapWhopPayoutState(payout.status);
    const { data, error } = await supabase.rpc('apply_provider_payout_state', {
      p_payout_id: payoutId,
      p_provider_payout_id: payout.id,
      p_provider_status: payout.status,
      p_local_state: state,
    });
    if (error) throw mapRpcError(error);
    const result = Array.isArray(data) ? data[0] : data;
    return { payoutId, state: String(result?.state ?? state) };
  }

  async restoreProviderFunds(payoutId: string, payout: WhopPayout, reason: string) {
    const state = mapWhopPayoutState(payout.status);
    const { data, error } = await supabase.rpc(
      'restore_provider_payout_funds',
      {
        p_payout_id: payoutId,
        p_terminal_state: state,
        p_funds_returned_at: payout.failure?.fundsReturnedAt ?? null,
        p_reason: reason,
      },
    );
    if (error) throw mapRpcError(error);
    const result = Array.isArray(data) ? data[0] : data;
    return {
      payoutId,
      state,
      restored: Boolean(result?.restored),
    };
  }

  async listFeeRules() {
    const { data, error } = await supabase
      .from('payout_fee_rules')
      .select(
        'method_key, percentage_bps, fixed_fee_usd_cents, enabled, effective_at, updated_by, updated_at',
      )
      .order('method_key');
    if (error) throw storageUnavailable();
    return (data ?? []).map(mapFeeRule);
  }

  async updateFeeRule(
    methodKey: PayoutMethodKey,
    input: {
      percentageBps: number;
      fixedUsdCents: number;
      enabled: boolean;
      effectiveAt: string;
    },
    managerId: string,
  ) {
    const { data, error } = await supabase
      .from('payout_fee_rules')
      .update({
        percentage_bps: input.percentageBps,
        fixed_fee_usd_cents: input.fixedUsdCents,
        enabled: input.enabled,
        effective_at: input.effectiveAt,
        updated_by: managerId,
        updated_at: new Date().toISOString(),
      })
      .eq('method_key', methodKey)
      .select(
        'method_key, percentage_bps, fixed_fee_usd_cents, enabled, effective_at, updated_by, updated_at',
      )
      .maybeSingle();
    if (error) throw storageUnavailable();
    if (!data) throw new NotFoundException('Regra de taxa não encontrada.');
    return mapFeeRule(data);
  }
}

@Injectable()
export class PayoutOrchestratorService {
  constructor(
    private readonly accounts: SellerPayoutAccountService,
    private readonly whop: WhopPayoutClient,
    private readonly repository: PayoutExecutionRepository,
  ) {}

  async preview(
    sellerId: string,
    input: { methodId: string; speed?: string | null; grossMinor: number },
  ): Promise<PayoutPreview> {
    assertPreviewInput(input);
    const context = await this.quoteContext(
      sellerId,
      input.methodId,
      input.speed ?? null,
      input.grossMinor,
      randomQuoteKey(),
    );
    const previewExpiresAt = context.quote.expiresAt;
    const proofFields = {
      methodId: input.methodId,
      speed: input.speed ?? null,
      grossMinor: input.grossMinor,
      confirmedMinimumNetMinor: context.snapshot.netMinor,
      previewExpiresAt,
    };
    return {
      ...proofFields,
      methodKey: context.method.methodKey,
      consolidatedFeeMinor:
        context.koopfyFeeMinor + context.snapshot.providerFeeMinor,
      netMinor: context.snapshot.netMinor,
      sourceCurrency: 'USD',
      destinationCurrency: context.snapshot.destinationCurrency,
      destinationAmountMinor: context.snapshot.destinationAmountMinor,
      exchangeRate: context.snapshot.exchangeRate,
      estimatedArrival: context.snapshot.estimatedArrival,
      expiresAt: context.quote.expiresAt,
      confirmationToken: signPreviewConfirmation(
        proofFields,
        sellerId,
        previewSecret(),
      ),
    };
  }

  async confirm(
    sellerId: string,
    input: ConfirmPayoutRequest,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<PayoutReservationResult> {
    assertConfirmationInput(input, idempotencyKey);
    if (
      !verifyPreviewConfirmation(
        input,
        sellerId,
        input.confirmationToken,
        previewSecret(),
      )
    ) {
      throw new ConflictException(
        'A cotação expirou ou foi alterada. Revise novamente.',
      );
    }

    const requestHash = confirmationHash(sellerId, input);
    const replay = await this.repository.findRequestReplay(
      sellerId,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    if (new Date(input.previewExpiresAt).getTime() <= now.getTime()) {
      throw new ConflictException(
        'A cotação expirou ou foi alterada. Revise novamente.',
      );
    }

    const context = await this.quoteContext(
      sellerId,
      input.methodId,
      input.speed,
      input.grossMinor,
      quoteKey('confirm', sellerId, idempotencyKey),
    );
    if (context.snapshot.netMinor < input.confirmedMinimumNetMinor) {
      throw new ConflictException(
        'A cotação mudou. Revise o valor líquido antes de confirmar.',
      );
    }

    return this.repository.reserve({
      sellerId,
      idempotencyKey,
      requestHash,
      localMethodId: input.methodId,
      methodKey: context.method.methodKey,
      speed: input.speed,
      sourceCurrency: 'USD',
      destinationCurrency: context.snapshot.destinationCurrency,
      grossMinor: input.grossMinor,
      koopfyFeeMinor: context.koopfyFeeMinor,
      providerFeeMinor: context.snapshot.providerFeeMinor,
      providerPayoutMinor: context.providerPayoutMinor,
      netMinor: context.snapshot.netMinor,
      destinationAmountMinor: context.snapshot.destinationAmountMinor,
      quoteId: context.quote.id,
      quoteExpiresAt: context.quote.expiresAt,
      exchangeRate: context.snapshot.exchangeRate,
      estimatedArrival: context.snapshot.estimatedArrival,
      confirmedMinimumNetMinor: input.confirmedMinimumNetMinor,
      providerIdempotencyKey: providerIdempotencyKey(
        `${sellerId}:${idempotencyKey}`,
      ),
    });
  }

  async reconfirm(
    sellerId: string,
    payoutId: string,
    confirmedMinimumNetMinor: number,
    idempotencyKey: string,
  ): Promise<PayoutReservationResult> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey ?? '')) {
      throw new BadRequestException('Idempotency-Key inválido.');
    }
    assertMinor(confirmedMinimumNetMinor);
    const execution = await this.repository.getRequoteExecution(
      sellerId,
      payoutId,
    );
    if (execution.localState !== 'requote_required') {
      throw new ConflictException(
        'Este saque não aguarda uma nova confirmação.',
      );
    }
    const method = await this.accounts.assertOwnedActiveMethod(
      sellerId,
      execution.localMethodId,
    );
    const account = await this.readyAccount(sellerId);
    const selectedSpeed = normalizeSpeed(execution.speed);
    const [quote, savedMethods] = await Promise.all([
      this.whop.createQuote(
        {
          accountId: account.providerAccountId,
          amount: execution.providerPayoutMinor / 100,
          currency: execution.sourceCurrency.toLowerCase(),
          payoutMethodId: method.providerMethodId,
          speed: selectedSpeed,
          platformCoversFees: false,
        },
        quoteKey('reconfirm', payoutId, idempotencyKey),
      ),
      this.whop.listSavedPayoutMethods(account.providerAccountId),
    ]);
    const snapshot = quoteSnapshot(
      quote,
      execution.providerPayoutMinor,
      savedMethodEta(savedMethods, method.providerMethodId, selectedSpeed),
    );
    if (snapshot.netMinor < confirmedMinimumNetMinor) {
      throw new ConflictException(
        'A cotação mudou novamente. Revise o valor líquido.',
      );
    }
    return this.repository.requeueRequoted(payoutId, {
      providerFeeMinor: snapshot.providerFeeMinor,
      netMinor: snapshot.netMinor,
      destinationAmountMinor: snapshot.destinationAmountMinor,
      quoteId: quote.id,
      quoteExpiresAt: quote.expiresAt,
      exchangeRate: snapshot.exchangeRate,
      estimatedArrival: snapshot.estimatedArrival,
      confirmedMinimumNetMinor,
    });
  }

  findByReference(reference: string) {
    return this.repository.findByReference(reference);
  }

  async approveAndDispatch(
    reference: string,
    admin: PayoutAdminContext,
  ) {
    assertAdminContext(admin);
    assertDispatchEnabled();
    const execution = await this.repository.claimDispatch(
      reference,
      admin.managerId,
    );
    if (!execution) {
      return {
        payoutId: reference,
        state: 'already_claimed',
        dispatched: false,
      };
    }
    return this.dispatchClaimedExecution(execution);
  }

  async reject(
    reference: string,
    admin: PayoutAdminContext,
    reason: string,
  ) {
    assertAdminContext(admin);
    if (!reason?.trim()) throw new BadRequestException('Motivo é obrigatório.');
    const execution = await this.requiredExecution(reference);
    if (
      !['pending_review', 'requote_required', 'dispatch_failed'].includes(
        execution.localState,
      )
    ) {
      throw new ConflictException(
        'Este saque não pode ser cancelado enquanto o envio é incerto ou já foi aceito.',
      );
    }
    return this.repository.releaseReservation(
      execution.id,
      admin.managerId,
      reason.trim(),
    );
  }

  cancelBeforeAcceptance(
    reference: string,
    admin: PayoutAdminContext,
    reason: string,
  ) {
    return this.reject(reference, admin, reason);
  }

  async retryDispatch(reference: string, admin: PayoutAdminContext) {
    assertAdminContext(admin);
    assertDispatchEnabled();
    const execution = await this.repository.claimRetry(
      reference,
      admin.managerId,
    );
    if (!execution) {
      throw new ConflictException(
        'Este saque não está disponível para uma nova tentativa.',
      );
    }
    return this.dispatchClaimedExecution(execution);
  }

  async reconcileOne(reference: string, admin: PayoutAdminContext) {
    assertAdminContext(admin);
    const execution = await this.requiredExecution(reference);
    if (!execution.providerPayoutId) {
      if (
        execution.providerCreateStartedAt &&
        !execution.providerCreateResolvedAt
      ) {
        return {
          payoutId: execution.id,
          state: 'dispatching',
          retryable: false,
          manualReconciliationRequired: true,
        };
      }
      if (execution.localState === 'dispatch_failed') {
        return this.retryDispatch(execution.id, admin);
      }
      if (execution.localState !== 'dispatching') {
        throw new ConflictException(
          'Este saque não possui uma operação externa para reconciliar.',
        );
      }
      assertDispatchEnabled();
      const claimed = await this.repository.claimReconciliation(
        execution.id,
        admin.managerId,
        reconciliationStaleBefore(),
      );
      if (!claimed) {
        throw new ConflictException(
          'Este saque ainda está em processamento por outra tentativa.',
        );
      }
      return this.dispatchClaimedExecution(claimed);
    }
    const payout = await this.whop.retrievePayout(
      execution.providerPayoutId,
      execution.providerAccountId,
    );
    return this.applyRetrievedPayout(execution, payout, 'Reconciliação CRM');
  }

  async manualOverride(
    reference: string,
    admin: PayoutAdminContext,
    action: string,
    reason: string,
  ) {
    assertAdminContext(admin);
    if (!reason?.trim()) throw new BadRequestException('Motivo é obrigatório.');
    if (
      !['completed', 'failed', 'canceled', 'denied', 'reversed'].includes(
        action,
      )
    ) {
      throw new BadRequestException('Ação de recuperação inválida.');
    }
    const execution = await this.requiredExecution(reference);
    if (!execution.providerPayoutId) {
      throw new ConflictException(
        'O saque ainda não foi aceito pelo provedor.',
      );
    }
    const payout = await this.whop.retrievePayout(
      execution.providerPayoutId,
      execution.providerAccountId,
    );
    const providerState = mapWhopPayoutState(payout.status);
    if (providerState !== action) {
      throw new ConflictException(
        'O estado confirmado pelo provedor não corresponde à ação solicitada.',
      );
    }
    return this.applyRetrievedPayout(execution, payout, reason.trim());
  }

  async attachProviderPayout(
    reference: string,
    providerPayoutId: string,
    admin: PayoutAdminContext,
    reason: string,
  ) {
    assertAdminContext(admin);
    if (!reason?.trim()) throw new BadRequestException('Motivo é obrigatório.');
    if (!/^wdrl_[A-Za-z0-9_]+$/.test(providerPayoutId ?? '')) {
      throw new BadRequestException('ID do payout do provider inválido.');
    }
    const execution = await this.requiredExecution(reference);
    if (
      execution.localState !== 'dispatching' ||
      execution.providerPayoutId ||
      !execution.providerCreateStartedAt ||
      execution.providerCreateResolvedAt
    ) {
      throw new ConflictException(
        'Este saque não possui um envio incerto que possa ser vinculado.',
      );
    }
    const payout = await this.whop.retrievePayout(
      providerPayoutId,
      execution.providerAccountId,
    );
    return this.applyVerifiedProviderPayout(
      execution.id,
      payout,
      reason.trim(),
    );
  }

  async applyVerifiedProviderPayout(
    reference: string,
    payout: WhopPayout,
    reason: string,
  ) {
    const execution = await this.requiredExecution(reference);
    if (
      execution.providerPayoutId &&
      execution.providerPayoutId !== payout.id
    ) {
      throw new ConflictException(
        'O payout do provider não corresponde à execução registrada.',
      );
    }
    assertProviderPayoutFinancials(execution, payout);
    let attached: { payoutId: string; state: string } | null = null;
    if (!execution.providerPayoutId) {
      if (
        execution.localState !== 'dispatching' ||
        !execution.providerCreateStartedAt ||
        execution.providerCreateResolvedAt
      ) {
        throw new ConflictException(
          'A execução não possui um envio incerto recuperável.',
        );
      }
      assertRecoveredPayoutOwnership(execution, payout);
      attached = await this.repository.attachRecoveredProviderPayout(
        execution.id,
        payout.id,
        payout.status,
        requiredAttemptToken(execution),
      );
    } else if (!execution.acceptedAt) {
      await this.repository.finalizeAccepted(
        execution.id,
        payout.id,
        payout.status,
      );
    }
    const state = mapWhopPayoutState(payout.status);
    if (['failed', 'canceled', 'denied', 'reversed'].includes(state)) {
      return this.repository.restoreProviderFunds(
        execution.id,
        payout,
        reason,
      );
    }
    if (state === 'completed') {
      return this.repository.applyProviderState(
        execution.id,
        execution.ledgerEntryId,
        payout,
      );
    }
    if (attached) return attached;
    return this.repository.applyProviderState(
      execution.id,
      execution.ledgerEntryId,
      payout,
    );
  }

  listFeeRules() {
    return this.repository.listFeeRules();
  }

  updateFeeRule(
    methodKey: string,
    input: {
      percentageBps: number;
      fixedUsdCents: number;
      enabled: boolean;
      effectiveAt: string;
    },
    managerId: string,
  ) {
    if (!PAYOUT_METHOD_KEYS.includes(methodKey as PayoutMethodKey)) {
      throw new BadRequestException('Método de payout inválido.');
    }
    if (
      !Number.isInteger(input.percentageBps) ||
      input.percentageBps < 0 ||
      input.percentageBps > 10_000 ||
      !Number.isSafeInteger(input.fixedUsdCents) ||
      input.fixedUsdCents < 0 ||
      typeof input.enabled !== 'boolean' ||
      typeof input.effectiveAt !== 'string' ||
      Number.isNaN(Date.parse(input.effectiveAt)) ||
      Date.parse(input.effectiveAt) > Date.now()
    ) {
      throw new BadRequestException('Regra de taxa inválida.');
    }
    return this.repository.updateFeeRule(
      methodKey as PayoutMethodKey,
      input,
      managerId,
    );
  }

  async getCrmDetail(reference: string) {
    const execution = await this.requiredExecution(reference);
    const readiness = await this.accounts.getReadiness(execution.sellerId);
    return {
      payoutId: execution.id,
      ledgerEntryId: execution.ledgerEntryId,
      sellerId: execution.sellerId,
      state: execution.localState,
      methodKey: execution.methodKey,
      speed: execution.speed,
      grossMinor: execution.grossMinor,
      koopfyFeeMinor: execution.koopfyFeeMinor,
      providerFeeMinor: execution.providerFeeMinor,
      providerPayoutMinor: execution.providerPayoutMinor,
      netMinor: execution.netMinor,
      destinationCurrency: execution.destinationCurrency,
      destinationAmountMinor: execution.destinationAmountMinor,
      exchangeRate: execution.exchangeRate,
      estimatedArrival: execution.estimatedArrival,
      providerPayoutId: execution.providerPayoutId,
      readiness: {
        status: readiness.status,
        payoutsEnabled: readiness.payoutsEnabled,
        blockerCode: readiness.blockerCode,
        blockerMessage: readiness.blockerMessage,
      },
    };
  }

  private async dispatchClaimedExecution(execution: DispatchExecution) {
    const attemptToken = requiredAttemptToken(execution);
    let createStarted = false;
    let payout: WhopPayout;
    try {
      const [account, method] = await Promise.all([
        this.readyAccount(execution.sellerId),
        this.accounts.assertOwnedActiveMethod(
          execution.sellerId,
          execution.localMethodId,
        ),
      ]);
      const speed = normalizeSpeed(execution.speed);
      const quote = await this.whop.createQuote(
        {
          accountId: account.providerAccountId,
          amount: execution.providerPayoutMinor / 100,
          currency: execution.sourceCurrency.toLowerCase(),
          payoutMethodId: method.providerMethodId,
          speed,
          platformCoversFees: false,
        },
        quoteKey(
          'approval',
          execution.id,
          execution.claimedAt ?? execution.providerIdempotencyKey,
        ),
      );
      const snapshot = quoteSnapshot(quote, execution.providerPayoutMinor);
      if (snapshot.netMinor < execution.confirmedMinimumNetMinor) {
        return this.repository.markRequoteRequired(execution.id, {
          ...snapshot,
          quoteId: quote.id,
          quoteExpiresAt: quote.expiresAt,
        }, attemptToken);
      }
      await this.repository.persistApprovalQuote(execution.id, {
        ...snapshot,
        quoteId: quote.id,
        quoteExpiresAt: quote.expiresAt,
      }, attemptToken);
      const started = await this.repository.markProviderCreateStarted(
        execution.id,
        attemptToken,
      );
      if (!started) {
        throw new ConflictException(
          'A tentativa de despacho não está mais disponível.',
        );
      }
      createStarted = true;
      payout = await this.whop.createPayout(
        {
          accountId: account.providerAccountId,
          amount: execution.providerPayoutMinor / 100,
          currency: execution.sourceCurrency.toLowerCase(),
          payoutMethodId: method.providerMethodId,
          quoteToken: quote.quoteToken,
          speed,
          platformCoversFees: false,
          metadata: {
            koopfy_payout_id: execution.id,
            koopfy_seller_id: execution.sellerId,
            koopfy_account_id: account.providerAccountId,
            koopfy_master_account_id: this.whop.getMasterAccountId(),
          },
        },
        execution.providerIdempotencyKey,
      );
    } catch (error) {
      if (
        error instanceof WhopPayoutApiError &&
        error.idempotencyReplay &&
        (error.providerPayoutId || execution.providerPayoutId)
      ) {
        payout = await this.whop.retrievePayout(
          error.providerPayoutId ?? execution.providerPayoutId!,
          execution.providerAccountId,
        );
      } else {
        const failure = dispatchFailure(error);
        if (createStarted) {
          if (
            isDefinitiveProviderRejection(error) ||
            isKnownPreRequestFailure(error)
          ) {
            await this.repository.resolveProviderCreateFailure(
              execution.id,
              attemptToken,
              failure,
            );
          } else {
            await this.repository.recordUncertainCreate(
              execution.id,
              attemptToken,
              failure,
            );
            return {
              payoutId: execution.id,
              state: 'dispatching',
              retryable: false,
              manualReconciliationRequired: true,
            };
          }
        } else {
          const updated = await this.repository.updateDispatchState(
            execution.id,
            failure.state,
            failure,
            attemptToken,
          );
          if (!updated) {
            return {
              payoutId: execution.id,
              state: 'dispatching',
              retryable: false,
              superseded: true,
            };
          }
        }
        return {
          payoutId: execution.id,
          state: failure.state,
          retryable: failure.retryable,
        };
      }
    }

    await this.repository.recordProviderPayoutId(
      execution.id,
      payout.id,
      payout.status,
      attemptToken,
    );
    const finalized = await this.repository.finalizeAccepted(
      execution.id,
      payout.id,
      payout.status,
    );
    return {
      ...finalized,
      providerPayoutId: payout.id,
      retryable: false,
    };
  }

  private async applyRetrievedPayout(
    execution: DispatchExecution,
    payout: WhopPayout,
    reason: string,
  ) {
    const state = mapWhopPayoutState(payout.status);
    if (!execution.providerPayoutId) {
      await this.repository.recordProviderPayoutId(
        execution.id,
        payout.id,
        payout.status,
        requiredAttemptToken(execution),
      );
    }
    if (!execution.acceptedAt) {
      await this.repository.finalizeAccepted(
        execution.id,
        payout.id,
        payout.status,
      );
    }
    if (['failed', 'canceled', 'denied', 'reversed'].includes(state)) {
      return this.repository.restoreProviderFunds(execution.id, payout, reason);
    }
    return this.repository.applyProviderState(
      execution.id,
      execution.ledgerEntryId,
      payout,
    );
  }

  private async requiredExecution(reference: string) {
    const execution = await this.repository.findByReference(reference);
    if (!execution) throw new NotFoundException('Saque não encontrado.');
    return execution;
  }

  private async quoteContext(
    sellerId: string,
    methodId: string,
    speed: string | null,
    grossMinor: number,
    quoteIdempotencyKey: string,
  ) {
    const [account, method] = await Promise.all([
      this.readyAccount(sellerId),
      this.accounts.assertOwnedActiveMethod(sellerId, methodId),
    ]);
    if (speed && !method.deliverySpeeds.includes(speed)) {
      throw new BadRequestException(
        'Velocidade indisponível para este método.',
      );
    }
    const rule = await this.repository.getFeeRule(method.methodKey);
    const koopfyFeeMinor = calculateKoopfyFee(grossMinor, rule);
    if (koopfyFeeMinor >= grossMinor) {
      throw new BadRequestException(
        'O valor informado não cobre as taxas mínimas deste método.',
      );
    }
    const payoutMinor = providerPayoutMinor(grossMinor, koopfyFeeMinor);
    const selectedSpeed = normalizeSpeed(speed);
    const [quote, savedMethods] = await Promise.all([
      this.whop.createQuote(
        {
          accountId: account.providerAccountId,
          amount: payoutMinor / 100,
          currency: 'usd',
          payoutMethodId: method.providerMethodId,
          speed: selectedSpeed,
          platformCoversFees: false,
        },
        quoteIdempotencyKey,
      ),
      this.whop.listSavedPayoutMethods(account.providerAccountId),
    ]);
    return {
      account,
      method,
      quote,
      koopfyFeeMinor,
      providerPayoutMinor: payoutMinor,
      snapshot: quoteSnapshot(
        quote,
        payoutMinor,
        savedMethodEta(savedMethods, method.providerMethodId, selectedSpeed),
      ),
    };
  }

  private async readyAccount(sellerId: string) {
    const readiness = await this.accounts.getReadiness(sellerId);
    if (readiness.status !== 'ready' || !readiness.payoutsEnabled) {
      throw new ConflictException('A conta de saque ainda não está pronta.');
    }
    const account = await this.accounts.ensureConnectedAccount(sellerId);
    if (!account.providerAccountId) {
      throw new ConflictException(
        'A conta de saque ainda está sendo preparada.',
      );
    }
    return account as typeof account & { providerAccountId: string };
  }
}

function quoteSnapshot(
  quote: WhopPayoutQuote,
  expectedPayoutMinor: number,
  estimatedArrival: string | null = null,
) {
  const amountMinor = moneyToMinor(quote.amount);
  const providerFeeMinor = moneyToMinor(quote.fee);
  const netMinor = moneyToMinor(quote.netAmount);
  const destinationAmountMinor = moneyToMinor(quote.destinationAmount);
  if (
    quote.amount.currency !== 'usd' ||
    quote.fee.currency !== 'usd' ||
    quote.netAmount.currency !== 'usd' ||
    amountMinor !== expectedPayoutMinor ||
    providerFeeMinor < 0 ||
    netMinor < 0 ||
    netMinor > expectedPayoutMinor
  ) {
    throw new ServiceUnavailableException(
      'O provedor retornou uma cotação inconsistente.',
    );
  }
  return {
    providerFeeMinor,
    netMinor,
    destinationCurrency: quote.destinationAmount.currency.toUpperCase(),
    destinationAmountMinor,
    exchangeRate: quote.exchangeRate || null,
    estimatedArrival: quote.estimatedArrival ?? estimatedArrival,
  };
}

function savedMethodEta(
  methods: Array<{
    id: string;
    estimatedArrival: {
      standard: string | null;
      instant: string | null;
    } | null;
  }>,
  providerMethodId: string,
  speed: 'standard' | 'instant',
): string | null {
  return (
    methods.find((method) => method.id === providerMethodId)
      ?.estimatedArrival?.[speed] ?? null
  );
}

function moneyToMinor(money: WhopMoney): number {
  if (
    !Number.isInteger(money.decimals) ||
    money.decimals < 0 ||
    money.decimals > 18
  ) {
    throw new ServiceUnavailableException(
      'O provedor retornou uma cotação inválida.',
    );
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(money.amount);
  if (!match) {
    throw new ServiceUnavailableException(
      'O provedor retornou uma cotação inválida.',
    );
  }
  const fraction = (match[2] ?? '').padEnd(money.decimals, '0');
  if (fraction.length > money.decimals) {
    throw new ServiceUnavailableException(
      'O provedor retornou precisão inesperada.',
    );
  }
  const minor =
    BigInt(match[1]) * 10n ** BigInt(money.decimals) + BigInt(fraction || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ServiceUnavailableException(
      'O valor cotado excede o limite suportado.',
    );
  }
  return Number(minor);
}

function assertPreviewInput(input: {
  methodId: string;
  speed?: string | null;
  grossMinor: number;
}) {
  if (typeof input.methodId !== 'string' || input.methodId.length < 8) {
    throw new BadRequestException('Método de saque inválido.');
  }
  assertMinor(input.grossMinor);
  if (input.speed != null && !['standard', 'instant'].includes(input.speed)) {
    throw new BadRequestException('Velocidade de saque inválida.');
  }
}

function assertConfirmationInput(
  input: ConfirmPayoutRequest,
  idempotencyKey: string,
) {
  assertPreviewInput(input);
  assertMinor(input.confirmedMinimumNetMinor);
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey ?? '')) {
    throw new BadRequestException('Idempotency-Key inválido.');
  }
  if (
    typeof input.previewExpiresAt !== 'string' ||
    Number.isNaN(Date.parse(input.previewExpiresAt)) ||
    typeof input.confirmationToken !== 'string' ||
    input.confirmationToken.length < 32
  ) {
    throw new BadRequestException('Confirmação de cotação inválida.');
  }
}

function assertMinor(value: number, allowZero = false) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new BadRequestException('Valor do saque inválido.');
  }
}

function normalizeSpeed(
  value: string | null | undefined,
): 'standard' | 'instant' {
  return value === 'instant' ? 'instant' : 'standard';
}

function confirmationHash(
  sellerId: string,
  input: ConfirmPayoutRequest,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sellerId,
        methodId: input.methodId,
        speed: input.speed,
        grossMinor: input.grossMinor,
        confirmedMinimumNetMinor: input.confirmedMinimumNetMinor,
        previewExpiresAt: input.previewExpiresAt,
      }),
    )
    .digest('hex');
}

function randomQuoteKey(): string {
  return `koopfy_quote_${randomUUID().replace(/-/g, '')}`;
}

function quoteKey(scope: string, owner: string, key: string): string {
  return `koopfy_${scope}_${createHash('sha256')
    .update(`${owner}:${key}`)
    .digest('hex')
    .slice(0, 40)}`;
}

function previewSecret(): string {
  return process.env.PAYOUT_PREVIEW_HMAC_SECRET ?? '';
}

function parseReservationResult(
  value: any,
  replayedFallback: boolean,
): PayoutReservationResult {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row?.payoutId || typeof row.payoutId !== 'string') {
    throw new InternalServerErrorException(
      'Não foi possível confirmar o saque.',
    );
  }
  return {
    payoutId: row.payoutId,
    status: String(row.status ?? 'pending_review'),
    replayed:
      typeof row.replayed === 'boolean' ? row.replayed : replayedFallback,
  };
}

function mapRpcError(error: { code?: string; message?: string }) {
  if (['KP402', 'KP403', 'KP404'].includes(error.code ?? '')) {
    return new BadRequestException(safeRpcMessage(error.code));
  }
  if (error.code === 'KP409') {
    return new ConflictException(safeRpcMessage(error.code));
  }
  if (error.code === 'KP425') {
    return new ServiceUnavailableException(safeRpcMessage(error.code));
  }
  if (error.code === 'PGRST202' || error.code === '42883') {
    return storageUnavailable();
  }
  if (error.code === 'KP500') {
    return new InternalServerErrorException(
      'Não foi possível confirmar o saque.',
    );
  }
  return new BadRequestException('Não foi possível processar o saque.');
}

function safeRpcMessage(code?: string): string {
  const messages: Record<string, string> = {
    KP402: 'Saldo disponível insuficiente.',
    KP403: 'Método de saque inválido para esta conta.',
    KP404: 'Conta ou saque não encontrado.',
    KP409: 'O saque não pode ser alterado neste estado.',
    KP425: 'Um saque com esta chave ainda está em processamento.',
  };
  return messages[code ?? ''] ?? 'Não foi possível processar o saque.';
}

function mapDispatchExecution(row: any): DispatchExecution {
  return {
    id: String(row.id),
    ledgerEntryId: String(row.ledger_entry_id),
    sellerId: String(row.seller_id),
    localMethodId: String(row.seller_payout_method_id),
    providerAccountId: String(row.provider_account_id),
    providerPayoutId:
      typeof row.provider_payout_id === 'string'
        ? row.provider_payout_id
        : null,
    providerIdempotencyKey: String(row.provider_idempotency_key),
    methodKey: row.method_key as PayoutMethodKey,
    speed: typeof row.delivery_speed === 'string' ? row.delivery_speed : null,
    sourceCurrency: String(row.source_currency),
    destinationCurrency: String(row.destination_currency),
    grossMinor: Number(row.gross_minor),
    koopfyFeeMinor: Number(row.koopfy_fee_minor),
    providerFeeMinor: Number(row.provider_fee_minor),
    providerPayoutMinor: Number(row.provider_payout_minor),
    netMinor: Number(row.net_minor),
    destinationAmountMinor: Number(row.destination_amount_minor),
    confirmedMinimumNetMinor: Number(row.confirmed_minimum_net_minor),
    exchangeRate:
      row.exchange_rate === null || row.exchange_rate === undefined
        ? null
        : String(row.exchange_rate),
    estimatedArrival:
      typeof row.estimated_arrival === 'string'
        ? row.estimated_arrival
        : null,
    acceptedAt:
      typeof row.accepted_at === 'string' ? row.accepted_at : null,
    claimedAt:
      typeof row.claimed_at === 'string' ? row.claimed_at : null,
    attemptToken:
      typeof row.dispatch_attempt_token === 'string'
        ? row.dispatch_attempt_token
        : null,
    providerCreateStartedAt:
      typeof row.provider_create_started_at === 'string'
        ? row.provider_create_started_at
        : null,
    providerCreateResolvedAt:
      typeof row.provider_create_resolved_at === 'string'
        ? row.provider_create_resolved_at
        : null,
    localState: String(row.local_state),
  };
}

function mapFeeRule(row: any) {
  return {
    methodKey: row.method_key as PayoutMethodKey,
    percentageBps: Number(row.percentage_bps),
    fixedUsdCents: Number(row.fixed_fee_usd_cents),
    enabled: Boolean(row.enabled),
    effectiveAt: String(row.effective_at),
    updatedBy: typeof row.updated_by === 'string' ? row.updated_by : null,
    updatedAt: String(row.updated_at),
  };
}

function assertAdminContext(admin: PayoutAdminContext) {
  if (admin.role !== 'admin' || !admin.managerId?.trim()) {
    throw new ConflictException('Aprovação de saque restrita ao administrador.');
  }
}

function assertDispatchEnabled() {
  if (process.env.KOOPFY_WHOP_MASTER_PAYOUTS_ENABLED !== 'true') {
    throw new ConflictException(
      'Despacho automático de saques temporariamente indisponível.',
    );
  }
}

function dispatchFailure(error: unknown): {
  state: 'dispatching' | 'dispatch_failed';
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof WhopPayoutApiError) {
    const retryable = error.idempotencyReplay || error.retryable;
    return {
      state: retryable ? 'dispatching' : 'dispatch_failed',
      code: error.code,
      message: error.message,
      retryable,
    };
  }
  if (
    error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof NotFoundException
  ) {
    return {
      state: 'dispatch_failed',
      code: 'payout_preflight_failed',
      message: 'A conta ou o método de saque precisa ser revisado.',
      retryable: false,
    };
  }
  return {
    state: 'dispatching',
    code: 'dispatch_interrupted',
    message: 'O despacho será reconciliado antes de uma nova tentativa.',
    retryable: true,
  };
}

function requiredAttemptToken(execution: DispatchExecution): string {
  if (!execution.attemptToken) {
    throw new ConflictException('Tentativa de despacho sem token de controle.');
  }
  return execution.attemptToken;
}

function isDefinitiveProviderRejection(error: unknown): boolean {
  return (
    error instanceof WhopPayoutApiError &&
    !error.idempotencyReplay &&
    !error.retryable &&
    [400, 401, 403, 404, 422].includes(error.status)
  );
}

function isKnownPreRequestFailure(error: unknown): boolean {
  return (
    error instanceof WhopPayoutApiError && !error.requestMayHaveSucceeded
  );
}

function assertRecoveredPayoutOwnership(
  execution: DispatchExecution,
  payout: WhopPayout,
) {
  const metadata = payout.metadata;
  const amountMinor = moneyToMinor({
    amount: payout.amount,
    currency: payout.currency,
    decimals: 2,
    displayDecimals: 2,
  });
  if (
    payout.id.length === 0 ||
    metadata?.koopfy_payout_id !== execution.id ||
    metadata?.koopfy_seller_id !== execution.sellerId ||
    metadata?.koopfy_account_id !== execution.providerAccountId ||
    payout.currency.toUpperCase() !== execution.sourceCurrency ||
    amountMinor !== execution.providerPayoutMinor
  ) {
    throw new ConflictException(
      'O payout informado não pertence a esta tentativa de saque.',
    );
  }
}

function assertProviderPayoutFinancials(
  execution: DispatchExecution,
  payout: WhopPayout,
) {
  const amountMinor = moneyToMinor({
    amount: payout.amount,
    currency: payout.currency,
    decimals: 2,
    displayDecimals: 2,
  });
  if (
    payout.currency.toUpperCase() !== execution.sourceCurrency ||
    amountMinor !== execution.providerPayoutMinor
  ) {
    throw new ConflictException(
      'O payout do provider possui valor ou moeda divergente.',
    );
  }
}

function reconciliationStaleBefore(): string {
  const configured = Number(process.env.PAYOUT_RECONCILE_STALE_MS);
  const staleMs =
    Number.isInteger(configured) && configured >= 10_000
      ? configured
      : 5 * 60 * 1000;
  return new Date(Date.now() - staleMs).toISOString();
}

function storageUnavailable() {
  return new ServiceUnavailableException(
    'Solicitação de saque temporariamente indisponível.',
  );
}
