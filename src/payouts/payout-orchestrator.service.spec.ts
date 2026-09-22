jest.mock('../lib/supabase.client', () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));

import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { supabase } from '../lib/supabase.client';
import { signPreviewConfirmation } from './payout-domain';
import {
  PayoutExecutionRepository,
  PayoutOrchestratorService,
} from './payout-orchestrator.service';
import { WhopPayoutApiError } from './whop-payout.client';

describe('PayoutOrchestratorService', () => {
  const originalEnv = { ...process.env };
  const secret = 'preview-secret-at-least-thirty-two-bytes-long';
  let accounts: Record<string, jest.Mock>;
  let whop: Record<string, jest.Mock>;
  let repository: Record<string, jest.Mock>;
  let service: PayoutOrchestratorService;

  const method = {
    id: 'local-method-1',
    sellerId: 'seller-1',
    providerMethodId: 'potk_secret',
    providerSupportedMethodId: 'podst_secret',
    methodKey: 'pix',
    deliverySpeeds: ['standard'],
    network: null,
    destinationCountry: 'BR',
    currency: 'BRL',
    nickname: 'Pix principal',
    institutionName: null,
    maskedReference: '•••1234',
    status: 'active',
    isDefault: true,
  };

  const quote = (net = '108.10', fee = '6.40') => ({
    id: 'pout_1',
    amount: {
      amount: '114.50',
      currency: 'usd',
      decimals: 2,
      displayDecimals: 2,
    },
    fee: {
      amount: fee,
      currency: 'usd',
      decimals: 2,
      displayDecimals: 2,
    },
    netAmount: {
      amount: net,
      currency: 'usd',
      decimals: 2,
      displayDecimals: 2,
    },
    destinationAmount: {
      amount: '621.15',
      currency: 'brl',
      decimals: 2,
      displayDecimals: 2,
    },
    exchangeRate: '5.74607',
    estimatedArrival: '2026-09-23T12:00:00.000Z',
    expiresAt: '2026-09-21T15:05:00.000Z',
    quoteToken: 'quote_secret',
  });

  const execution = (overrides: Record<string, unknown> = {}) => ({
    id: 'payout-1',
    ledgerEntryId: 'ledger-1',
    sellerId: 'seller-1',
    localMethodId: 'local-method-1',
    providerAccountId: 'biz_secret',
    providerPayoutId: null,
    providerIdempotencyKey: 'koopfy_payout_abc',
    methodKey: 'pix',
    speed: 'standard',
    sourceCurrency: 'USD',
    providerPayoutMinor: 11_450,
    confirmedMinimumNetMinor: 10_800,
    localState: 'dispatching',
    acceptedAt: null,
    claimedAt: '2026-09-21T15:00:00.000Z',
    attemptToken: '00000000-0000-4000-8000-000000000111',
    providerCreateStartedAt: null,
    providerCreateResolvedAt: null,
    ...overrides,
  });

  const providerPayout = (overrides: Record<string, unknown> = {}) => ({
    id: 'wdrl_1',
    status: 'processing',
    amount: '114.50',
    currency: 'usd',
    feeAmount: '6.40',
    markupFee: '0.00',
    netAmount: '108.10',
    destinationAmount: '621.15',
    destinationCurrency: 'brl',
    exchangeRate: '5.74607',
    estimatedArrival: '2026-09-23T12:00:00.000Z',
    createdAt: '2026-09-21T15:00:00.000Z',
    metadata: {
      koopfy_payout_id: 'payout-1',
      koopfy_seller_id: 'seller-1',
      koopfy_account_id: 'biz_secret',
    },
    failure: null,
    ...overrides,
  });

  const providerFailure = (status: number | 'timeout') =>
    new WhopPayoutApiError(
      status === 'timeout' ? 0 : status,
      status === 409
        ? 'idempotency_conflict'
        : status === 401
          ? 'authentication_failed'
          : status === 403
            ? 'permission_denied'
            : status === 422
              ? 'provider_validation_failed'
              : 'provider_unavailable',
      status === 'timeout' || status === 500,
      status === 409,
      null,
      true,
    );

  beforeEach(() => {
    process.env.PAYOUT_PREVIEW_HMAC_SECRET = secret;
    process.env.KOOPFY_WHOP_MASTER_PAYOUTS_ENABLED = 'true';
    accounts = {
      getReadiness: jest.fn().mockResolvedValue({
        status: 'ready',
        payoutsEnabled: true,
        methods: [],
      }),
      ensureConnectedAccount: jest.fn().mockResolvedValue({
        sellerId: 'seller-1',
        providerAccountId: 'biz_secret',
        status: 'ready',
        payoutsEnabled: true,
      }),
      assertOwnedActiveMethod: jest.fn().mockResolvedValue(method),
    };
    whop = {
      getMasterAccountId: jest.fn().mockReturnValue('biz_master'),
      createQuote: jest.fn().mockResolvedValue(quote()),
      listSavedPayoutMethods: jest.fn().mockResolvedValue([
        {
          id: 'potk_secret',
          estimatedArrival: {
            standard: '2026-09-23T12:00:00.000Z',
            instant: null,
          },
        },
      ]),
      createPayout: jest.fn(),
      retrievePayout: jest.fn(),
    };
    repository = {
      getFeeRule: jest.fn().mockResolvedValue({
        percentageBps: 200,
        fixedUsdCents: 300,
      }),
      findRequestReplay: jest.fn().mockResolvedValue(null),
      reserve: jest.fn().mockResolvedValue({
        payoutId: 'payout-1',
        status: 'pending_review',
        replayed: false,
      }),
      getRequoteExecution: jest.fn(),
      requeueRequoted: jest.fn(),
      claimDispatch: jest.fn().mockResolvedValue(execution()),
      markRequoteRequired: jest.fn().mockResolvedValue({
        state: 'requote_required',
      }),
      updateDispatchState: jest.fn().mockResolvedValue(true),
      recordProviderPayoutId: jest.fn().mockResolvedValue(undefined),
      persistApprovalQuote: jest.fn().mockResolvedValue(undefined),
      markProviderCreateStarted: jest.fn().mockResolvedValue(true),
      resolveProviderCreateFailure: jest.fn().mockResolvedValue({
        state: 'dispatch_failed',
      }),
      recordUncertainCreate: jest.fn().mockResolvedValue(true),
      attachRecoveredProviderPayout: jest.fn().mockResolvedValue({
        state: 'processing',
      }),
      finalizeAccepted: jest.fn().mockResolvedValue({
        state: 'processing',
      }),
      releaseReservation: jest.fn(),
      findByReference: jest.fn(),
      claimReconciliation: jest.fn(),
      applyProviderState: jest.fn().mockResolvedValue({ state: 'processing' }),
      restoreProviderFunds: jest.fn(),
    };
    service = new PayoutOrchestratorService(
      accounts as never,
      whop as never,
      repository as never,
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('previews consolidated fees without reserving funds or creating a payout', async () => {
    const preview = await service.preview('seller-1', {
      methodId: 'local-method-1',
      speed: 'standard',
      grossMinor: 11_990,
    });

    expect(whop.createQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'biz_secret',
        payoutMethodId: 'potk_secret',
        amount: 114.5,
        currency: 'usd',
        platformCoversFees: false,
      }),
      expect.any(String),
    );
    expect(preview).toMatchObject({
      methodId: 'local-method-1',
      methodKey: 'pix',
      grossMinor: 11_990,
      consolidatedFeeMinor: 1_180,
      netMinor: 10_810,
      confirmedMinimumNetMinor: 10_810,
      destinationCurrency: 'BRL',
      destinationAmountMinor: 62_115,
      exchangeRate: '5.74607',
    });
    expect(preview.confirmationToken).toEqual(expect.any(String));
    expect(JSON.stringify(preview)).not.toContain('quote_secret');
    expect(JSON.stringify(preview)).not.toContain('biz_secret');
    expect(JSON.stringify(preview)).not.toContain('potk_secret');
    expect(repository.reserve).not.toHaveBeenCalled();
    expect(whop.createPayout).not.toHaveBeenCalled();
  });

  it('fails closed when provider fee and net do not equal the payout amount', async () => {
    whop.createQuote.mockResolvedValue(quote('108.09', '6.40'));

    await expect(
      service.preview('seller-1', {
        methodId: 'local-method-1',
        speed: 'standard',
        grossMinor: 11_990,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(repository.reserve).not.toHaveBeenCalled();
    expect(whop.createPayout).not.toHaveBeenCalled();
  });

  it('rejects confirmation when the fresh net is below the shown minimum', async () => {
    whop.createQuote.mockResolvedValue(quote('107.00', '7.50'));
    const fields = {
      methodId: 'local-method-1',
      speed: 'standard',
      grossMinor: 11_990,
      confirmedMinimumNetMinor: 10_800,
      previewExpiresAt: '2026-09-21T15:00:00.000Z',
    };
    const token = signPreviewConfirmation(fields, 'seller-1', secret);

    await expect(
      service.confirm(
        'seller-1',
        { ...fields, confirmationToken: token },
        'payout_request_12345678',
        new Date('2026-09-21T14:59:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repository.reserve).not.toHaveBeenCalled();
    expect(whop.createPayout).not.toHaveBeenCalled();
  });

  it('reserves the exact gross snapshot once and never submits the provider payout', async () => {
    const fields = {
      methodId: 'local-method-1',
      speed: 'standard',
      grossMinor: 11_990,
      confirmedMinimumNetMinor: 10_800,
      previewExpiresAt: '2026-09-21T15:00:00.000Z',
    };
    const token = signPreviewConfirmation(fields, 'seller-1', secret);

    await expect(
      service.confirm(
        'seller-1',
        { ...fields, confirmationToken: token },
        'payout_request_12345678',
        new Date('2026-09-21T14:59:00.000Z'),
      ),
    ).resolves.toEqual({
      payoutId: 'payout-1',
      status: 'pending_review',
      replayed: false,
    });

    expect(repository.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerId: 'seller-1',
        localMethodId: 'local-method-1',
        methodKey: 'pix',
        grossMinor: 11_990,
        koopfyFeeMinor: 540,
        providerPayoutMinor: 11_450,
        providerFeeMinor: 640,
        netMinor: 10_810,
        destinationAmountMinor: 62_115,
        confirmedMinimumNetMinor: 10_800,
      }),
    );
    expect(JSON.stringify(repository.reserve.mock.calls)).not.toContain(
      'quote_secret',
    );
    expect(whop.createPayout).not.toHaveBeenCalled();
  });

  it('rejects altered or expired preview proofs before external calls', async () => {
    const fields = {
      methodId: 'local-method-1',
      speed: 'standard',
      grossMinor: 11_990,
      confirmedMinimumNetMinor: 10_810,
      previewExpiresAt: '2026-09-21T15:00:00.000Z',
    };
    const token = signPreviewConfirmation(fields, 'seller-1', secret);

    await expect(
      service.confirm(
        'seller-1',
        { ...fields, grossMinor: 12_000, confirmationToken: token },
        'payout_request_12345678',
        new Date('2026-09-21T14:59:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.confirm(
        'seller-1',
        { ...fields, confirmationToken: token },
        'payout_request_12345678',
        new Date('2026-09-21T15:00:01.000Z'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(whop.createQuote).not.toHaveBeenCalled();
    expect(repository.reserve).not.toHaveBeenCalled();
  });

  it('returns an existing idempotent reservation even after the preview expires', async () => {
    repository.findRequestReplay.mockResolvedValue({
      payoutId: 'payout-existing',
      status: 'pending_review',
      replayed: true,
    });
    const fields = {
      methodId: 'local-method-1',
      speed: 'standard',
      grossMinor: 11_990,
      confirmedMinimumNetMinor: 10_810,
      previewExpiresAt: '2026-09-21T15:00:00.000Z',
    };

    await expect(
      service.confirm(
        'seller-1',
        {
          ...fields,
          confirmationToken: signPreviewConfirmation(
            fields,
            'seller-1',
            secret,
          ),
        },
        'payout_request_12345678',
        new Date('2026-09-21T15:05:00.000Z'),
      ),
    ).resolves.toMatchObject({ payoutId: 'payout-existing', replayed: true });
    expect(whop.createQuote).not.toHaveBeenCalled();
    expect(repository.reserve).not.toHaveBeenCalled();
  });

  it('requeues a requote only after the seller accepts a sufficient fresh net', async () => {
    repository.getRequoteExecution.mockResolvedValue({
      id: 'payout-1',
      sellerId: 'seller-1',
      localMethodId: 'local-method-1',
      methodKey: 'pix',
      speed: 'standard',
      sourceCurrency: 'USD',
      providerPayoutMinor: 11_450,
      localState: 'requote_required',
    });
    repository.requeueRequoted.mockResolvedValue({
      payoutId: 'payout-1',
      status: 'pending_review',
      replayed: false,
    });

    await expect(
      service.reconfirm(
        'seller-1',
        'payout-1',
        10_800,
        'payout_reconfirm_12345678',
      ),
    ).resolves.toMatchObject({
      payoutId: 'payout-1',
      status: 'pending_review',
    });

    expect(repository.requeueRequoted).toHaveBeenCalledWith(
      'payout-1',
      expect.objectContaining({
        providerFeeMinor: 640,
        netMinor: 10_810,
        confirmedMinimumNetMinor: 10_800,
      }),
    );
    expect(whop.createPayout).not.toHaveBeenCalled();
  });

  it('lets only one concurrent admin dispatch a payout', async () => {
    repository.claimDispatch
      .mockResolvedValueOnce(execution())
      .mockResolvedValueOnce(null);
    whop.createPayout.mockResolvedValue(providerPayout());

    const results = await Promise.allSettled([
      service.approveAndDispatch('payout-1', {
        managerId: 'admin-a',
        role: 'admin',
      }),
      service.approveAndDispatch('payout-1', {
        managerId: 'admin-b',
        role: 'admin',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(whop.createPayout).toHaveBeenCalledTimes(1);
    expect(repository.finalizeAccepted).toHaveBeenCalledTimes(1);
  });

  it('requires seller reconfirmation when the approval quote deteriorates', async () => {
    whop.createQuote.mockResolvedValue(quote('107.99', '6.51'));

    await expect(
      service.approveAndDispatch('payout-1', {
        managerId: 'admin-a',
        role: 'admin',
      }),
    ).resolves.toMatchObject({ state: 'requote_required' });

    expect(repository.markRequoteRequired).toHaveBeenCalledWith(
      'payout-1',
      expect.objectContaining({ netMinor: 10_799 }),
      '00000000-0000-4000-8000-000000000111',
    );
    expect(whop.createPayout).not.toHaveBeenCalled();
    expect(repository.releaseReservation).not.toHaveBeenCalled();
  });

  it('persists an acceptable refreshed quote before creating the payout', async () => {
    whop.createQuote.mockResolvedValue(quote('108.20', '6.30'));
    whop.createPayout.mockResolvedValue(providerPayout());

    await service.approveAndDispatch('payout-1', {
      managerId: 'admin-a',
      role: 'admin',
    });

    expect(repository.persistApprovalQuote).toHaveBeenCalledWith(
      'payout-1',
      expect.objectContaining({ providerFeeMinor: 630, netMinor: 10_820 }),
      '00000000-0000-4000-8000-000000000111',
    );
    expect(whop.createPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          koopfy_account_id: 'biz_secret',
          koopfy_master_account_id: 'biz_master',
        }),
      }),
      'koopfy_payout_abc',
    );
    expect(
      repository.persistApprovalQuote.mock.invocationCallOrder[0],
    ).toBeLessThan(whop.createPayout.mock.invocationCallOrder[0]);
  });

  it.each([
    [422, 'dispatch_failed', false],
    [401, 'dispatch_failed', false],
    [403, 'dispatch_failed', false],
    [500, 'dispatching', false],
    ['timeout', 'dispatching', false],
  ] as const)(
    'maps provider failure %s to %s without releasing funds',
    async (failure, expectedState, retryable) => {
      whop.createPayout.mockRejectedValue(providerFailure(failure));

      await expect(
        service.approveAndDispatch('payout-1', {
          managerId: 'admin-a',
          role: 'admin',
        }),
      ).resolves.toMatchObject({ state: expectedState, retryable });

      if (expectedState === 'dispatch_failed') {
        expect(repository.resolveProviderCreateFailure).toHaveBeenCalledWith(
          'payout-1',
          '00000000-0000-4000-8000-000000000111',
          expect.objectContaining({ retryable: false }),
        );
      } else {
        expect(repository.recordUncertainCreate).toHaveBeenCalledWith(
          'payout-1',
          '00000000-0000-4000-8000-000000000111',
          expect.objectContaining({ retryable: true }),
        );
      }
      expect(repository.releaseReservation).not.toHaveBeenCalled();
    },
  );

  it('resolves a known pre-request configuration failure without quarantining funds', async () => {
    whop.createPayout.mockRejectedValue(
      new WhopPayoutApiError(
        500,
        'master_account_not_configured',
        false,
        false,
        null,
        false,
      ),
    );

    await expect(
      service.approveAndDispatch('payout-1', {
        managerId: 'admin-a',
        role: 'admin',
      }),
    ).resolves.toMatchObject({ state: 'dispatch_failed', retryable: false });

    expect(repository.resolveProviderCreateFailure).toHaveBeenCalled();
    expect(repository.recordUncertainCreate).not.toHaveBeenCalled();
  });

  it('retrieves the original payout after an idempotency conflict', async () => {
    whop.createPayout.mockRejectedValue(
      new WhopPayoutApiError(
        409,
        'idempotency_conflict',
        false,
        true,
        'wdrl_original',
        true,
      ),
    );
    whop.retrievePayout.mockResolvedValue(
      providerPayout({ id: 'wdrl_original' }),
    );

    await expect(
      service.approveAndDispatch('payout-1', {
        managerId: 'admin-a',
        role: 'admin',
      }),
    ).resolves.toMatchObject({ state: 'processing' });

    expect(whop.retrievePayout).toHaveBeenCalledWith(
      'wdrl_original',
      'biz_secret',
    );
    expect(repository.finalizeAccepted).toHaveBeenCalledTimes(1);
  });

  it('does not bind an idempotency replay that belongs to another payout', async () => {
    whop.createPayout.mockRejectedValue(
      new WhopPayoutApiError(
        409,
        'idempotency_conflict',
        false,
        true,
        'wdrl_wrong',
        true,
      ),
    );
    whop.retrievePayout.mockResolvedValue(
      providerPayout({
        id: 'wdrl_wrong',
        metadata: {
          koopfy_payout_id: 'payout-other',
          koopfy_seller_id: 'seller-1',
          koopfy_account_id: 'biz_secret',
        },
      }),
    );

    await expect(
      service.approveAndDispatch('payout-1', {
        managerId: 'admin-a',
        role: 'admin',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repository.recordProviderPayoutId).not.toHaveBeenCalled();
    expect(repository.finalizeAccepted).not.toHaveBeenCalled();
  });

  it('does not persist a successful create response with divergent financials', async () => {
    whop.createPayout.mockResolvedValue(providerPayout({ amount: '999.00' }));

    await expect(
      service.approveAndDispatch('payout-1', {
        managerId: 'admin-a',
        role: 'admin',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repository.recordProviderPayoutId).not.toHaveBeenCalled();
    expect(repository.finalizeAccepted).not.toHaveBeenCalled();
  });

  it('does not let a stale worker create after losing its dispatch lease', async () => {
    repository.persistApprovalQuote.mockRejectedValueOnce(
      new ConflictException('lease replaced'),
    );
    repository.updateDispatchState.mockResolvedValueOnce(false);

    await expect(
      service.approveAndDispatch('payout-1', {
        managerId: 'admin-a',
        role: 'admin',
      }),
    ).resolves.toMatchObject({
      state: 'dispatching',
      retryable: false,
      superseded: true,
    });

    expect(repository.markProviderCreateStarted).not.toHaveBeenCalled();
    expect(whop.createPayout).not.toHaveBeenCalled();
  });

  it('keeps an unresolved idempotency conflict uncertain and non-cancelable', async () => {
    whop.createPayout.mockRejectedValue(providerFailure(409));

    await expect(
      service.approveAndDispatch('payout-1', {
        managerId: 'admin-a',
        role: 'admin',
      }),
    ).resolves.toMatchObject({
      state: 'dispatching',
      retryable: false,
      manualReconciliationRequired: true,
    });
    expect(repository.recordUncertainCreate).toHaveBeenCalledWith(
      'payout-1',
      '00000000-0000-4000-8000-000000000111',
      expect.objectContaining({ retryable: true }),
    );

    repository.findByReference.mockResolvedValue(
      execution({ providerPayoutId: null, localState: 'dispatching' }),
    );
    await expect(
      service.reject(
        'payout-1',
        { managerId: 'admin-a', role: 'admin' },
        'cancel',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.releaseReservation).not.toHaveBeenCalled();
  });

  it('persists provider acceptance before finalizing the local outflow', async () => {
    whop.createPayout.mockResolvedValue(providerPayout());
    repository.finalizeAccepted.mockRejectedValue(
      new Error('database unavailable'),
    );

    await expect(
      service.approveAndDispatch('payout-1', {
        managerId: 'admin-a',
        role: 'admin',
      }),
    ).rejects.toThrow('database unavailable');

    expect(repository.recordProviderPayoutId).toHaveBeenCalledWith(
      'payout-1',
      'wdrl_1',
      'processing',
      '00000000-0000-4000-8000-000000000111',
    );
  });

  it('keeps a lost provider id non-refundable until externally resolved', async () => {
    whop.createPayout.mockResolvedValueOnce(
      providerPayout({ id: 'wdrl_original' }),
    );
    repository.recordProviderPayoutId.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(
      service.approveAndDispatch('payout-1', {
        managerId: 'admin-a',
        role: 'admin',
      }),
    ).rejects.toThrow('database unavailable');

    const stale = execution({
      providerPayoutId: null,
      claimedAt: '2026-09-21T14:00:00.000Z',
      providerCreateStartedAt: '2026-09-21T14:00:01.000Z',
      providerCreateResolvedAt: null,
    });
    repository.findByReference.mockResolvedValue(stale);

    await expect(
      service.reconcileOne('payout-1', {
        managerId: 'admin-a',
        role: 'admin',
      }),
    ).resolves.toMatchObject({
      state: 'dispatching',
      manualReconciliationRequired: true,
    });

    expect(whop.createQuote).toHaveBeenCalledTimes(1);
    expect(whop.createPayout).toHaveBeenCalledTimes(1);
    await expect(
      service.reject(
        'payout-1',
        { managerId: 'admin-a', role: 'admin' },
        'cancel',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.releaseReservation).not.toHaveBeenCalled();
  });

  it('attaches a provider payout only after verifying its immutable ownership metadata', async () => {
    repository.findByReference.mockResolvedValue(
      execution({
        providerCreateStartedAt: '2026-09-21T14:00:01.000Z',
      }),
    );
    whop.retrievePayout.mockResolvedValue({
      id: 'wdrl_recovered',
      status: 'processing',
      amount: '114.50',
      currency: 'usd',
      metadata: {
        koopfy_payout_id: 'payout-1',
        koopfy_seller_id: 'seller-1',
        koopfy_account_id: 'biz_secret',
      },
    });

    await expect(
      service.attachProviderPayout(
        'payout-1',
        'wdrl_recovered',
        { managerId: 'admin-a', role: 'admin' },
        'Confirmed in Whop dashboard',
      ),
    ).resolves.toMatchObject({ state: 'processing' });

    expect(whop.retrievePayout).toHaveBeenCalledWith(
      'wdrl_recovered',
      'biz_secret',
    );
    expect(repository.attachRecoveredProviderPayout).toHaveBeenCalledWith(
      'payout-1',
      'wdrl_recovered',
      'processing',
      '00000000-0000-4000-8000-000000000111',
    );
  });

  it('refuses to attach a provider payout whose metadata belongs to another request', async () => {
    repository.findByReference.mockResolvedValue(
      execution({
        providerCreateStartedAt: '2026-09-21T14:00:01.000Z',
      }),
    );
    whop.retrievePayout.mockResolvedValue({
      id: 'wdrl_wrong',
      status: 'processing',
      amount: '114.50',
      currency: 'usd',
      metadata: {
        koopfy_payout_id: 'payout-other',
        koopfy_seller_id: 'seller-1',
        koopfy_account_id: 'biz_secret',
      },
    });

    await expect(
      service.attachProviderPayout(
        'payout-1',
        'wdrl_wrong',
        { managerId: 'admin-a', role: 'admin' },
        'Confirmed in Whop dashboard',
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repository.attachRecoveredProviderPayout).not.toHaveBeenCalled();
  });

  it('leases a stale dispatch so concurrent reconciliation creates once', async () => {
    const stale = execution({ claimedAt: '2026-09-21T14:00:00.000Z' });
    repository.findByReference.mockResolvedValue(stale);
    repository.claimReconciliation
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(null);
    whop.createPayout.mockResolvedValue(providerPayout());

    await Promise.allSettled([
      service.reconcileOne('payout-1', {
        managerId: 'admin-a',
        role: 'admin',
      }),
      service.reconcileOne('payout-1', {
        managerId: 'admin-b',
        role: 'admin',
      }),
    ]);

    expect(whop.createPayout).toHaveBeenCalledTimes(1);
  });
});

describe('PayoutExecutionRepository idempotency', () => {
  it('reports an unfinished request as temporarily unavailable instead of a quote conflict', async () => {
    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { request_hash: 'hash-1', response: null },
        error: null,
      }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    (supabase.from as jest.Mock).mockReturnValue(query);

    await expect(
      new PayoutExecutionRepository().findRequestReplay(
        'seller-1',
        'payout_request_12345678',
        'hash-1',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
