jest.mock('../lib/supabase.client', () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));

import { ConflictException } from '@nestjs/common';
import { signPreviewConfirmation } from './payout-domain';
import { PayoutOrchestratorService } from './payout-orchestrator.service';

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

  beforeEach(() => {
    process.env.PAYOUT_PREVIEW_HMAC_SECRET = secret;
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

  it('returns an existing idempotent reservation before requesting another quote', async () => {
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
        new Date('2026-09-21T14:59:00.000Z'),
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
});
