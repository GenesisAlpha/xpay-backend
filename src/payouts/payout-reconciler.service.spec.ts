jest.mock('../lib/supabase.client', () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));

import { PayoutReconcilerService } from './payout-reconciler.service';

describe('PayoutReconcilerService', () => {
  let repository: Record<string, jest.Mock>;
  let orchestrator: Record<string, jest.Mock>;
  let service: PayoutReconcilerService;

  beforeEach(() => {
    repository = {
      listStaleExecutions: jest.fn().mockResolvedValue([
        {
          id: 'payout-processing',
          localState: 'processing',
          providerPayoutId: 'wdrl_1',
          providerCreateStartedAt: '2026-09-21T12:00:00.000Z',
          providerCreateResolvedAt: '2026-09-21T12:00:01.000Z',
        },
        {
          id: 'payout-pre-create',
          localState: 'dispatching',
          providerPayoutId: null,
          providerCreateStartedAt: null,
          providerCreateResolvedAt: null,
        },
      ]),
      countUnresolvedProviderCreates: jest.fn().mockResolvedValue(1),
    };
    orchestrator = {
      reconcileOne: jest
        .fn()
        .mockResolvedValueOnce({ state: 'processing' })
        .mockResolvedValueOnce({ state: 'processing' }),
    };
    service = new PayoutReconcilerService(
      repository as never,
      orchestrator as never,
    );
  });

  it('reconciles known or safely pre-create payouts and quarantines uncertain creates', async () => {
    await expect(
      service.reconcileStaleExecutions(new Date('2026-09-21T15:00:00.000Z')),
    ).resolves.toMatchObject({ scanned: 3, reconciled: 2, manualRequired: 1 });

    expect(orchestrator.reconcileOne).toHaveBeenCalledTimes(2);
    expect(orchestrator.reconcileOne).toHaveBeenNthCalledWith(
      1,
      'payout-processing',
      { managerId: 'system:payout-reconciler', role: 'admin' },
    );
    expect(orchestrator.reconcileOne).toHaveBeenNthCalledWith(
      2,
      'payout-pre-create',
      { managerId: 'system:payout-reconciler', role: 'admin' },
    );
  });

  it('does not overlap scheduled reconciliation runs', async () => {
    let release!: () => void;
    repository.listStaleExecutions.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve([]);
      }),
    );
    const first = service.reconcileStaleExecutions(new Date());
    await expect(service.reconcileStaleExecutions(new Date())).resolves.toEqual({
      skipped: true,
      reason: 'already_running',
    });
    release();
    await first;
  });

  it('does not let a full batch of quarantined creates starve an eligible payout', async () => {
    repository.countUnresolvedProviderCreates.mockResolvedValueOnce(50);
    repository.listStaleExecutions.mockResolvedValueOnce([
      {
        id: 'payout-after-quarantine',
        localState: 'processing',
        providerPayoutId: 'wdrl_after_quarantine',
        providerCreateStartedAt: '2026-09-21T12:00:00.000Z',
        providerCreateResolvedAt: '2026-09-21T12:00:01.000Z',
      },
    ]);
    orchestrator.reconcileOne.mockReset().mockResolvedValue({
      state: 'completed',
    });

    await expect(
      service.reconcileStaleExecutions(new Date('2026-09-21T15:00:00.000Z')),
    ).resolves.toMatchObject({
      scanned: 51,
      reconciled: 1,
      manualRequired: 50,
    });
    expect(orchestrator.reconcileOne).toHaveBeenCalledWith(
      'payout-after-quarantine',
      { managerId: 'system:payout-reconciler', role: 'admin' },
    );
  });
});
