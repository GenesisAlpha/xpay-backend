process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY ?? 'x';

jest.mock('../lib/supabase.client', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }));

import { supabase } from '../lib/supabase.client';
import { SellerRefundService, refundBlocker } from './seller-refund.service';

// Reembolso pedido pelo seller: total, pela API do provedor, com saldo que cubra
// e com a marca `refund_requested_by` gravada ANTES da chamada.

const SELLER = 'seller-1';
const ctx: any = { userId: 'u1', email: 's@x.com', seller: { id: SELLER, status: 'active', kyc_status: 'approved' } };

const baseTx = (over: Record<string, unknown> = {}) => ({
  id: 'tx-1', seller_id: SELLER, status: 'approved', provider: 'whop', method: 'card',
  provider_account_id: 'whop_main', provider_transaction_id: 'pay_abc', amount: 10000, currency: 'USD',
  amount_usd_gross_cents: 10000, fee: 1200, external_fee_cents: 0, metadata: { whop_payment_id: 'pay_abc' },
  ...over,
});

/** Banco simulado: transação, ledger e saldo; registra os updates na transação. */
function db(tx: any, opts: { credited?: number; reserve?: number; available?: number; pending?: number } = {}) {
  const updates: any[] = [];
  (supabase.from as jest.Mock).mockImplementation((table: string) => {
    const q: any = { _filters: {} as Record<string, unknown> };
    q.select = () => q;
    q.eq = (col: string, value: unknown) => { q._filters[col] = value; return q; };
    q.maybeSingle = async () => {
      if (table === 'transactions') return { data: tx && q._filters.seller_id === tx.seller_id ? tx : null, error: null };
      if (table === 'wallet_balance') return { data: { available_balance: opts.available ?? 0, pending_balance: opts.pending ?? 0 }, error: null };
      return { data: null, error: null };
    };
    q.update = (patch: any) => {
      const u: any = { patch, filters: {} as Record<string, unknown> };
      updates.push(u);
      const chain: any = {};
      chain.eq = (col: string, value: unknown) => { u.filters[col] = value; return chain; };
      chain.select = async () => ({ data: tx.status === 'approved' ? [{ id: tx.id }] : [], error: null });
      chain.then = (resolve: any) => resolve({ data: null, error: null });
      return chain;
    };
    // wallet_ledger: lista
    q.then = (resolve: any) => {
      if (table === 'wallet_ledger') {
        const rows = q._filters.type === 'credit_pending'
          ? (opts.credited == null ? [{ amount: 8800 }] : opts.credited > 0 ? [{ amount: opts.credited }] : [])
          : (opts.reserve ? [{ amount: opts.reserve }] : []);
        return resolve({ data: rows, error: null });
      }
      return resolve({ data: [], error: null });
    };
    return q;
  });
  return updates;
}

describe('refundBlocker', () => {
  it('venda aprovada de provedor com estorno pela API passa', () => {
    for (const provider of ['whop', 'stripe', 'slash']) expect(refundBlocker(baseTx({ provider }))).toBeNull();
    expect(refundBlocker(baseTx({ provider: 'clip', method: 'card' }))).toBeNull();
  });

  it('o que não pode: já reembolsada, chargeback, não aprovada, em disputa, SPEI, provedor sem API', () => {
    expect(refundBlocker(baseTx({ status: 'refunded' }))?.code).toBe('ALREADY_REFUNDED');
    expect(refundBlocker(baseTx({ status: 'chargeback' }))?.code).toBe('CHARGEBACK');
    expect(refundBlocker(baseTx({ status: 'pending' }))?.code).toBe('NOT_APPROVED');
    expect(refundBlocker(baseTx({ metadata: { whop_dispute: { status: 'needs_response' } } }))?.code).toBe('DISPUTED');
    expect(refundBlocker(baseTx({ provider: 'clip', method: 'spei' }))?.code).toBe('MANUAL_REFUND');
    expect(refundBlocker(baseTx({ provider: 'paypal' }))?.code).toBe('UNSUPPORTED_PROVIDER');
  });

  it('pedido recente segura um segundo clique; depois de 30 min pode tentar de novo', () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    expect(refundBlocker(baseTx({ metadata: { refund_requested_at: '2026-10-11T11:50:00Z' } }), now)?.code).toBe('REFUND_PENDING');
    expect(refundBlocker(baseTx({ metadata: { refund_requested_at: '2026-10-11T11:00:00Z' } }), now)).toBeNull();
  });
});

