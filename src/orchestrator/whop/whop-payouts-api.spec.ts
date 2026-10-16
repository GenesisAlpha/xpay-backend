import { fetchWhopPayout, mapWhopPayout, requestWhopPayout, WHOP_PAYOUT_FINAL_STATUS } from './whop-payouts-api';

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

function fetchFor(routes: Record<string, (call: Call) => { status?: number; json: any }>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: any = {}) => {
    const call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const key = Object.keys(routes).find(pattern => url.endsWith(pattern));
    if (!key) return { ok: false, status: 404, json: async () => ({ error: { message: `sem rota ${url}` } }) };
    const reply = routes[key](call);
    const status = reply.status ?? 200;
    return { ok: status < 300, status, json: async () => reply.json };
  };
  return { calls, fetchImpl };
}

const base = { apiKey: 'k', apiUrl: 'https://api.whop.test', accountId: 'biz_1', payoutMethodId: 'potk_1', amountCents: 12345, currency: 'USD', idempotencyKey: 'idem-1' };

describe('requestWhopPayout', () => {
  it('pede a cotação e manda o quote_token no POST /payouts, com Idempotency-Key no header', async () => {
    const { calls, fetchImpl } = fetchFor({
      '/api/v1/payouts/quotes': () => ({ json: { quote_token: 'pqt_1' } }),
      '/api/v1/payouts': () => ({ status: 201, json: { id: 'wdrl_1', status: 'requested', fee_amount: '1.25', markup_fee: '0.10', estimated_arrival: '2026-10-20T00:00:00Z' } }),
    });
    const result = await requestWhopPayout({ ...base, fetchImpl });

    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.whop.test/api/v1/payouts/quotes',
      'POST https://api.whop.test/api/v1/payouts',
    ]);
    expect(calls[0].headers['Idempotency-Key']).toBe('idem-1_quote');
    expect(calls[1].headers['Idempotency-Key']).toBe('idem-1');
    expect(calls[1].body).toEqual({ account_id: 'biz_1', payout_method_id: 'potk_1', amount: 123.45, currency: 'usd', quote_token: 'pqt_1' });
    expect(result).toMatchObject({ id: 'wdrl_1', status: 'requested', feeCents: 135, estimatedAt: '2026-10-20T00:00:00Z' });
  });

  it('sem cotação disponível, segue com o payout sem token', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { calls, fetchImpl } = fetchFor({
      '/api/v1/payouts/quotes': () => ({ status: 400, json: { error: { message: 'quotes not supported' } } }),
      '/api/v1/payouts': () => ({ status: 201, json: { id: 'wdrl_2', status: 'processing' } }),
    });
    const result = await requestWhopPayout({ ...base, fetchImpl });
    expect(calls[1].body.quote_token).toBeUndefined();
    expect(result).toMatchObject({ id: 'wdrl_2', status: 'processing', feeCents: 0, estimatedAt: null });
    warn.mockRestore();
  });

  it('recusa da Whop vira erro com a mensagem dela', async () => {
    const { fetchImpl } = fetchFor({
      '/api/v1/payouts/quotes': () => ({ json: { quote_token: 'pqt_1' } }),
      '/api/v1/payouts': () => ({ status: 422, json: { error: { message: 'payout account not verified', code: 'payout_account_unverified' } } }),
    });
    await expect(requestWhopPayout({ ...base, fetchImpl })).rejects.toMatchObject({ message: 'payout account not verified', status: 422, code: 'payout_account_unverified' });
  });
});

describe('fetchWhopPayout / mapWhopPayout', () => {
  it('lê GET /payouts/{id}', async () => {
    const { calls, fetchImpl } = fetchFor({ '/api/v1/payouts/wdrl_1': () => ({ json: { id: 'wdrl_1', status: 'completed', fee_amount: '2' } }) });
    await expect(fetchWhopPayout({ apiKey: 'k', apiUrl: 'https://api.whop.test', payoutId: 'wdrl_1', fetchImpl }))
      .resolves.toMatchObject({ status: 'completed', feeCents: 200 });
    expect(calls[0].method).toBe('GET');
  });

  it('ainda entende o formato antigo de /withdrawals', () => {
    expect(mapWhopPayout({ id: 'w', status: 'pending', fees: { fee_amount: '1.50', markup_fee: '0.50' }, estimated_availability: 'x' }))
      .toMatchObject({ feeCents: 200, estimatedAt: 'x' });
  });

  it('reversed é estado final', () => {
    expect(WHOP_PAYOUT_FINAL_STATUS.has('reversed')).toBe(true);
    expect(WHOP_PAYOUT_FINAL_STATUS.has('processing')).toBe(false);
  });
});
