import { lookupWhopCompany } from './whop-company';

function fetchFor(replies: Record<string, { status: number; json: any }>) {
  const urls: string[] = [];
  const fetchImpl = async (url: string) => {
    urls.push(url);
    const reply = replies[url.replace('https://api.whop.test', '')] ?? { status: 404, json: {} };
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.json };
  };
  return { urls, fetchImpl };
}

describe('lookupWhopCompany', () => {
  it('resolve pela rota legada quando ela responde', async () => {
    const { urls, fetchImpl } = fetchFor({ '/api/v5/company': { status: 200, json: { id: 'biz_1', title: 'Loja' } } });
    await expect(lookupWhopCompany('k', 'https://api.whop.test', fetchImpl)).resolves.toMatchObject({ ok: true, route: 'v5', company: { id: 'biz_1', title: 'Loja' } });
    expect(urls).toHaveLength(1);
  });

  it('cai para /accounts/me quando a legada sumir (404/410)', async () => {
    const { urls, fetchImpl } = fetchFor({
      '/api/v5/company': { status: 410, json: { error: { type: 'gone' } } },
      '/api/v1/accounts/me': { status: 200, json: { id: 'biz_2', title: 'Loja 2' } },
    });
    await expect(lookupWhopCompany('k', 'https://api.whop.test', fetchImpl)).resolves.toMatchObject({ ok: true, route: 'v1', company: { id: 'biz_2', title: 'Loja 2' } });
    expect(urls).toEqual(['https://api.whop.test/api/v5/company', 'https://api.whop.test/api/v1/accounts/me']);
  });

  it('chave recusada não tenta a segunda rota', async () => {
    const { urls, fetchImpl } = fetchFor({ '/api/v5/company': { status: 401, json: { error: { message: 'Invalid or missing API key' } } } });
    await expect(lookupWhopCompany('k', 'https://api.whop.test', fetchImpl)).resolves.toMatchObject({ ok: false, status: 401, company: null });
    expect(urls).toHaveLength(1);
  });
});