describe('SellerRefundService', () => {
  const whopRefund = jest.fn();
  const clipRefund = jest.fn();
  const applyConfirmedRefund = jest.fn().mockResolvedValue({ refunded: true });
  const resolveAccountById = jest.fn().mockResolvedValue({ id: 'whop_main', apiKey: 'k', config: { public_key: 'pk' } });
  const svc = new SellerRefundService({ resolveAccountById } as any, { applyConfirmedRefund } as any);

  beforeEach(() => {
    jest.clearAllMocks();
    resolveAccountById.mockResolvedValue({ id: 'whop_main', apiKey: 'k', config: { public_key: 'pk' } });
    jest.spyOn(require('../orchestrator/providers/whop.provider').WhopProvider.prototype, 'refund').mockImplementation(whopRefund as never);
    jest.spyOn(require('../orchestrator/providers/clip.provider').ClipProvider.prototype, 'refund').mockImplementation(clipRefund as never);
  });

  it('prévia: debita o valor cheio (taxa não volta) e libera com saldo', async () => {
    db(baseTx(), { available: 20000 });
    await expect(svc.preview(ctx, 'tx-1')).resolves.toMatchObject({ refundable: true, debitUsd: 100, feeUsd: 12, amount: 100, currency: 'USD' });
  });

  it('sem saldo que cubra o valor cheio: bloqueia e NÃO chama o provedor', async () => {
    const updates = db(baseTx(), { available: 3000, pending: 2000 });
    await expect(svc.preview(ctx, 'tx-1')).resolves.toMatchObject({ refundable: false, reason: 'INSUFFICIENT_BALANCE' });
    await expect(svc.request(ctx, 'tx-1', { reason: 'cliente desistiu' })).rejects.toMatchObject({ response: { error: 'INSUFFICIENT_BALANCE' } });
    expect(whopRefund).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('reserva ainda presa conta como devolvida: o débito é o bruto menos ela', async () => {
    db(baseTx(), { reserve: 1000, available: 9000 });
    await expect(svc.preview(ctx, 'tx-1')).resolves.toMatchObject({ refundable: true, debitUsd: 90 });
  });

  it('motivo é obrigatório', async () => {
    db(baseTx(), { available: 20000 });
    await expect(svc.request(ctx, 'tx-1', { reason: ' ' })).rejects.toMatchObject({ response: { error: 'REASON_REQUIRED' } });
  });

  it('Whop: marca a transação ANTES de chamar e aguarda o webhook quando só foi aceito', async () => {
    const updates = db(baseTx(), { available: 20000 });
    whopRefund.mockImplementation(async () => {
      expect(updates[0].patch.metadata.refund_requested_by).toBe('seller:u1');
      expect(updates[0].filters).toMatchObject({ id: 'tx-1', seller_id: SELLER, status: 'approved' });
      return { success: true, refunded: false };
    });
    await expect(svc.request(ctx, 'tx-1', { reason: 'cliente desistiu' })).resolves.toMatchObject({ status: 'requested' });
    expect(whopRefund).toHaveBeenCalledWith('pay_abc', expect.objectContaining({ apiKey: 'k' }));
    expect(applyConfirmedRefund).not.toHaveBeenCalled();
  });

  it('Whop já devolveu na resposta: contabiliza na hora', async () => {
    db(baseTx(), { available: 20000 });
    whopRefund.mockResolvedValue({ success: true, refunded: true });
    await expect(svc.request(ctx, 'tx-1', { reason: 'cliente desistiu' })).resolves.toMatchObject({ status: 'refunded' });
    expect(applyConfirmedRefund).toHaveBeenCalledWith('tx-1');
  });

  it('provedor recusa: a marca sai, o motivo fica registrado e nada é contabilizado', async () => {
    const updates = db(baseTx(), { available: 20000 });
    whopRefund.mockResolvedValue({ success: false, message: 'Payment already refunded' });
    await expect(svc.request(ctx, 'tx-1', { reason: 'cliente desistiu' })).rejects.toMatchObject({ response: { error: 'PROVIDER_REFUSED' } });
    const last = updates[updates.length - 1].patch.metadata;
    expect(last.refund_requested_by).toBeUndefined();
    expect(last.refund_last_error).toContain('already refunded');
    expect(applyConfirmedRefund).not.toHaveBeenCalled();
  });

  it('Clip (cartão): o 200 é a confirmação — contabiliza na hora, com o valor da venda', async () => {
    db(baseTx({ provider: 'clip', provider_account_id: 'clip_mx_gray_01', provider_transaction_id: 'clip-pay-1', amount: 60100, currency: 'MXN', metadata: {} }), { available: 20000 });
    clipRefund.mockResolvedValue({ success: true });
    await expect(svc.request(ctx, 'tx-1', { reason: 'producto defectuoso' })).resolves.toMatchObject({ status: 'refunded' });
    expect(clipRefund).toHaveBeenCalledWith(expect.objectContaining({ providerTransactionId: 'clip-pay-1', amountMinor: 60100, reason: 'producto defectuoso' }));
    expect(applyConfirmedRefund).toHaveBeenCalledWith('tx-1');
  });

  it('conta própria do seller: não exige saldo (nada foi creditado na Koopfy)', async () => {
    db(baseTx({ provider_account_id: 'stripel_abc123' }), { available: 0 });
    const preview = await svc.preview(ctx, 'tx-1');
    expect(preview).toMatchObject({ debitUsd: 0 });
  });

  it('transação de outro seller não é encontrada', async () => {
    db(baseTx({ seller_id: 'outro' }));
    await expect(svc.preview(ctx, 'tx-1')).rejects.toMatchObject({ status: 404 });
  });
});
