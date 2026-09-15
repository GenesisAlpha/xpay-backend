jest.mock('../../lib/supabase.client', () => ({ supabase: {} }));

import { WhopProvider } from './whop.provider';

// Conta conectada: a venda nasce na conta do seller (account_id = biz_ dele),
// então a disputa conta lá. A application fee pede o valor inteiro menos 1
// centavo: o dinheiro vem para a master e vai ao seller na liberação.

function ctx(overrides: Record<string, any> = {}) {
  return {
    amount: 34348,
    currency: 'BRL',
    transactionId: 'tx-conn-1',
    method: 'pix',
    sellerId: 'seller-1',
    metadata: {
      order_number: 'K-30',
      product_id: 'prod-1',
      product_title: 'Relógio',
      redirect_url: 'https://checkout.koopfy.com/payment-result?orderId=K-30',
    },
    providerConfig: {
      id: 'whopc_biz_seller',
      apiKey: 'whop-key',
      api_url: 'https://api.whop.test',
      config: { company_id: 'biz_seller', connected: true, seller_id: 'seller-1' },
    },
    ...overrides,
  };
}

function mockFetch(status: number, body: any) {
  const fetchMock = jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

describe('WhopProvider em conta conectada', () => {
  const originalFetch = (global as any).fetch;
  afterEach(() => { (global as any).fetch = originalFetch; });

  it('token do Elements: cobra na conta do seller e traz o valor para a master', async () => {
    const fetchMock = mockFetch(200, { id: 'pay_1', status: 'open', substatus: 'pending', client_secret: 's' });

    const result = await new WhopProvider().charge(ctx({ confirmation_token: 'ctok_abc' }));

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.whop.test/api/v1/payments');
    expect(JSON.parse(init.body)).toMatchObject({
      account_id: 'biz_seller',
      plan: { currency: 'brl', initial_price: 343.48, application_fee_amount: 343.47 },
      metadata: { koopfy_account_id: 'whopc_biz_seller', koopfy_seller_id: 'seller-1' },
    });
  });

  it('checkout configuration: plano inline da conta do seller leva a fee', async () => {
    const fetchMock = mockFetch(200, { id: 'ch_1', purchase_url: 'https://whop.com/checkout/ch_1', plan: { id: 'plan_1' } });

    const result = await new WhopProvider().charge(ctx());

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.whop.test/api/v1/checkout_configurations');
    // Mesma chave (da master); a conta conectada vai no account_id do topo.
    expect(init.headers.Authorization).toBe('Bearer whop-key');
    expect(JSON.parse(init.body).account_id).toBe('biz_seller');
    expect(JSON.parse(init.body).plan).toMatchObject({
      company_id: 'biz_seller',
      initial_price: 343.48,
      application_fee_amount: 343.47,
    });
  });

  it('upsell de um clique: cartão salvo na conta do seller leva a fee', async () => {
    const fetchMock = mockFetch(200, { id: 'pay_2', status: 'open', substatus: 'pending' });

    const result = await new WhopProvider().charge(ctx({
      offSession: { memberId: 'mber_1', paymentMethodId: 'payt_1', parentTransactionId: 'tx-parent' },
    }));

    expect(result.success).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      account_id: 'biz_seller',
      member_id: 'mber_1',
      plan: { initial_price: 343.48, application_fee_amount: 343.47 },
    });
  });

  it('valor que não comporta a fee não é cobrado', async () => {
    const fetchMock = mockFetch(200, {});

    const result = await new WhopProvider().charge(ctx({ amount: 1, confirmation_token: 'ctok_abc' }));

    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('conta da master não manda application fee', async () => {
    const fetchMock = mockFetch(200, { id: 'pay_3', status: 'open', substatus: 'pending', client_secret: 's' });

    await new WhopProvider().charge(ctx({
      confirmation_token: 'ctok_abc',
      providerConfig: { id: 'whop_main', apiKey: 'whop-key', api_url: 'https://api.whop.test', config: { company_id: 'biz_master' } },
    }));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).plan).not.toHaveProperty('application_fee_amount');
  });
});
