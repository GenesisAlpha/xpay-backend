import { ConflictException } from '@nestjs/common';

jest.mock('../lib/supabase.client', () => ({ supabase: {} }));

import { KoopfyFinanceService } from './koopfy-finance.service';
import { SellerCtx } from './cross-service-jwt.guard';

const activeContext: SellerCtx = {
  userId: 'user-1',
  email: 'seller@example.com',
  seller: { id: 'seller-1', status: 'active', kyc_status: 'approved' },
};

function createService() {
  const dashboard = {
    getData: jest.fn(),
  };
  const transactions = {
    list: jest.fn(),
    getById: jest.fn(),
  };
  const wallet = {
    getBalance: jest.fn(),
    getEntries: jest.fn(),
    getPayouts: jest.fn(),
    requestPayout: jest.fn(),
  };
  const disputes = {
    getStats: jest.fn(),
    list: jest.fn(),
    respond: jest.fn(),
  };
  const transfers = {
    getTotals: jest.fn(),
    list: jest.fn(),
    retry: jest.fn(),
  };
  const methods = {
    list: jest.fn(),
    getPerformance: jest.fn(),
  };
  const settings = {
    get: jest.fn(),
    update: jest.fn(),
    getOffers: jest.fn(),
    addOffer: jest.fn(),
    getWebhookSecret: jest.fn(),
  };
  const apiKeys = {
    createKey: jest.fn(),
    listKeys: jest.fn(),
    revokeKeyImmediate: jest.fn(),
    rotateKey: jest.fn(),
  };

  return {
    service: new KoopfyFinanceService(
      dashboard as never,
      transactions as never,
      wallet as never,
      disputes as never,
      transfers as never,
      methods as never,
      settings as never,
      apiKeys as never,
    ),
    dashboard,
    transactions,
    wallet,
    disputes,
    transfers,
    methods,
    settings,
    apiKeys,
  };
}

describe('KoopfyFinanceService', () => {
  it('rejects operational data when the seller account is not active', async () => {
    const { service } = createService();
    const pending = {
      ...activeContext,
      seller: { ...activeContext.seller!, status: 'pending_review' },
    };

    await expect(service.getOverview(pending, '30d')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('removes the cross-seller leaderboard from the overview', async () => {
    const { service, dashboard } = createService();
    dashboard.getData.mockResolvedValue({
      kpis: { volume: { value: 120 } },
      volumeChart: [{ day: '10', volume: 120 }],
      methodsDistribution: [{ name: 'Cartão', value: 100, amount: 120 }],
      recentActivity: [{ id: 'tx-1', amount: 120 }],
      recurring: { active: 2, mrr: 120 },
      topPlayers: { monthlyTop: [{ sellerId: 'seller-2' }] },
    });

    await expect(service.getOverview(activeContext, '30d')).resolves.toEqual({
      kpis: { volume: { value: 120 } },
      volumeChart: [{ day: '10', volume: 120 }],
      methodsDistribution: [{ name: 'Cartão', value: 100, amount: 120 }],
      recentActivity: [{ id: 'tx-1', amount: 120 }],
      recurring: { active: 2, mrr: 120 },
    });
  });

  it('scopes and sanitizes transaction results', async () => {
    const { service, transactions } = createService();
    transactions.list.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          customer: 'Ana',
          customerEmail: 'ana@example.com',
          country: 'BR',
          paymentMethod: 'pix',
          amount: 120,
          currency: 'BRL',
          amountUSD: 22,
          status: 'approved',
          provider: 'stripe',
          providerTransactionId: 'pi_private',
          metadata: { secret: 'never-return' },
          orderId: 'order-1',
          fee: 2,
          netAmount: 20,
          createdAt: '2026-09-11T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });

    const result = await service.listTransactions(activeContext, {});

    expect(result).toEqual({
      data: [
        expect.objectContaining({
          id: 'tx-1',
          processor: 'Koopfy Payments',
          orderId: 'order-1',
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    expect(result.data[0]).not.toHaveProperty('provider');
    expect(result.data[0]).not.toHaveProperty('providerTransactionId');
    expect(result.data[0]).not.toHaveProperty('metadata');
    expect(transactions.list).toHaveBeenCalledWith(
      'seller-1',
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
  });

  it('does not expose provider routing from payment methods', async () => {
    const { service, methods } = createService();
    methods.list.mockResolvedValue([
      {
        id: 'card',
        name: 'Cartões',
        category: 'card',
        provider: 'stripe',
        enabled: true,
        countries: ['*'],
        fees: '9.99%',
        settlementDays: 3,
        volume: 100,
        transactions: 2,
        approvalRate: 90,
        avgTicket: 50,
      },
    ]);

    const [method] = await service.listPaymentMethods(activeContext);

    expect(method).toEqual(
      expect.objectContaining({
        id: 'card',
        processor: 'Koopfy Payments',
        enabled: true,
      }),
    );
    expect(method).not.toHaveProperty('provider');
  });

  it('redacts stored secrets from settings and listed API keys', async () => {
    const { service, settings, apiKeys } = createService();
    settings.get.mockResolvedValue({
      webhooks: {
        url: 'https://merchant.example/webhook',
        secret: 'whsec_private',
        events: { 'payment.succeeded': true },
      },
    });
    apiKeys.listKeys.mockResolvedValue([
      {
        id: 'key-1',
        name: 'Production',
        publishable_key: 'pk_live_public',
        key_prefix: 'sk_live_prefix',
        secretKey: 'sk_live_private',
        is_active: true,
        status: 'active',
        created_at: '2026-09-11T00:00:00.000Z',
        expires_at: null,
        revoked_at: null,
      },
    ]);

    await expect(service.getIntegrationSettings(activeContext)).resolves.toEqual({
      webhooks: {
        url: 'https://merchant.example/webhook',
        events: { 'payment.succeeded': true },
      },
    });
    const [key] = await service.listApiKeys(activeContext);
    expect(key).not.toHaveProperty('secretKey');
    expect(key).toEqual(
      expect.objectContaining({ id: 'key-1', keyPrefix: 'sk_live_prefix' }),
    );
  });
});
