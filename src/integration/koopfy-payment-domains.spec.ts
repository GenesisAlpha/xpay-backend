import { WhopApiError } from '../orchestrator/whop/whop-platform.client';
import { KoopfyPaymentDomainsService, normalizeHostname } from './koopfy-payment-domains.service';

jest.mock('../lib/supabase.client', () => ({ supabase: {} }));
jest.mock('../orchestrator/whop/whop-connect.service', () => ({ WhopConnectService: class {} }));
jest.mock('../orchestrator/whop/whop-linked.service', () => ({ WhopLinkedAccountsService: class {} }));

const ctx: any = { userId: 'u', email: 'a@b.com', seller: { id: 'seller-1', status: 'approved', kyc_status: null } };

function setup(opts: { connected?: string | null; linked?: boolean; domains?: Record<string, any[]> } = {}) {
  const domains = opts.domains ?? {};
  const whop: any = {
    isConfigured: () => true,
    getAccount: jest.fn(async () => ({ id: 'biz_master' })),
    listPaymentMethodDomains: jest.fn(async (accountId: string | null) => ({ data: domains[accountId ?? 'master'] ?? [] })),
    createPaymentMethodDomain: jest.fn(async (hostname: string, accountId: string | null) => ({ id: `pmd_${accountId ?? 'master'}`, hostname, account_id: accountId ?? 'biz_master', status: 'pending' })),
    verifyPaymentMethodDomain: jest.fn(async (id: string) => ({ id, status: 'verified' })),
  };
  const connect: any = { getRow: jest.fn(async () => opts.connected ? { whop_account_id: opts.connected } : null) };
  const linked: any = { getRow: jest.fn(async () => opts.linked ? { whop_account_id: 'biz_own', api_key: 'k' } : null) };
  return { whop, service: new KoopfyPaymentDomainsService(whop, connect, linked) };
}

describe('KoopfyPaymentDomainsService', () => {
  it('normaliza o domínio e recusa os da Koopfy/Whop', () => {
    expect(normalizeHostname(' https://WWW.Loja.com.br/pagina ')).toBe('www.loja.com.br');
    expect(() => normalizeHostname('checkout.koopfy.com')).toThrow();
    expect(() => normalizeHostname('localhost')).toThrow();
  });

  it('conta conectada: registra na conectada e na master e verifica', async () => {
    const { whop, service } = setup({ connected: 'biz_seller' });
    const result = await service.register(ctx, 'loja.com');
    expect(whop.createPaymentMethodDomain).toHaveBeenCalledWith('loja.com', 'biz_seller', 'pmd:biz_seller:loja.com');
    expect(whop.createPaymentMethodDomain).toHaveBeenCalledWith('loja.com', null, 'pmd:master:loja.com');
    expect(result.registrations.map(r => [r.scope, r.status])).toEqual([['connected', 'verified'], ['master', 'verified']]);
  });

  it('sem conta conectada: só a master', async () => {
    const { service } = setup();
    const result = await service.register(ctx, 'loja.com');
    expect(result.registrations.map(r => r.scope)).toEqual(['master']);
  });

  it('já registrado: não cria de novo, só tenta verificar', async () => {
    const { whop, service } = setup({ connected: 'biz_seller', domains: { biz_seller: [{ id: 'pmd_1', hostname: 'loja.com', account_id: 'biz_seller', status: 'pending' }] } });
    await service.register(ctx, 'loja.com');
    expect(whop.createPaymentMethodDomain).not.toHaveBeenCalledWith('loja.com', 'biz_seller', expect.anything());
    expect(whop.verifyPaymentMethodDomain).toHaveBeenCalledWith('pmd_1');
  });

  it('verificação recusada fica pendente com o motivo da Whop', async () => {
    const { whop, service } = setup();
    whop.verifyPaymentMethodDomain.mockRejectedValue(new WhopApiError('Association file not found', 400, 'bad_request', null));
    const result = await service.register(ctx, 'loja.com');
    expect(result.registrations[0]).toMatchObject({ status: 'pending', message: 'Association file not found' });
  });

  it('domínio da master não confunde com o de uma conta conectada', async () => {
    const { whop, service } = setup({ domains: { master: [{ id: 'pmd_filha', hostname: 'loja.com', account_id: 'biz_outro', status: 'verified' }] } });
    await service.register(ctx, 'loja.com');
    expect(whop.createPaymentMethodDomain).toHaveBeenCalledWith('loja.com', null, 'pmd:master:loja.com');
  });

  it('conta Whop própria: não registra (painel do seller)', async () => {
    const { whop, service } = setup({ linked: true });
    const result = await service.register(ctx, 'loja.com');
    expect(result.mode).toBe('external');
    expect(whop.createPaymentMethodDomain).not.toHaveBeenCalled();
  });
});
