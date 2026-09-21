jest.mock('../lib/supabase.client', () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));

import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { supabase } from '../lib/supabase.client';
import { CrmAdminController } from './crm-admin.controller';
import { CrmAdminService } from './crm-admin.service';

const request = {
  manager: { sub: 'admin-1', role: 'admin' },
  headers: {},
  ip: '127.0.0.1',
};

describe('CRM provider payout workflow', () => {
  let payouts: Record<string, jest.Mock>;
  let service: CrmAdminService;

  beforeEach(() => {
    payouts = {
      findByReference: jest.fn().mockResolvedValue({ id: 'payout-1' }),
      approveAndDispatch: jest.fn().mockResolvedValue({
        payoutId: 'payout-1',
        state: 'processing',
      }),
      reject: jest.fn().mockResolvedValue({ state: 'rejected' }),
      retryDispatch: jest.fn().mockResolvedValue({ state: 'processing' }),
      reconcileOne: jest.fn().mockResolvedValue({ state: 'processing' }),
      manualOverride: jest.fn().mockResolvedValue({ state: 'completed' }),
      attachProviderPayout: jest.fn().mockResolvedValue({ state: 'processing' }),
      listFeeRules: jest.fn().mockResolvedValue([]),
      updateFeeRule: jest.fn().mockResolvedValue({ methodKey: 'pix' }),
      getCrmDetail: jest.fn().mockResolvedValue({ payoutId: 'payout-1' }),
    };
    service = new CrmAdminService(payouts as never);
    jest.spyOn(service as any, 'audit').mockResolvedValue(undefined);
  });

  it('delegates a provider-backed approval to the payout orchestrator', async () => {
    await expect(
      service.approveWithdrawal(
        { managerId: 'admin-1', role: 'admin' },
        'ledger-1',
        { notes: 'approved' },
      ),
    ).resolves.toMatchObject({ state: 'processing' });

    expect(payouts.approveAndDispatch).toHaveBeenCalledWith('payout-1', {
      managerId: 'admin-1',
      role: 'admin',
    });
  });

  it('requires a reason for controlled manual recovery', async () => {
    await expect(
      service.manualOverrideWithdrawal(
        { managerId: 'admin-1', role: 'admin' },
        'payout-1',
        { action: 'completed', reason: ' ' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(payouts.manualOverride).not.toHaveBeenCalled();
  });

  it('exposes admin-only fee, retry, reconcile, and manual recovery routes', async () => {
    const controller = new CrmAdminController(service);

    await controller.listPayoutFees(request as never);
    await controller.updatePayoutFee(request as never, 'pix', {
      percentage_bps: 200,
      fixed_fee_usd_cents: 300,
      enabled: true,
      effective_at: '2026-09-21T00:00:00.000Z',
    });
    await controller.retryWithdrawal(request as never, 'payout-1');
    await controller.reconcileWithdrawal(request as never, 'payout-1');
    await controller.manualOverrideWithdrawal(request as never, 'payout-1', {
      action: 'completed',
      reason: 'Provider confirmed completion',
    });
    await controller.attachProviderPayout(request as never, 'payout-1', {
      provider_payout_id: 'wdrl_recovered',
      reason: 'Confirmed in Whop dashboard',
    });

    expect(payouts.updateFeeRule).toHaveBeenCalledWith(
      'pix',
      expect.objectContaining({ percentageBps: 200, fixedUsdCents: 300 }),
      'admin-1',
    );
    expect(payouts.retryDispatch).toHaveBeenCalled();
    expect(payouts.reconcileOne).toHaveBeenCalled();
    expect(payouts.manualOverride).toHaveBeenCalled();
    expect(payouts.attachProviderPayout).toHaveBeenCalledWith(
      'payout-1',
      'wdrl_recovered',
      expect.objectContaining({ managerId: 'admin-1', role: 'admin' }),
      'Confirmed in Whop dashboard',
    );
  });

  it('surfaces an audit write failure instead of silently losing it', async () => {
    (service as any).audit.mockRestore();
    (supabase.from as jest.Mock).mockReturnValue({
      insert: jest.fn().mockResolvedValue({ error: { message: 'unavailable' } }),
    });

    await expect(
      (service as any).audit(
        { managerId: 'admin-1', role: 'admin' },
        'withdrawal.reconciled',
        'withdrawal',
        'payout-1',
        {},
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
