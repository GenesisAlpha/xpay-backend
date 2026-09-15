jest.mock('../../lib/supabase.client', () => ({ supabase: {} }));

import { WhopProvider } from './whop.provider';

// Assinatura na área do cliente: cancelar no fim do período e reativar.

const account = { api_url: 'https://api.whop.test', apiKey: 'whop-key' };
const MEMBERSHIP = {
  id: 'mem_1',
  status: 'active',
  cancel_at_period_end: true,
  renewal_period_end: '2026-10-14T12:00:00.000Z',
};

function mockFetch(status: number, body: any) {
  const fetchMock = jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

describe('WhopProvider memberships', () => {
  const originalFetch = (global as any).fetch;
  afterEach(() => { (global as any).fetch = originalFetch; });

  it('cancels at the end of the paid period', async () => {
    const fetchMock = mockFetch(200, MEMBERSHIP);

    await expect(new WhopProvider().cancelMembershipAtPeriodEnd('mem_1', account)).resolves.toEqual({
      id: 'mem_1',
      status: 'active',
      cancelAtPeriodEnd: true,
      renewalPeriodEnd: '2026-10-14T12:00:00.000Z',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.whop.test/api/v1/memberships/mem_1/cancel');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer whop-key');
    expect(JSON.parse(init.body)).toEqual({ cancellation_mode: 'at_period_end' });
  });

  it('reactivates with uncancel', async () => {
    const fetchMock = mockFetch(200, { ...MEMBERSHIP, cancel_at_period_end: false });

    await expect(new WhopProvider().uncancelMembership('mem_1', account))
      .resolves.toMatchObject({ cancelAtPeriodEnd: false });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.whop.test/api/v1/memberships/mem_1/uncancel');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('reads the membership', async () => {
    const fetchMock = mockFetch(200, { ...MEMBERSHIP, status: 'past_due', renewal_period_end: null });

    await expect(new WhopProvider().getMembership('mem_1', account)).resolves.toEqual({
      id: 'mem_1', status: 'past_due', cancelAtPeriodEnd: true, renewalPeriodEnd: null,
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.whop.test/api/v1/memberships/mem_1');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('surfaces the Whop error', async () => {
    mockFetch(403, { error: { message: 'Missing permission membership:cancel' } });

    await expect(new WhopProvider().cancelMembershipAtPeriodEnd('mem_1', account))
      .rejects.toThrow('Missing permission membership:cancel');
  });
});
