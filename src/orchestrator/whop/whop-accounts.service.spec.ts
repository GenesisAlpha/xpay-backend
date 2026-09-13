// Modo env da Whop: com WHOP_API_KEY, a conta vem do env e a tabela é ignorada.

const fromMock = jest.fn();
jest.mock('../../lib/supabase.client', () => ({
  supabase: { from: (...args: any[]) => fromMock(...args) },
}));

import { WhopAccountsService, WHOP_ENV_ACCOUNT_ID } from './whop-accounts.service';

const ENV_KEYS = ['WHOP_API_KEY', 'WHOP_COMPANY_ID', 'WHOP_WEBHOOK_SECRET', 'WHOP_PRODUCT_ID', 'WHOP_LEGAL_NAME', 'WHOP_API_URL'];

describe('WhopAccountsService — conta do env', () => {
  const original = { ...process.env };
  let fetchMock: jest.Mock;

  const service = () => new WhopAccountsService({ decrypt: (v: string) => v } as any);

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    fromMock.mockReset();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...original };
    jest.restoreAllMocks();
  });

  const companyResponse = (body: any, ok = true) => ({
    ok,
    status: ok ? 200 : 401,
    json: async () => body,
  });

  it('descobre a company pela chave e monta a conta sem ler a tabela', async () => {
    process.env.WHOP_API_KEY = 'apik_test';
    process.env.WHOP_WEBHOOK_SECRET = 'ws_secret';
    fetchMock.mockResolvedValue(companyResponse({ id: 'biz_123', title: 'Koopfy' }));

    const accounts = await service().listActive();

    expect(fromMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.whop.com/api/v5/company',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer apik_test' }) }),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: WHOP_ENV_ACCOUNT_ID,
      provider: 'whop',
      status: 'active',
      supported_methods: ['all'],
      apiKey: 'apik_test',
      config: { company_id: 'biz_123', webhook_secret: 'ws_secret', label: 'Koopfy' },
    });
  });

  it('WHOP_COMPANY_ID dispensa a chamada à API', async () => {
    process.env.WHOP_API_KEY = 'apik_test';
    process.env.WHOP_COMPANY_ID = 'biz_env';

    const [account] = await service().listActive();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(account.config?.company_id).toBe('biz_env');
  });

  it('getById do id do env devolve a conta com o segredo do webhook', async () => {
    process.env.WHOP_API_KEY = 'apik_test';
    process.env.WHOP_COMPANY_ID = 'biz_env';
    process.env.WHOP_WEBHOOK_SECRET = 'ws_secret';

    const svc = service();

    await expect(svc.getWebhookSecret(WHOP_ENV_ACCOUNT_ID)).resolves.toBe('ws_secret');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('sem segredo a conta existe (cobra), mas getWebhookSecret é null', async () => {
    process.env.WHOP_API_KEY = 'apik_test';
    process.env.WHOP_COMPANY_ID = 'biz_env';

    const svc = service();

    await expect(svc.listActive()).resolves.toHaveLength(1);
    await expect(svc.getWebhookSecret(WHOP_ENV_ACCOUNT_ID)).resolves.toBeNull();
  });

  it('falha ao descobrir a company não fica cacheada', async () => {
    process.env.WHOP_API_KEY = 'apik_test';
    fetchMock
      .mockResolvedValueOnce(companyResponse({ message: 'unauthorized' }, false))
      .mockResolvedValueOnce(companyResponse({ id: 'biz_123', title: 'Koopfy' }));

    const svc = service();

    await expect(svc.listActive()).resolves.toEqual([]);
    const [account] = await svc.listActive();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(account.config?.company_id).toBe('biz_123');
  });

  it('descobre a company uma vez só por processo', async () => {
    process.env.WHOP_API_KEY = 'apik_test';
    fetchMock.mockResolvedValue(companyResponse({ id: 'biz_123', title: 'Koopfy' }));

    const svc = service();
    await Promise.all([svc.listActive(), svc.listActive(), svc.getById(WHOP_ENV_ACCOUNT_ID)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sem WHOP_API_KEY continua lendo o pool da tabela', async () => {
    const eq = jest.fn().mockResolvedValue({ data: [], error: null });
    fromMock.mockReturnValue({ select: () => ({ eq }) });

    await expect(service().listActive()).resolves.toEqual([]);
    expect(fromMock).toHaveBeenCalledWith('whop_accounts');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
