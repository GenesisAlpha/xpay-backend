jest.mock('../../lib/supabase.client', () => ({ supabase: {} }));

import { WhopProvider } from './whop.provider';

// Cobrança off-session do upsell de um clique: o provider não cria checkout
// configuration, chama POST /api/v1/payments com o cartão salvo e nunca aprova
// na hora — quem aprova é o webhook payment.succeeded.

function ctx(overrides: Record<string, any> = {}) {
  return {
    amount: 4900,
    currency: 'USD',
    transactionId: 'tx-upsell-1',
    method: 'card',
    sellerId: 'seller-1',
    metadata: { order_number: 'K-10-U1', product_id: 'prod-9', product_title: 'Curso avançado' },
    providerConfig: {
      id: 'whop-account-1',
      apiKey: 'whop-key',
      api_url: 'https://api.whop.test',
      config: { company_id: 'biz_123' },
    },
    offSession: { memberId: 'mber_1', paymentMethodId: 'payt_1', parentTransactionId: 'tx-parent-1' },
    ...overrides,
  };
}

function mockFetch(status: number, body: any) {
  const fetchMock = jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

describe('WhopProvider off-session charge (one-click upsell)', () => {
  const originalFetch = (global as any).fetch;
  afterEach(() => { (global as any).fetch = originalFetch; });

  it('charges the saved payment method with a stable idempotency key', async () => {
    const fetchMock = mockFetch(200, { id: 'pay_1', status: 'open', substatus: 'pending' });

    const result = await new WhopProvider().charge(ctx());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.whop.test/api/v1/payments');
    expect(init.headers['Idempotency-Key']).toBe('koopfy_upsell_tx-upsell-1');
    expect(JSON.parse(init.body)).toMatchObject({
      account_id: 'biz_123',
      member_id: 'mber_1',
      payment_method_id: 'payt_1',
      plan: { currency: 'usd', initial_price: 49, plan_type: 'one_time' },
      metadata: {
        koopfy_transaction_id: 'tx-upsell-1',
        koopfy_payment_type: 'upsell',
        koopfy_parent_transaction_id: 'tx-parent-1',
      },
    });
    // Nunca aprova na resposta: a Whop confirma por webhook.
    expect(result).toMatchObject({ success: true, status: 'pending', providerTransactionId: 'pay_1' });
  });

  it('reports a declined card as a failure', async () => {
    mockFetch(200, { id: 'pay_2', status: 'open', substatus: 'failed', failure_message: 'Insufficient funds' });

    const result = await new WhopProvider().charge(ctx());

    expect(result).toMatchObject({ success: false, failureMessage: 'Insufficient funds', providerTransactionId: 'pay_2' });
  });

  it('hands the bank challenge link back when 3DS is required', async () => {
    mockFetch(200, { id: 'pay_3', status: 'open', substatus: 'pending', recovery_url: 'https://whop.com/recover/pay_3' });

    const result = await new WhopProvider().charge(ctx());

    expect(result).toMatchObject({
      success: true,
      status: 'requires_action',
      redirectUrl: 'https://whop.com/recover/pay_3',
    });
  });

  it('surfaces the API error message', async () => {
    mockFetch(422, { error: { message: 'Payment method not attached to member' } });

    const result = await new WhopProvider().charge(ctx());

    expect(result).toMatchObject({ success: false, failureMessage: 'Payment method not attached to member' });
  });

  it('keeps the regular embedded checkout when there is no saved payment method', async () => {
    const fetchMock = mockFetch(200, { id: 'ch_1', purchase_url: '/checkout/plan_1?session=ch_1' });

    await new WhopProvider().charge(ctx({ offSession: undefined }));

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.whop.test/api/v1/checkout_configurations');
  });
});

describe('WhopProvider off-session charge — recusa da API', () => {
  const originalFetch = (global as any).fetch;
  afterEach(() => { (global as any).fetch = originalFetch; });

  it('keeps the provider error code and what was sent, not just the generic message', async () => {
    mockFetch(422, {
      error: {
        type: 'invalid_request_error',
        code: 'payment_method_not_reusable',
        message: 'We could not process this payment request right now. Please try again later.',
      },
    });

    const result = await new WhopProvider().charge(ctx());

    expect(result.success).toBe(false);
    expect(result.failureMessage).toContain('could not process');
    expect(result.data).toMatchObject({
      http_status: 422,
      whop_error: { code: 'payment_method_not_reusable' },
      request: {
        account_id: 'biz_123',
        member_id: 'mber_1',
        payment_method_id: 'payt_1',
      },
    });
    expect((result.data as any).request.plan).toEqual(
      expect.arrayContaining(['currency', 'initial_price', 'plan_type']),
    );
  });
});
