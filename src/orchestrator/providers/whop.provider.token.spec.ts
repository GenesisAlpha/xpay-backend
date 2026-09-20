jest.mock('../../lib/supabase.client', () => ({ supabase: {} }));

import { WhopProvider, whopTokenIdempotencyKey } from './whop.provider';

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
    expect(init.headers['Idempotency-Key']).toBe(whopTokenIdempotencyKey('tx-token-1', 'ctok_abc'));
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

  it('uses a new idempotency key when the buyer retries with another token', async () => {
    // A mesma transação é reaproveitada na nova tentativa. Com a chave só da
    // transação, a Whop recusava o 2º token ("Idempotency-Key was already used
    // with a different request") e o comprador não conseguia pagar.
    const fetchMock = mockFetch(200, { id: 'pay_2', status: 'open', substatus: 'pending', client_secret: 's' });
    await new WhopProvider().charge(ctx({ confirmation_token: 'ctok_first' }));
    await new WhopProvider().charge(ctx({ confirmation_token: 'ctok_second' }));
    await new WhopProvider().charge(ctx({ confirmation_token: 'ctok_second' }));

    const keys = fetchMock.mock.calls.map(([, init]) => init.headers['Idempotency-Key']);
    expect(keys[0]).not.toBe(keys[1]);
    // Retry de rede do mesmo token: mesma chave, a Whop não cobra duas vezes.
    expect(keys[1]).toBe(keys[2]);
    expect(keys[0]).toMatch(/^koopfy_ctok_tx-token-1_[0-9a-f]{16}$/);
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

  it('keeps the decline code so the checkout can explain it', async () => {
    mockFetch(200, { id: 'pay_4', status: 'open', substatus: 'failed', failure_message: 'Insufficient funds', decline_code: 'insufficient_funds' });

    const result = await new WhopProvider().charge(ctx({ method: 'card' }));

    expect(result).toMatchObject({ success: false, failureCode: 'insufficient_funds' });
  });

  it('keeps the decline code of an API error', async () => {
    mockFetch(402, { error: { message: 'Your card has expired.', code: 'card_declined', decline_code: 'expired_card' } });

    const result = await new WhopProvider().charge(ctx());

    expect(result).toMatchObject({ success: false, failureMessage: 'Your card has expired.', failureCode: 'expired_card' });
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

    it('valor inicial menor que a mensalidade, sem teste: cobra o inicial hoje e renova depois de um ciclo', async () => {
      const fetchMock = mockFetch(200, { id: 'pay_s3', status: 'open', client_secret: 'pay_s3_secret' });

      await new WhopProvider().charge(ctx({
        amount: 990,
        currency: 'USD',
        metadata: subscriptionMetadata({
          subscription_config: { billing_period_days: 30, trial_period_days: 0 },
          subscription_charge: undefined,
        }),
      }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.plan).toMatchObject({ initial_price: 9.9, renewal_price: 29, billing_period: 30, trial_period_days: 30 });
    });

    it('valor inicial maior que a mensalidade, sem teste: a Whop cobra só o inicial hoje', async () => {
      const fetchMock = mockFetch(200, { id: 'pay_s4', status: 'open', client_secret: 'pay_s4_secret' });

      await new WhopProvider().charge(ctx({
        amount: 9700,
        currency: 'USD',
        metadata: subscriptionMetadata({
          subscription_config: { billing_period_days: 30, trial_period_days: 0 },
          pricing_plan: { id: 'monthly', currency: 'USD', initial_price: 97, renewal_price: 47 },
          subscription_charge: undefined,
        }),
      }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // A Whop soma: 50 + 47 = 97 na compra; 47 a cada 30 dias.
      expect(body.plan).toMatchObject({ initial_price: 50, renewal_price: 47, billing_period: 30, trial_period_days: null });
    });

    it('sem valor inicial, cobrança abaixo da mensalidade continua recusada', async () => {
      const fetchMock = mockFetch(200, {});

      const result = await new WhopProvider().charge(ctx({
        amount: 2000,
        currency: 'USD',
        metadata: subscriptionMetadata({
          subscription_config: { billing_period_days: 30, trial_period_days: 0 },
          pricing_plan: { id: 'monthly', currency: 'USD', initial_price: 0, renewal_price: 29 },
          subscription_charge: undefined,
        }),
      }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: false });
    });
  });

  describe('assinatura no checkout embutido', () => {
    const meta = (plan: Record<string, any>) => ({
      ...ctx().metadata,
      payment_type: 'subscription',
      subscription_config: { billing_period_days: 30, trial_period_days: 0 },
      pricing_plan: { id: 'monthly', currency: 'USD', ...plan },
    });

    it('ciclo de teste do valor inicial pede plano novo na Whop', async () => {
      const fetchMock = mockFetch(200, { id: 'ch_1', purchase_url: '/checkout/plan_1?session=ch_1' });

      await new WhopProvider().charge(ctx({
        confirmation_token: 'not-a-token', amount: 990, currency: 'USD',
        metadata: meta({ initial_price: 9.9, renewal_price: 29 }),
      }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.plan).toMatchObject({ initial_price: 9.9, trial_period_days: 30, force_create_new_plan: true });
    });

    it('sem ciclo de teste, o plano com os mesmos termos é reaproveitado', async () => {
      const fetchMock = mockFetch(200, { id: 'ch_2', purchase_url: '/checkout/plan_2?session=ch_2' });

      await new WhopProvider().charge(ctx({
        confirmation_token: 'not-a-token', amount: 9700, currency: 'USD',
        metadata: meta({ initial_price: 97, renewal_price: 47 }),
      }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.plan).toMatchObject({ initial_price: 50, trial_period_days: null, force_create_new_plan: false });
    });
  });

  it('ignores a token without the ctok_ prefix and keeps the embedded checkout', async () => {
    const fetchMock = mockFetch(200, { id: 'ch_1', purchase_url: '/checkout/plan_1?session=ch_1' });

    await new WhopProvider().charge(ctx({ confirmation_token: 'not-a-token' }));

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.whop.test/api/v1/checkout_configurations');
  });
});

describe('produto por loja na cobrança', () => {
  const originalFetch = (global as any).fetch;
  afterEach(() => { (global as any).fetch = originalFetch; });

  it('manda o produto da loja do pedido, com o nome da loja', async () => {
    const fetchMock = mockFetch(200, { id: 'pay_2', status: 'open', client_secret: 'pay_2_secret_v1_x' });
    await new WhopProvider().charge(ctx({
      metadata: { ...ctx().metadata, workspace_id: 'ws-77', store_name: 'Loja do Iago' },
    }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.plan.product).toEqual({ external_identifier: 'koopfy_ws-77', title: 'Loja do Iago' });
  });

  it('pedido sem loja continua no produto antigo', async () => {
    const fetchMock = mockFetch(200, { id: 'pay_3', status: 'open', client_secret: 'pay_3_secret_v1_x' });
    await new WhopProvider().charge(ctx());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.plan.product.external_identifier).toBe('koopfy');
  });
});
