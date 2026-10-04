import {
  associationFileOf,
  domainHostname,
  mapStripeDomain,
  mapWhopDomain,
  platformCheckoutHosts,
  sortDomains,
  supportsPaymentDomains,
} from './own-payment-domains';

describe('domínios de pagamento das contas próprias', () => {
  it('normaliza o que o seller digita', () => {
    expect(domainHostname(' https://Loja.com/pagina?x=1 ')).toBe('loja.com');
    expect(domainHostname('checkout.koopfy.com')).toBe('checkout.koopfy.com');
    expect(domainHostname('pay.loja.com.br:443')).toBe('pay.loja.com.br');
  });

  it('recusa o que não é domínio e os domínios dos provedores', () => {
    expect(() => domainHostname('loja')).toThrow('Domínio inválido');
    expect(() => domainHostname('')).toThrow('Domínio inválido');
    expect(() => domainHostname('dashboard.stripe.com')).toThrow('domínio do seu site');
    expect(() => domainHostname('whop.com')).toThrow('domínio do seu site');
  });

  it('o checkout da Koopfy entra sozinho, com os extras do ambiente', () => {
    expect(platformCheckoutHosts({})).toEqual(['checkout.koopfy.com']);
    expect(platformCheckoutHosts({ CHECKOUT_PUBLIC_URL: 'https://pay.exemplo.com', CHECKOUT_EXTRA_HOSTS: 'checkout.koopfy.com, ,pay.exemplo.com' }))
      .toEqual(['pay.exemplo.com', 'checkout.koopfy.com']);
  });

  it('Stripe: Google Pay ativo só com o registro; Apple Pay espera o arquivo', () => {
    const domain = mapStripeDomain({
      id: 'pmd_1',
      domain_name: 'Loja.com',
      enabled: true,
      apple_pay: { status: 'inactive', status_details: { error_message: 'Arquivo não encontrado.' } },
      google_pay: { status: 'active' },
    });
    expect(domain).toEqual({ id: 'pmd_1', hostname: 'loja.com', applePay: 'pending', googlePay: 'active', message: 'Arquivo não encontrado.' });
    expect(mapStripeDomain({ id: 'pmd_2', domain_name: 'a.com', apple_pay: { status: 'active' }, google_pay: { status: 'active' } }))
      .toMatchObject({ applePay: 'active', googlePay: 'active', message: null });
  });

  it('Stripe: domínio desativado não conta como ativo', () => {
    expect(mapStripeDomain({ id: 'pmd_3', domain_name: 'a.com', enabled: false, apple_pay: { status: 'active' }, google_pay: { status: 'active' } }))
      .toMatchObject({ applePay: 'pending', googlePay: 'pending', message: 'O domínio está desativado na Stripe.' });
  });

  it('Whop: verificado libera o Apple Pay; Google Pay não depende de registro', () => {
    expect(mapWhopDomain({ id: 'pmdm_1', hostname: 'loja.com', status: 'verified' }))
      .toEqual({ id: 'pmdm_1', hostname: 'loja.com', applePay: 'active', googlePay: 'not_required', message: null });
    expect(mapWhopDomain({ id: 'pmdm_2', hostname: 'loja.com', status: 'pending' }).applePay).toBe('pending');
  });

  it('PayPal não registra domínio; Whop e Stripe têm cada uma o seu arquivo', () => {
    expect(supportsPaymentDomains('paypal')).toBe(false);
    expect(associationFileOf('paypal')).toBeNull();
    expect(associationFileOf('stripe')?.url).toContain('stripe.com/files/apple-pay');
    expect(associationFileOf('whop')?.url).toContain('whop.com/.well-known');
  });

  it('os domínios da Koopfy vêm primeiro e ninguém repete', () => {
    const domain = (hostname: string) => ({ id: hostname, hostname, applePay: 'active' as const, googlePay: 'active' as const, message: null });
    expect(sortDomains([domain('loja.com'), domain('checkout.koopfy.com'), domain('a.com'), domain('loja.com')], ['checkout.koopfy.com']).map(item => item.hostname))
      .toEqual(['checkout.koopfy.com', 'a.com', 'loja.com']);
  });
});
