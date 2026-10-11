jest.mock('./cross-service-jwt.guard', () => ({
  CrossServiceJwtGuard: class CrossServiceJwtGuard {},
}));
jest.mock('./koopfy-finance.service', () => ({
  KoopfyFinanceService: class KoopfyFinanceService {},
}));
jest.mock('./seller-refund.service', () => ({
  SellerRefundService: class SellerRefundService {},
}));

import { KoopfyFinanceController } from './koopfy-finance.controller';

describe('KoopfyFinanceController', () => {
  it('derives resource access from sellerCtx instead of request identity fields', async () => {
    const finance = {
      getTransaction: jest.fn().mockResolvedValue({ id: 'tx-1' }),
    };
    const controller = new KoopfyFinanceController(finance as never, {} as never);
    const req = {
      sellerCtx: { seller: { id: 'verified-seller' } },
      body: { sellerId: 'attacker-seller' },
    };

    await expect(controller.transaction(req, 'tx-1')).resolves.toEqual({
      id: 'tx-1',
    });
    expect(finance.getTransaction).toHaveBeenCalledWith(
      req.sellerCtx,
      'tx-1',
    );
  });

  it('forwards only the response body fields for a dispute response', async () => {
    const finance = {
      respondToDispute: jest.fn().mockResolvedValue({ message: 'ok' }),
    };
    const controller = new KoopfyFinanceController(finance as never, {} as never);
    const req = { sellerCtx: { seller: { id: 'verified-seller' } } };
    const body = {
      message: 'Evidence attached',
      evidenceUrls: ['https://merchant.example/evidence.pdf'],
      sellerId: 'attacker-seller',
    };

    await controller.respondToDispute(req, 'dp-1', body as never);

    expect(finance.respondToDispute).toHaveBeenCalledWith(req.sellerCtx, 'dp-1', {
      message: 'Evidence attached',
      evidenceUrls: ['https://merchant.example/evidence.pdf'],
    });
  });

  it('drops browser-supplied seller and provider identity fields from payout methods', async () => {
    const finance = {
      createPayoutMethod: jest.fn().mockResolvedValue({ id: 'local-method-1' }),
    };
    const controller = new KoopfyFinanceController(finance as never, {} as never);
    const sellerCtx = { seller: { id: 'verified-seller' } };

    await controller.createPayoutMethod(
      { sellerCtx } as never,
      {
        supportedMethodId: 'podst_1',
        destinationCurrency: 'usd',
        fields: { fld_bank_routing_number: '021000021' },
        sellerId: 'attacker',
        account_id: 'biz_attacker',
        provider_method_id: 'potk_attacker',
      } as never,
    );

    expect(finance.createPayoutMethod).toHaveBeenCalledWith(sellerCtx, {
      supportedMethodId: 'podst_1',
      destinationCurrency: 'usd',
      fields: { fld_bank_routing_number: '021000021' },
    });
  });

  it('allowlists preview and requote confirmation bodies', async () => {
    const finance = {
      previewPayout: jest.fn(),
      reconfirmPayout: jest.fn(),
    };
    const controller = new KoopfyFinanceController(finance as never, {} as never);
    const sellerCtx = { seller: { id: 'verified-seller' } };
    const req = { sellerCtx };

    await controller.previewPayout(req, {
      methodId: 'local-method-1',
      speed: 'standard',
      grossMinor: 11_990,
      sellerId: 'attacker',
      quoteToken: 'secret',
    } as never);
    await controller.reconfirmPayout(
      req,
      'payout-1',
      'reconfirm_key_12345678',
      {
        confirmedMinimumNetMinor: 10_810,
        providerMethodId: 'potk_attacker',
      } as never,
    );

    expect(finance.previewPayout).toHaveBeenCalledWith(sellerCtx, {
      methodId: 'local-method-1',
      speed: 'standard',
      grossMinor: 11_990,
    });
    expect(finance.reconfirmPayout).toHaveBeenCalledWith(
      sellerCtx,
      'payout-1',
      10_810,
      'reconfirm_key_12345678',
    );
  });
});
