jest.mock('../lib/supabase.client', () => ({
  supabase: { from: jest.fn() },
}));

import { ConflictException, NotFoundException } from '@nestjs/common';
import { SellerPayoutAccountService } from './seller-payout-account.service';

describe('SellerPayoutAccountService', () => {
  let whop: Record<string, jest.Mock>;
  let repository: Record<string, jest.Mock>;
  let service: SellerPayoutAccountService;

  beforeEach(() => {
    whop = {
      createConnectedAccount: jest.fn(),
      createVerificationSession: jest.fn(),
      listVerifications: jest.fn(),
      listSupportedPayoutMethods: jest.fn(),
      listSavedPayoutMethods: jest.fn(),
      createSavedPayoutMethod: jest.fn(),
      deleteSavedPayoutMethod: jest.fn(),
    };
    repository = {
      getSeller: jest.fn().mockResolvedValue({
        id: 'seller-1',
        status: 'active',
        name: 'Creator One',
        email: 'seller@example.com',
        country: 'BR',
      }),
      getAccount: jest.fn().mockResolvedValue(null),
      claimProvisioning: jest.fn().mockResolvedValue(true),
      updateAccount: jest.fn().mockImplementation(async (_id, patch) => ({
        sellerId: 'seller-1',
        providerAccountId: patch.providerAccountId ?? null,
        status: patch.status,
        verificationStatus: patch.verificationStatus ?? null,
        payoutsEnabled: patch.payoutsEnabled ?? false,
        lastErrorCode: patch.lastErrorCode ?? null,
        lastErrorMessage: patch.lastErrorMessage ?? null,
        lastSyncedAt: patch.lastSyncedAt ?? null,
      })),
      listMethods: jest.fn().mockResolvedValue([]),
      getMethod: jest.fn(),
      upsertMethod: jest.fn().mockImplementation(async (value) => ({
        id: 'local-method-1',
        sellerId: value.sellerId,
        ...value,
      })),
      deactivateMethod: jest.fn(),
    };
    service = new SellerPayoutAccountService(
      whop as never,
      repository as never,
    );
  });

  it('provisions an active seller once and stores only the connected account id', async () => {
    whop.createConnectedAccount.mockResolvedValue({
      id: 'biz_seller',
      title: 'Creator One',
      identity: { tax_id: 'must-not-persist' },
    });

    const [first, second] = await Promise.all([
      service.ensureConnectedAccount('seller-1'),
      service.ensureConnectedAccount('seller-1'),
    ]);

    expect(first.providerAccountId).toBe('biz_seller');
    expect(second.providerAccountId).toBe('biz_seller');
    expect(whop.createConnectedAccount).toHaveBeenCalledTimes(1);
    expect(repository.updateAccount).toHaveBeenCalledWith(
      'seller-1',
      expect.objectContaining({
        providerAccountId: 'biz_seller',
        status: 'verification_required',
      }),
    );
    expect(JSON.stringify(repository.updateAccount.mock.calls)).not.toContain(
      'tax_id',
    );
    expect(JSON.stringify(repository.updateAccount.mock.calls)).not.toContain(
      'must-not-persist',
    );
  });

  it('forwards raw destination fields once and persists only masked provider output', async () => {
    repository.getAccount.mockResolvedValue({
      sellerId: 'seller-1',
      providerAccountId: 'biz_seller',
      status: 'ready',
      payoutsEnabled: true,
    });
    whop.createSavedPayoutMethod.mockResolvedValue({
      id: 'potk_1',
      accountReference: '•••6789',
      destinationCurrency: 'usd',
      nickname: 'Main account',
      isDefault: true,
      status: 'active',
      institutionName: 'Example Bank',
      supportedPayoutMethod: {
        name: 'ACH Standard',
        deliveryType: 'bank_deposit',
        supportsStandardDelivery: true,
        supportsInstantDelivery: false,
      },
    });

    const fields = {
      fld_bank_routing_number: '021000021',
      fld_bank_account_number: '123456789',
    };
    const result = await service.createSavedMethod('seller-1', {
      supportedMethodId: 'podst_1',
      destinationCurrency: 'usd',
      fields,
    });

    expect(whop.createSavedPayoutMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'biz_seller',
        supportedPayoutMethodId: 'podst_1',
        fields,
      }),
      expect.any(String),
    );
    expect(repository.upsertMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMethodId: 'potk_1',
        providerSupportedMethodId: 'podst_1',
        maskedReference: '•••6789',
        methodKey: 'ach_standard',
      }),
    );
    const persisted = JSON.stringify(repository.upsertMethod.mock.calls);
    expect(persisted).not.toContain('021000021');
    expect(persisted).not.toContain('123456789');
    expect(result).toEqual(
      expect.objectContaining({
        id: 'local-method-1',
        maskedReference: expect.stringMatching(/6789$/),
      }),
    );
    expect(JSON.stringify(result)).not.toContain('potk_1');
  });

  it('maps provider verification to public readiness without leaking provider ids', async () => {
    repository.getAccount.mockResolvedValue({
      sellerId: 'seller-1',
      providerAccountId: 'biz_seller',
      status: 'under_review',
      payoutsEnabled: false,
    });
    repository.listMethods.mockResolvedValue([
      {
        id: 'local-method-1',
        sellerId: 'seller-1',
        providerMethodId: 'potk_secret',
        providerSupportedMethodId: 'podst_secret',
        methodKey: 'pix',
        nickname: 'Pix principal',
        maskedReference: '•••1234',
        currency: 'BRL',
        destinationCountry: 'BR',
        network: null,
        deliverySpeeds: ['standard'],
        isDefault: true,
        status: 'active',
      },
    ]);
    whop.listVerifications.mockResolvedValue([
      {
        id: 'ver_secret',
        status: 'action_required',
        url: 'https://verify.whop.com/session/safe',
      },
    ]);
    whop.listSavedPayoutMethods.mockResolvedValue([]);

    const readiness = await service.syncReadiness('seller-1');

    expect(readiness).toMatchObject({
      status: 'verification_required',
      payoutsEnabled: false,
      verificationActionUrl: 'https://verify.whop.com/session/safe',
      methods: [
        expect.objectContaining({
          id: 'local-method-1',
          methodKey: 'pix',
          maskedReference: '•••1234',
        }),
      ],
    });
    expect(JSON.stringify(readiness)).not.toContain('biz_seller');
    expect(JSON.stringify(readiness)).not.toContain('potk_secret');
    expect(JSON.stringify(readiness)).not.toContain('podst_secret');
    expect(JSON.stringify(readiness)).not.toContain('ver_secret');
  });

  it('rejects a payout method owned by another seller', async () => {
    repository.getMethod.mockResolvedValue({
      id: 'local-method-1',
      sellerId: 'seller-2',
      status: 'active',
    });

    await expect(
      service.assertOwnedActiveMethod('seller-1', 'local-method-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects onboarding for an inactive seller before calling Whop', async () => {
    repository.getSeller.mockResolvedValue({
      id: 'seller-1',
      status: 'pending_review',
      email: 'seller@example.com',
      name: 'Creator One',
      country: 'BR',
    });

    await expect(
      service.ensureConnectedAccount('seller-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(whop.createConnectedAccount).not.toHaveBeenCalled();
  });
});
