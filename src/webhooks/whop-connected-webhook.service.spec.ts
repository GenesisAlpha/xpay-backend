jest.mock('../lib/supabase.client', () => ({ supabase: { from: jest.fn() } }));
// Os dois serviços reais puxam o router, os providers e o Supabase inteiro.
jest.mock('./webhook.service', () => ({ WebhookService: class WebhookService { } }));
jest.mock('../orchestrator/whop/whop-connect.service', () => ({ WhopConnectService: class WhopConnectService { } }));

import * as crypto from 'crypto';
import { supabase } from '../lib/supabase.client';
import { WhopConnectedWebhookService } from './whop-connected-webhook.service';

const SECRET = 'ws_connected_test';

function signed(body: any) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', Buffer.from(SECRET, 'utf8'))
    .update(`msg_1.${ts}.${raw}`)
    .digest('base64');
  return {
    raw,
    headers: { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${signature}` } as Record<string, string>,
  };
}

function mockTransaction(tx: any) {
  (supabase.from as jest.Mock).mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: tx }) }) }),
  });
}

function setup(row: any = { seller_id: 'seller-1', whop_account_id: 'biz_seller' }) {
  const webhooks = { handleWhopWebhook: jest.fn().mockResolvedValue({ received: true }) };
  const connect = {
    getRowByWhopAccount: jest.fn().mockResolvedValue(row),
    sync: jest.fn().mockResolvedValue({}),
    recordRiskSignal: jest.fn().mockResolvedValue(undefined),
    coverNegativeBalance: jest.fn().mockResolvedValue({ covered: [] }),
  };
  return { service: new WhopConnectedWebhookService(webhooks as any, connect as any), webhooks, connect };
}

const paymentBody = (metadata: Record<string, any>) => ({
  type: 'payment.succeeded',
  account_id: 'biz_seller',
  data: { id: 'pay_1', metadata },
});

describe('WhopConnectedWebhookService', () => {
  beforeEach(() => {
    process.env.WHOP_CONNECTED_WEBHOOK_SECRET = SECRET;
    (supabase.from as jest.Mock).mockReset();
  });
  afterAll(() => { delete process.env.WHOP_CONNECTED_WEBHOOK_SECRET; });

  it('recusa (5xx) sem segredo e com assinatura inválida', async () => {
    const { service, webhooks } = setup();
    const { raw, headers } = signed(paymentBody({}));

    delete process.env.WHOP_CONNECTED_WEBHOOK_SECRET;
    await expect(service.handle(paymentBody({}), raw, headers)).rejects.toThrow('WHOP_CONNECTED_WEBHOOK_SECRET');

    process.env.WHOP_CONNECTED_WEBHOOK_SECRET = SECRET;
    await expect(service.handle(paymentBody({}), raw, { ...headers, 'webhook-signature': 'v1,forjada' }))
      .rejects.toThrow('assinatura inválida');
    expect(webhooks.handleWhopWebhook).not.toHaveBeenCalled();
  });

  it('pagamento do próprio seller segue o pipeline da Whop com a conta whopc_', async () => {
    const { service, webhooks, connect } = setup();
    const body = paymentBody({ koopfy_transaction_id: 'tx-1', koopfy_seller_id: 'seller-1', koopfy_account_id: 'whopc_biz_seller' });
    const { raw, headers } = signed(body);
    mockTransaction({ id: 'tx-1', seller_id: 'seller-1', provider_account_id: 'whopc_biz_seller' });

    await service.handle(body, raw, headers);

    expect(webhooks.handleWhopWebhook).toHaveBeenCalledWith('whopc_biz_seller', body, raw, headers);
    expect(connect.coverNegativeBalance).not.toHaveBeenCalled();
  });

  it('evento que aponta para transação de outro seller não toca em nada', async () => {
    const { service, webhooks } = setup();
    const body = paymentBody({ koopfy_transaction_id: 'tx-of-seller-2' });
    const { raw, headers } = signed(body);
    mockTransaction({ id: 'tx-of-seller-2', seller_id: 'seller-2', provider_account_id: 'whop_main' });

    const result = await service.handle(body, raw, headers);

    expect(result).toEqual({ ignored: true, reason: 'ownership mismatch' });
    expect(webhooks.handleWhopWebhook).not.toHaveBeenCalled();
  });

  it('conta que não é conectada da Koopfy é ignorada', async () => {
    const { service, webhooks } = setup(null);
    const body = paymentBody({});
    const { raw, headers } = signed(body);

    expect(await service.handle(body, raw, headers)).toEqual({ ignored: true, reason: 'unknown account' });
    expect(webhooks.handleWhopWebhook).not.toHaveBeenCalled();
  });

  it('account.updated e identity_profile.* sincronizam a conta', async () => {
    const { service, connect, webhooks } = setup();

    for (const type of ['account.updated', 'identity_profile.updated']) {
      const body = { type, account_id: 'biz_seller', data: { id: 'x' } };
      const { raw, headers } = signed(body);
      await service.handle(body, raw, headers);
    }

    expect(connect.sync).toHaveBeenCalledTimes(2);
    expect(connect.sync).toHaveBeenCalledWith('seller-1');
    expect(webhooks.handleWhopWebhook).not.toHaveBeenCalled();
  });

  it('disputa segue o pipeline, entra no risco e cobre o negativo da conta do seller', async () => {
    const { service, connect, webhooks } = setup();
    const body = {
      type: 'dispute.created',
      account_id: 'biz_seller',
      data: { id: 'dp_1', amount: 19.9, currency: 'usd', reason: 'fraudulent', payment: { metadata: { koopfy_transaction_id: 'tx-1' } } },
    };
    const { raw, headers } = signed(body);
    mockTransaction({ id: 'tx-1', seller_id: 'seller-1', provider_account_id: 'whopc_biz_seller' });

    await service.handle(body, raw, headers);

    expect(webhooks.handleWhopWebhook).toHaveBeenCalled();
    expect(connect.recordRiskSignal).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'dp_1',
      sellerId: 'seller-1',
      whopAccountId: 'biz_seller',
      kind: 'dispute',
      transactionId: 'tx-1',
      amountCents: 1990,
    }));
    expect(connect.coverNegativeBalance).toHaveBeenCalledWith('seller-1', 'dp_1');
  });

  it('falha na cobertura não derruba o evento', async () => {
    const { service, connect } = setup();
    connect.coverNegativeBalance.mockRejectedValue(new Error('Whop fora'));
    const body = { type: 'refund.created', account_id: 'biz_seller', data: { id: 'rf_1', amount: 10 } };
    const { raw, headers } = signed(body);

    await expect(service.handle(body, raw, headers)).resolves.toEqual({ received: true });
    expect(connect.coverNegativeBalance).toHaveBeenCalledWith('seller-1', 'rf_1');
  });

  it('alerta de disputa entra no risco sem mexer em transação', async () => {
    const { service, connect, webhooks } = setup();
    const body = { type: 'dispute_alert.created', account_id: 'biz_seller', data: { id: 'da_1', amount: 50 } };
    const { raw, headers } = signed(body);

    await service.handle(body, raw, headers);

    expect(connect.recordRiskSignal).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'da_1', kind: 'dispute_alert', amountCents: 5000 }));
    expect(webhooks.handleWhopWebhook).not.toHaveBeenCalled();
  });
});
