// PayPal da conta do seller sem rede: o corpo da order (sem nome de produto,
// custom_id = transação), o pedido de verificação do webhook e o cache do
// token OAuth por conta.

import {
  PAYPAL_LIVE_URL,
  PAYPAL_SANDBOX_URL,
  PaypalTokenCache,
  buildPaypalOrderPayload,
  buildPaypalVerifyRequest,
  extractPaypalCapture,
  paypalBaseUrl,
  paypalCall,
} from './paypal-api';

describe('buildPaypalOrderPayload', () => {
  const payload = buildPaypalOrderPayload({
    transactionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    orderRef: '1042',
    storeName: 'Loja Bonita',
    amountCents: 4990,
    currency: 'brl',
  });
  const unit = payload.purchase_units[0];

  it('captura imediata, custom_id = transação e invoice_id = pedido', () => {
    expect(payload.intent).toBe('CAPTURE');
    expect(unit.custom_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(unit.invoice_id).toBe('1042');
    expect(unit.amount).toEqual({ currency_code: 'BRL', value: '49.90' });
  });

  it('descrição é loja + pedido, sem nada do catálogo', () => {
    expect(unit.description).toBe('Loja Bonita · #1042');
    const withProduct = buildPaypalOrderPayload({
      transactionId: 'tx',
      orderRef: '7',
      storeName: 'Loja',
      amountCents: 100,
      currency: 'USD',
      // Campos que o checkout manda no dto e não podem vazar.
      ...({ product_name: 'Curso Secreto', offer_name: 'Oferta X' } as any),
    });
    expect(JSON.stringify(withProduct)).not.toContain('Curso Secreto');
    expect(JSON.stringify(withProduct)).not.toContain('Oferta X');
    expect(JSON.stringify(payload)).not.toMatch(/items/);
  });

  it('sem pedido usa a transação; sufixo quando o invoice repetiu', () => {
    const p = buildPaypalOrderPayload({ transactionId: 'tx-1', amountCents: 1000, currency: 'JPY', invoiceSuffix: 'abc' });
    expect(p.purchase_units[0].invoice_id).toBe('tx-1-abc');
    expect(p.purchase_units[0].amount).toEqual({ currency_code: 'JPY', value: '10' });
  });

  it('sem frete no PayPal e marca da loja no botão', () => {
    expect(payload.application_context).toEqual({
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      brand_name: 'Loja Bonita',
    });
  });
});

describe('buildPaypalVerifyRequest', () => {
  it('monta o corpo do verify-webhook-signature com o webhook_id da conta', () => {
    const event = { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1' } };
    const body = buildPaypalVerifyRequest(
      {
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT',
        'paypal-transmission-id': 'tid-1',
        'paypal-transmission-sig': 'sig==',
        'paypal-transmission-time': '2026-09-28T12:00:00Z',
      },
      'WEBHOOK-ID-DA-CONTA',
      event,
    );
    expect(body).toEqual({
      auth_algo: 'SHA256withRSA',
      cert_url: 'https://api.paypal.com/v1/notifications/certs/CERT',
      transmission_id: 'tid-1',
      transmission_sig: 'sig==',
      transmission_time: '2026-09-28T12:00:00Z',
      webhook_id: 'WEBHOOK-ID-DA-CONTA',
      webhook_event: event,
    });
  });
});

describe('paypalBaseUrl', () => {
  it('sandbox só no modo test', () => {
    expect(paypalBaseUrl('test')).toBe(PAYPAL_SANDBOX_URL);
    expect(paypalBaseUrl('live')).toBe(PAYPAL_LIVE_URL);
    expect(paypalBaseUrl(undefined)).toBe(PAYPAL_LIVE_URL);
  });
});

describe('token OAuth por conta', () => {
  const creds = { cacheKey: 'paypall_1', clientId: 'client-id', clientSecret: 'client-secret', mode: 'test' };

  it('pede com client credentials no host do modo e reaproveita até vencer', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-1', expires_in: 32400, app_id: 'APP-1' }) };
    };
    const cache = new PaypalTokenCache(fetchImpl as any);

    const first = await cache.get(creds);
    const second = await cache.get(creds);

    expect(first).toEqual({ token: 'tok-1', appId: 'APP-1' });
    expect(second.token).toBe('tok-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${PAYPAL_SANDBOX_URL}/v1/oauth2/token`);
    expect(calls[0].init.body).toBe('grant_type=client_credentials');
    expect(calls[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
  });

  it('token perto de vencer, ou credencial trocada, pede outro', async () => {
    let n = 0;
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ access_token: `tok-${++n}`, expires_in: 30 }) });
    const cache = new PaypalTokenCache(fetchImpl as any);
    await cache.get(creds);
    // expires_in 30 s < margem de 60 s: nunca reaproveita.
    expect((await cache.get(creds)).token).toBe('tok-2');
  });

  it('credencial recusada vira erro com o status do PayPal', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client', error_description: 'Client Authentication failed' }) });
    const cache = new PaypalTokenCache(fetchImpl as any);
    await expect(cache.get(creds)).rejects.toMatchObject({ httpStatus: 401, message: 'Client Authentication failed' });
  });

  it('401 numa chamada renova o token uma vez', async () => {
    let tokens = 0;
    const tokenFetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: `tok-${++tokens}`, expires_in: 32400 }) });
    const cache = new PaypalTokenCache(tokenFetch as any);
    const seen: string[] = [];
    const apiFetch = async (_url: string, init: any) => {
      seen.push(init.headers.Authorization);
      return seen.length === 1
        ? { ok: false, status: 401, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ id: 'ORDER-1' }) };
    };
    const result = await paypalCall(creds, 'GET', '/v2/checkout/orders/ORDER-1', undefined, {}, cache, apiFetch as any);
    expect(result).toEqual({ id: 'ORDER-1' });
    expect(seen).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });
});

describe('extractPaypalCapture', () => {
  it('lê a captura da resposta do /capture', () => {
    const capture = extractPaypalCapture({
      id: 'ORDER-1',
      status: 'COMPLETED',
      purchase_units: [{
        payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', custom_id: 'tx-1', amount: { value: '49.90', currency_code: 'BRL' } }] },
      }],
    });
    expect(capture).toEqual({
      orderStatus: 'COMPLETED',
      captureId: 'CAP-1',
      captureStatus: 'COMPLETED',
      customId: 'tx-1',
      value: '49.90',
      currency: 'BRL',
      reason: null,
    });
  });
});
