jest.mock('./cross-service-jwt.guard', () => ({
  CrossServiceJwtGuard: class CrossServiceJwtGuard {},
}));
jest.mock('./koopfy-finance.service', () => ({
  KoopfyFinanceService: class KoopfyFinanceService {},
}));

import { KoopfyFinanceController } from './koopfy-finance.controller';

describe('KoopfyFinanceController', () => {
  it('derives resource access from sellerCtx instead of request identity fields', async () => {
    const finance = {
      getTransaction: jest.fn().mockResolvedValue({ id: 'tx-1' }),
    };
    const controller = new KoopfyFinanceController(finance as never);
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
    const controller = new KoopfyFinanceController(finance as never);
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
});
