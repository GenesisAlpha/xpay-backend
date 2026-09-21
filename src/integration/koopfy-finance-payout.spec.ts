import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';

const feesRow = jest.fn();

jest.mock('../lib/supabase.client', () => ({
  supabase: {
    rpc: jest.fn(),
    // Tarifa do seller lida por quotePayout (seller_fees).
    from: () => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(feesRow()),
      };
      return chain;
    },
  },
}));

import { supabase } from '../lib/supabase.client';
import {
  payoutRequestHash,
  WalletService,
} from '../dashboard/services/services';
import { SellerCtx } from './cross-service-jwt.guard';
import { KoopfyFinanceController } from './koopfy-finance.controller';
import { KoopfyFinanceService } from './koopfy-finance.service';

const rpc = supabase.rpc as unknown as jest.Mock;
const KEY = 'payout_0123456789abcdef';

const achPayout = {
  amount: 250,
  method: 'ach',
  accountHolder: 'Jane Doe',
  achRoutingNumber: '021000021',
  achAccountNumber: '12345678',
  achAccountType: 'checking',
};

const activeContext: SellerCtx = {
  userId: 'user-1',
  email: 'seller@example.com',
  seller: { id: 'seller-1', status: 'active', kyc_status: 'approved' },
};

describe('WalletService.requestPayoutIdempotent', () => {
  beforeEach(() => {
    rpc.mockReset();
    feesRow.mockReset();
    feesRow.mockReturnValue({ data: null, error: null });
  });

  it('creates payouts only through the idempotent wrapper', async () => {
    rpc.mockResolvedValue({
      data: { payoutId: 'po-1', status: 'processing', replayed: false },
      error: null,
    });

    await expect(
      new WalletService().requestPayoutIdempotent('seller-1', achPayout as never, KEY),
    ).resolves.toEqual({ payoutId: 'po-1', status: 'processing', replayed: false });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('request_payout_idempotent', {
      p_seller_id: 'seller-1',
      p_idempotency_key: KEY,
      p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_amount_cents: 25000,
      p_method: 'ach',
      p_destination: {
        achRoutingNumber: '021000021',
        achAccountNumber: '12345678',
        achAccountType: 'checking',
        accountHolder: 'Jane Doe',
      },
      p_fee_cents: 0,
      p_fx_fee_cents: 0,
      p_payout_currency: 'USD',
      p_fee_details: { payout_fee_pct: 0, payout_fee_fixed_usd: 0, payout_fx_fee_pct: 0 },
    });
  });

  it('charges the seller payout fees and spread for Pix in BRL', async () => {
    feesRow.mockReturnValue({
      data: {
        seller_id: 'seller-1',
        processing_fee_pct: 8.9,
        payout_min_usd: 100,
        payout_fee_pct: 1,
        payout_fee_fixed_usd: 2,
        payout_fx_fee_pct: 2,
      },
      error: null,
    });
    rpc.mockResolvedValue({
      data: { payoutId: 'po-2', status: 'processing', replayed: false },
      error: null,
    });

    await new WalletService().requestPayoutIdempotent(
      'seller-1',
      { amount: 500, method: 'pix', accountHolder: 'Jane Doe', pixKey: 'jane@example.com', pixKeyType: 'email' } as never,
      KEY,
    );

    expect(rpc).toHaveBeenCalledWith(
      'request_payout_idempotent',
      expect.objectContaining({
        p_amount_cents: 50000,
        p_fee_cents: 700,
        p_fx_fee_cents: 986,
        p_payout_currency: 'BRL',
        p_fee_details: { payout_fee_pct: 1, payout_fee_fixed_usd: 2, payout_fx_fee_pct: 2 },
      }),
    );
  });

  it('applies the per-seller minimum', async () => {
    feesRow.mockReturnValue({
      data: { seller_id: 'seller-1', processing_fee_pct: 8.9, payout_min_usd: 300 },
      error: null,
    });

    await expect(
      new WalletService().requestPayoutIdempotent('seller-1', achPayout as never, KEY),
    ).rejects.toThrow('US$ 300.00');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns the original payout when the key is replayed', async () => {
    rpc.mockResolvedValue({
      data: { payoutId: 'po-1', status: 'processing', replayed: true },
      error: null,
    });

    await expect(
      new WalletService().requestPayoutIdempotent('seller-1', achPayout as never, KEY),
    ).resolves.toMatchObject({ payoutId: 'po-1', replayed: true });
  });

  it('maps a key reused with a different request to 409', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'KP409', message: 'Esta chave de idempotência já foi usada em outro saque.' },
    });

    await expect(
      new WalletService().requestPayoutIdempotent('seller-1', achPayout as never, KEY),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('fails closed when the idempotent function is not deployed', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    });

    await expect(
      new WalletService().requestPayoutIdempotent('seller-1', achPayout as never, KEY),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(rpc).not.toHaveBeenCalledWith('request_payout', expect.anything());
  });

  it('rejects a malformed key before touching the database', async () => {
    await expect(
      new WalletService().requestPayoutIdempotent('seller-1', achPayout as never, 'short'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('enforces amount and method rules without a validation pipe', async () => {
    const service = new WalletService();

    await expect(
      service.requestPayoutIdempotent('seller-1', { ...achPayout, amount: 50 } as never, KEY),
    ).rejects.toThrow('valor mínimo');
    await expect(
      service.requestPayoutIdempotent('seller-1', { ...achPayout, amount: '250' } as never, KEY),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.requestPayoutIdempotent('seller-1', { ...achPayout, amount: 250.005 } as never, KEY),
    ).rejects.toThrow('duas casas decimais');
    await expect(
      service.requestPayoutIdempotent('seller-1', { ...achPayout, method: 'boleto' } as never, KEY),
    ).rejects.toThrow('Método de saque inválido');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('payoutRequestHash', () => {
  it('ignores destination key order and changes with the amount', () => {
    const a = payoutRequestHash(25000, 'crypto', { cryptoAddress: 'T123', cryptoNetwork: 'TRC20' });
    const b = payoutRequestHash(25000, 'crypto', { cryptoNetwork: 'TRC20', cryptoAddress: 'T123' });
    const c = payoutRequestHash(25100, 'crypto', { cryptoAddress: 'T123', cryptoNetwork: 'TRC20' });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('KoopfyFinanceService.requestPayout', () => {
  const previousFlag = process.env.KOOPFY_UNIFIED_PAYOUTS_ENABLED;

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.KOOPFY_UNIFIED_PAYOUTS_ENABLED;
    else process.env.KOOPFY_UNIFIED_PAYOUTS_ENABLED = previousFlag;
  });

  function createService() {
    const wallet = { requestPayoutIdempotent: jest.fn() };
    const none = {} as never;
    const service = new KoopfyFinanceService(
      none,
      none,
      wallet as never,
      none,
      none,
      none,
      none,
      none,
    );
    return { service, wallet };
  }

  it('stays disabled without the rollout flag', async () => {
    delete process.env.KOOPFY_UNIFIED_PAYOUTS_ENABLED;
    const { service, wallet } = createService();

    await expect(
      service.requestPayout(activeContext, achPayout, KEY),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.requestPayoutIdempotent).not.toHaveBeenCalled();
  });

  it('uses the verified seller and drops identity fields from the body', async () => {
    process.env.KOOPFY_UNIFIED_PAYOUTS_ENABLED = 'true';
    const { service, wallet } = createService();
    wallet.requestPayoutIdempotent.mockResolvedValue({
      payoutId: 'po-1',
      status: 'processing',
      replayed: false,
      internal: 'must-not-leak',
    });

    await expect(
      service.requestPayout(
        activeContext,
        { ...achPayout, sellerId: 'attacker-seller', availableBalance: 999999 },
        KEY,
      ),
    ).resolves.toEqual({ payoutId: 'po-1', status: 'processing', replayed: false });

    expect(wallet.requestPayoutIdempotent).toHaveBeenCalledWith('seller-1', achPayout, KEY);
  });

  it('rejects accounts that are not active', async () => {
    process.env.KOOPFY_UNIFIED_PAYOUTS_ENABLED = 'true';
    const { service, wallet } = createService();
    const pending = {
      ...activeContext,
      seller: { ...activeContext.seller!, status: 'pending_review' },
    };

    await expect(
      service.requestPayout(pending, achPayout, KEY),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.requestPayoutIdempotent).not.toHaveBeenCalled();
  });
});

describe('KoopfyFinanceController.requestPayout', () => {
  it('forwards the Idempotency-Key header with the verified seller context', async () => {
    const finance = {
      requestPayout: jest.fn().mockResolvedValue({ payoutId: 'po-1' }),
    };
    const controller = new KoopfyFinanceController(finance as never);
    const req = { sellerCtx: activeContext };

    await controller.requestPayout(req, KEY, achPayout);

    expect(finance.requestPayout).toHaveBeenCalledWith(activeContext, achPayout, KEY);
  });
});

describe('KoopfyFinanceService payout account onboarding', () => {
  function createService() {
    const payouts = {
      getReadiness: jest.fn(),
      startVerification: jest.fn(),
      syncReadiness: jest.fn(),
      listSupportedMethods: jest.fn(),
      listSavedMethods: jest.fn(),
      createSavedMethod: jest.fn(),
      removeSavedMethod: jest.fn(),
    };
    const none = {} as never;
    return {
      payouts,
      service: new KoopfyFinanceService(
        none,
        none,
        none,
        none,
        none,
        none,
        none,
        none,
        payouts as never,
      ),
    };
  }

  it('uses the verified seller for readiness and verification', async () => {
    const { service, payouts } = createService();
    payouts.getReadiness.mockResolvedValue({ status: 'ready' });
    payouts.startVerification.mockResolvedValue({ status: 'under_review' });

    await expect(service.getPayoutAccount(activeContext)).resolves.toEqual({
      status: 'ready',
    });
    await service.startPayoutVerification(activeContext, {
      returnUrl: 'https://app.koopfy.com/finance',
    });

    expect(payouts.getReadiness).toHaveBeenCalledWith('seller-1');
    expect(payouts.startVerification).toHaveBeenCalledWith(
      'seller-1',
      'https://app.koopfy.com/finance',
    );
  });

  it('allowlists method creation fields before the payout service', async () => {
    const { service, payouts } = createService();
    payouts.createSavedMethod.mockResolvedValue({ id: 'local-method-1' });

    await service.createPayoutMethod(activeContext, {
      supportedMethodId: 'podst_1',
      destinationCurrency: 'usd',
      fields: {
        fld_bank_account_number: '123456789',
        injectedObject: { provider_account_id: 'biz_attacker' },
      },
      nickname: 'Principal',
      isDefault: true,
      sellerId: 'attacker',
      providerMethodId: 'potk_attacker',
    } as never);

    expect(payouts.createSavedMethod).toHaveBeenCalledWith('seller-1', {
      supportedMethodId: 'podst_1',
      destinationCurrency: 'usd',
      fields: { fld_bank_account_number: '123456789' },
      nickname: 'Principal',
      isDefault: true,
    });
  });
});
