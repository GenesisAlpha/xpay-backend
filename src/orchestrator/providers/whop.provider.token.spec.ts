jest.mock('../../lib/supabase.client', () => ({ supabase: {} }));

import { WhopProvider } from './whop.provider';

// Whop Elements: o navegador gera um `ctok_` com o método escolhido (Pix, cartão,
// Apple/Google Pay) e o provider confirma com POST /api/v1/payments — sem
// checkout configuration. O `client_secret` volta pro navegador concluir o passo
// do comprador (QR do Pix, 3DS); quem aprova é o webhook payment.succeeded.

function ctx(overrides: Record<string, any> = {}) {
  return {
    amount: 34348,
    currency: 'BRL',
    transactionId: 'tx-token-1',
    method: 'pix',
    sellerId: 'seller-1',
    metadata: {
      order_number: 'K-20',
      product_id: 'prod-1',
      product_title: 'Relógio',
      redirect_url: 'https://checkout.koopfy.com/payment-result?orderId=K-20',
    },
    providerConfig: {
      id: 'whop_main',
      apiKey: 'whop-key',
      api_url: 'https://api.whop.test',
      config: { company_id: 'biz_123' },
    },
    confirmation_token: 'ctok_abc',
    ...overrides,
  };
}

function mockFetch(status: number, body: any) {
  const fetchMock = jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

describe('WhopProvider confirmation token charge (Whop Elements)', () => {
  const originalFetch = (global as any).fetch;
  afterEach(() => { (global as any).fetch = originalFetch; });

  it('confirms the token with an inline plan and returns the client secret', async () => {
    const fetchMock = mockFetch(200, {
      id: 'pay_1', status: 'open', substatus: 'pending', client_secret: 'pay_1_secret_v1_x',
    });

    const result = await new WhopProvider().charge(ctx());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.whop.test/api/v1/payments');
    expect(init.headers['Idempotency-Key']).toBe('koopfy_ctok_tx-token-1');
    expect(JSON.parse(init.body)).toMatchObject({
      account_id: 'biz_123',
      confirmation_token: 'ctok_abc',
      plan: { currency: 'brl', initial_price: 343.48, plan_type: 'one_time', visibility: 'quick_link' },
      metadata: {
        koopfy_transaction_id: 'tx-token-1',
        koopfy_order_ref: 'K-20',
        koopfy_account_id: 'whop_main',
        koopfy_payment_type: 'one_time',
      },
      return_url: 'https://checkout.koopfy.com/payment-result?orderId=K-20',
    });
    // Pix/3DS: o navegador ainda tem um passo — nunca aprova na resposta.
    expect(result).toMatchObject({
      success: true,
      status: 'requires_action',
      providerTransactionId: 'pay_1',
      clientSecret: 'pay_1_secret_v1_x',
    });
  });

  it('keeps an already paid token payment pending until the webhook', async () => {
    mockFetch(200, { id: 'pay_2', status: 'paid', client_secret: 'pay_2_secret' });

    const result = await new WhopProvider().charge(ctx());

    expect(result).toMatchObject({ success: true, status: 'pending', clientSecret: 'pay_2_secret' });
  });

  it('reports a declined payment as a failure', async () => {
    mockFetch(200, { id: 'pay_3', status: 'open', substatus: 'failed', failure_message: 'Card declined' });

    const result = await new WhopProvider().charge(ctx({ method: 'card' }));

    expect(result).toMatchObject({ success: false, failureMessage: 'Card declined', providerTransactionId: 'pay_3' });
  });

  it('surfaces the API error message', async () => {
    mockFetch(404, { error: { message: 'Confirmation token not found' } });

    const result = await new WhopProvider().charge(ctx());

    expect(result).toMatchObject({ success: false, failureMessage: 'Confirmation token not found' });
  });

  it('never sends a localhost return url to Whop', async () => {
    const fetchMock = mockFetch(200, { id: 'pay_4', status: 'open', client_secret: 'pay_4_secret' });

    await new WhopProvider().charge(ctx({
      metadata: { ...ctx().metadata, redirect_url: 'https://localhost:3002/payment-result?orderId=K-20' },
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.return_url).toMatch(/^https:\/\/[^/]*koopfy\.com\/payment-result\?orderId=K-20$/);
  });

  describe('subscriptions', () => {
    const subscriptionMetadata = (overrides: Record<string, any> = {}) => ({
      ...ctx().metadata,
      payment_type: 'subscription',
      subscription_config: { billing_period_days: 30, trial_period_days: 7 },
      pricing_plan: { id: 'monthly', currency: 'USD', initial_price: 9.9, renewal_price: 29 },
      subscription_charge: { currency: 'BRL', first_charge: 50.88, renewal_price: 149.06 },
      ...overrides,
    });

    it('charges the initial amount today and renews at the plan price after the trial', async () => {
      const fetchMock = mockFetch(200, { id: 'pay_s1', status: 'open', client_secret: 'pay_s1_secret' });

      await new WhopProvider().charge(ctx({ amount: 5088, metadata: subscriptionMetadata() }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.plan).toMatchObject({
        currency: 'brl',
        plan_type: 'renewal',
        initial_price: 50.88,
        renewal_price: 149.06,
        billing_period: 30,
        trial_period_days: 7,
      });
      expect(body.metadata.koopfy_payment_type).toBe('subscription');
    });

    it('without a trial, the first charge already includes the first renewal', async () => {
      const fetchMock = mockFetch(200, { id: 'pay_s2', status: 'open', client_secret: 'pay_s2_secret' });

      await new WhopProvider().charge(ctx({
        amount: 3890,
        currency: 'USD',
        metadata: subscriptionMetadata({
          payment_type: 'assinatura-recorrente',
          subscription_config: { billing_period_days: 30, trial_period_days: 0 },
          subscription_charge: undefined,
        }),
      }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.plan).toMatchObject({ plan_type: 'renewal', initial_price: 9.9, renewal_price: 29, trial_period_days: null });
    });

    it('refuses to guess the renewal when the plan currency differs from the charge', async () => {
      const fetchMock = mockFetch(200, {});

      const result = await new WhopProvider().charge(ctx({
        amount: 5088,
        metadata: subscriptionMetadata({ subscription_charge: undefined }),
      }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: false, failureMessage: expect.stringContaining('renovação') });
    });

    it('refuses a first charge below the renewal when there is no trial', async () => {
      const fetchMock = mockFetch(200, {});

      const result = await new WhopProvider().charge(ctx({
        amount: 2000,
        currency: 'USD',
        metadata: subscriptionMetadata({
          subscription_config: { billing_period_days: 30, trial_period_days: 0 },
          subscription_charge: undefined,
        }),
      }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: false });
    });
  });

  it('ignores a token without the ctok_ prefix and keeps the embedded checkout', async () => {
    const fetchMock = mockFetch(200, { id: 'ch_1', purchase_url: '/checkout/plan_1?session=ch_1' });

    await new WhopProvider().charge(ctx({ confirmation_token: 'not-a-token' }));

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.whop.test/api/v1/checkout_configurations');
  });
});
