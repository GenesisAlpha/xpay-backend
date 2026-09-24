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

// A cobrança do cartão salvo cria o plano antes (ver ensureOneTimePlan): o plano
// responde sozinho e a resposta do teste vale para a cobrança.
function mockFetch(status: number, body: any) {
  const fetchMock = jest.fn().mockImplementation((url: string) =>
    String(url).includes('/api/v1/plans')
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'plan_test' }) })
      : Promise.resolve({ ok: status < 400, status, json: async () => body }),
  );
  (global as any).fetch = fetchMock;
  return fetchMock;
}

/** O cache de planos é estático — sem limpar, um teste esconde a criação no outro. */
beforeEach(() => { (WhopProvider as any).planCache?.clear() });

/** A chamada da cobrança, ignorando a criação do plano. */
function paymentCall(fetchMock: jest.Mock) {
  return fetchMock.mock.calls.find(([url]) => String(url).includes('/api/v1/payments'))
    ?? fetchMock.mock.calls[0];
}

describe('WhopProvider off-session charge (one-click upsell)', () => {
  const originalFetch = (global as any).fetch;
  afterEach(() => { (global as any).fetch = originalFetch; });

  it('charges the saved payment method with a stable idempotency key', async () => {
    const fetchMock = mockFetch(200, { id: 'pay_1', status: 'open', substatus: 'pending' });

    const result = await new WhopProvider().charge(ctx());

    const [url, init] = paymentCall(fetchMock);
    expect(url).toBe('https://api.whop.test/api/v1/payments');
    expect(init.headers['Idempotency-Key']).toBe('koopfy_upsell_tx-upsell-1');
    expect(JSON.parse(init.body)).toMatchObject({
      account_id: 'biz_123',
      member_id: 'mber_1',
      payment_method_id: 'payt_1',
      plan_id: 'plan_test',
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
    expect((result.data as any).request).toMatchObject({ via: 'plan_id', plan_id: 'plan_test' });
  });
});

describe('WhopProvider off-session charge — forma do plano', () => {
  const originalFetch = (global as any).fetch;
  afterEach(() => { (global as any).fetch = originalFetch; });

  it('sends the same plan shape the checkout uses, with title and visibility', async () => {
    const fetchMock = mockFetch(200, { id: 'pay_1', status: 'open', substatus: 'pending' });

    await new WhopProvider().charge(ctx());

    // O plano virou recurso próprio: a forma que a Whop aceita está na criação.
    const planCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/v1/plans'));
    const plan = JSON.parse(planCall![1].body);
    expect(plan).toMatchObject({
      currency: 'usd',
      plan_type: 'one_time',
      visibility: 'quick_link',
    });
    expect(typeof plan.title).toBe('string');
    expect(plan.title.length).toBeGreaterThan(0);
  });
});

describe('WhopProvider.isSavedMethodChargeable', () => {
  const originalFetch = (global as any).fetch;
  afterEach(() => { (global as any).fetch = originalFetch; });

  const args = {
    apiUrl: 'https://api.whop.test',
    apiKey: 'whop-key',
    memberId: 'mber_1',
    paymentMethodId: 'payt_1',
  };

  it('asks the provider only for methods usable off session', async () => {
    const fetchMock = mockFetch(200, { data: [{ id: 'payt_1' }] });

    await expect(new WhopProvider().isSavedMethodChargeable(args)).resolves.toBe(true);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/v1/payment_methods');
    expect(url).toContain('member_id=mber_1');
    expect(url).toContain('future_usage=off_session');
  });

  it('reports a card the provider will not reuse', async () => {
    mockFetch(200, { data: [{ id: 'payt_outro' }] });
    await expect(new WhopProvider().isSavedMethodChargeable(args)).resolves.toBe(false);
  });

  it('stays silent when the lookup itself fails, instead of killing the offer', async () => {
    mockFetch(500, { error: { message: 'boom' } });
    await expect(new WhopProvider().isSavedMethodChargeable(args)).resolves.toBeNull();
  });
});


// A rota de cartão salvo recusa plano inline com 400 sem dizer o campo; o guia
// da Whop manda criar o plano e cobrar por id.
describe('WhopProvider off-session charge — plano por id', () => {
  const originalFetch = (global as any).fetch;
  afterEach(() => { (global as any).fetch = originalFetch; });

  function fetchSeq(responses: Array<{ status: number; body: any }>) {
    const calls: any[] = [];
    const mock = jest.fn().mockImplementation((url: string, init: any) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      const next = responses.shift() ?? { status: 200, body: {} };
      return Promise.resolve({ ok: next.status < 400, status: next.status, json: async () => next.body });
    });
    (global as any).fetch = mock;
    return calls;
  }

  it('cria o plano e cobra por plan_id, sem plano inline', async () => {
    const calls = fetchSeq([
      { status: 200, body: { id: 'plan_123' } },
      { status: 200, body: { id: 'pay_1', status: 'open', substatus: 'pending' } },
    ]);

    const result = await new WhopProvider().charge(ctx());

    expect(result.success).toBe(true);
    expect(calls[0].url).toContain('/api/v1/plans');
    expect(calls[0].body).toMatchObject({ plan_type: 'one_time', currency: 'usd' });
    expect(calls[1].url).toContain('/api/v1/payments');
    expect(calls[1].body).toMatchObject({ plan_id: 'plan_123', member_id: 'mber_1' });
    expect(calls[1].body.plan).toBeUndefined();
  });

  it('plano recusado não derruba a cobrança: volta ao plano inline', async () => {
    const calls = fetchSeq([
      { status: 422, body: { error: { message: 'nope' } } },
      { status: 200, body: { id: 'pay_1', status: 'open', substatus: 'pending' } },
    ]);

    const result = await new WhopProvider().charge(ctx({ transactionId: 'tx-upsell-2' }));

    expect(result.success).toBe(true);
    expect(calls[1].body.plan_id).toBeUndefined();
    expect(calls[1].body.plan).toMatchObject({ plan_type: 'one_time' });
  });
});
