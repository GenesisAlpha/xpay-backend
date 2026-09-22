jest.mock('../lib/supabase.client', () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));

import { ServiceUnavailableException } from '@nestjs/common';
import { WhopPayoutWebhookService } from './whop-payout-webhook.service';

describe('WhopPayoutWebhookService', () => {
  let repository: Record<string, jest.Mock>;
  let whop: Record<string, jest.Mock>;
  let orchestrator: Record<string, jest.Mock>;
  let service: WhopPayoutWebhookService;

  const execution = {
    id: '00000000-0000-4000-8000-000000000123',
    providerAccountId: 'biz_connected',
    providerPayoutId: 'wdrl_1',
  };
  const event = (type = 'payout.updated') => ({
    id: 'evt_payout_1',
    type,
    data: {
      id: 'wdrl_1',
      metadata: {
        koopfy_payout_id: execution.id,
        koopfy_account_id: 'biz_connected',
        koopfy_master_account_id: 'biz_master',
      },
    },
  });

  beforeEach(() => {
    repository = {
      findByProviderPayoutId: jest.fn().mockResolvedValue(execution),
      findByReference: jest.fn(),
    };
    whop = {
      retrievePayout: jest.fn().mockResolvedValue({
        id: 'wdrl_1',
        status: 'processing',
      }),
    };
    orchestrator = {
      applyVerifiedProviderPayout: jest.fn().mockResolvedValue({
        state: 'processing',
      }),
    };
    service = new WhopPayoutWebhookService(
      repository as never,
      whop as never,
      orchestrator as never,
    );
  });

  it.each(['payout.created', 'payout.updated', 'payout.reversed'])(
    'handles %s as a payout lifecycle event',
    (type) => {
      expect(service.handles(type)).toBe(true);
    },
  );

  it('resolves by provider id first and applies only an authoritative retrieval', async () => {
    await service.handleVerifiedEvent(event(), 'biz_master');

    expect(repository.findByProviderPayoutId).toHaveBeenCalledWith('wdrl_1');
    expect(repository.findByReference).not.toHaveBeenCalled();
    expect(whop.retrievePayout).toHaveBeenCalledWith(
      'wdrl_1',
      'biz_connected',
    );
    expect(orchestrator.applyVerifiedProviderPayout).toHaveBeenCalledWith(
      execution.id,
      expect.objectContaining({ id: 'wdrl_1' }),
      'Webhook Whop evt_payout_1',
    );
  });

  it('resolves an accepted-before-local-write race from validated metadata', async () => {
    repository.findByProviderPayoutId.mockResolvedValueOnce(null);
    repository.findByReference.mockResolvedValueOnce({
      ...execution,
      providerPayoutId: null,
    });

    await service.handleVerifiedEvent(event('payout.created'), 'biz_master');

    expect(repository.findByReference).toHaveBeenCalledWith(execution.id);
    expect(orchestrator.applyVerifiedProviderPayout).toHaveBeenCalledTimes(1);
  });

  it('fails retryably for an unknown Koopfy-owned payout', async () => {
    repository.findByProviderPayoutId.mockResolvedValueOnce(null);
    repository.findByReference.mockResolvedValueOnce(null);

    await expect(
      service.handleVerifiedEvent(event(), 'biz_master'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(orchestrator.applyVerifiedProviderPayout).not.toHaveBeenCalled();
  });

  it('ignores unrelated payout events without Koopfy ownership metadata', async () => {
    repository.findByProviderPayoutId.mockResolvedValueOnce(null);

    await expect(
      service.handleVerifiedEvent(
        { id: 'evt_other', type: 'payout.updated', data: { id: 'wdrl_other' } },
        'biz_master',
      ),
    ).resolves.toMatchObject({ ignored: true });
    expect(repository.findByReference).not.toHaveBeenCalled();
  });
});
