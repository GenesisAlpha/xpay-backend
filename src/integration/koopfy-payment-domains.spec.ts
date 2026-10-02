import { WhopApiError } from '../orchestrator/whop/whop-platform.client';
import { KoopfyPaymentDomainsService, normalizeHostname, ownRegistration } from './koopfy-payment-domains.service';

jest.mock('../lib/supabase.client', () => ({ supabase: {} }));
jest.mock('../orchestrator/whop/whop-connect.service', () => ({ WhopConnectService: class {} }));
jest.mock('../orchestrator/whop/whop-linked.service', () => ({ WhopLinkedAccountsService: class {} }));
jest.mock('../orchestrator/seller-provider/seller-provider-accounts.service', () => ({ sellerHasOwnStripe: async () => false }));
jest.mock('../orchestrator/own-finance/own-payment-domains.service', () => ({ OwnPaymentDomainsService: class {} }));

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
  const ownDomains: any = {
    registerEverywhere: jest.fn(async (_seller: string, hostname: string, o?: { register: boolean }) => [
      {
        accountId: 'whopl_biz_own', provider: 'whop', name: 'Minha Whop', error: null,
        domain: o?.register === false ? null : { id: 'pmdm_1', hostname, applePay: 'active', googlePay: 'not_required', message: null },
      },
      { accountId: 'stripel_1', provider: 'stripe', name: 'Stripe EUA', domain: null, error: 'chave sem permissão' },
    ]),
  };
  return { whop, ownDomains, service: new KoopfyPaymentDomainsService(whop, connect, linked, ownDomains) };
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

  it('contas próprias: registra em cada conta dele, nunca na master', async () => {
    const { whop, ownDomains, service } = setup({ linked: true });
    const result = await service.register(ctx, 'loja.com');
    expect(result.mode).toBe('external');
    expect(whop.createPaymentMethodDomain).not.toHaveBeenCalled();
    expect(ownDomains.registerEverywhere).toHaveBeenCalledWith('seller-1', 'loja.com');
    expect(result.registrations).toEqual([
      { scope: 'own', accountId: 'whopl_biz_own', provider: 'whop', name: 'Minha Whop', id: 'pmdm_1', status: 'verified', message: null, applePay: 'active', googlePay: 'not_required' },
      { scope: 'own', accountId: 'stripel_1', provider: 'stripe', name: 'Stripe EUA', id: null, status: 'error', message: 'chave sem permissão' },
    ]);
  });

  it('contas próprias: abrir a tela só consulta, não registra', async () => {
    const { ownDomains, service } = setup({ linked: true });
    const result = await service.status(ctx, 'loja.com');
    expect(ownDomains.registerEverywhere).toHaveBeenCalledWith('seller-1', 'loja.com', { register: false });
    expect(result.registrations[0]).toMatchObject({ scope: 'own', status: 'error', message: 'not_registered' });
  });

  it('Stripe com o arquivo pendente: Google Pay já ativo, Apple Pay esperando', () => {
    expect(ownRegistration({
      accountId: 'stripel_1', provider: 'stripe', name: null, error: null,
      domain: { id: 'pmd_1', hostname: 'loja.com', applePay: 'pending', googlePay: 'active', message: 'Arquivo não encontrado.' },
    })).toMatchObject({ status: 'pending', applePay: 'pending', googlePay: 'active', message: 'Arquivo não encontrado.' });
  });
});
