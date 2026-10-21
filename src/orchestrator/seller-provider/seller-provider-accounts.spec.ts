// Regras puras das contas Stripe/PayPal próprias do seller: validação das
// credenciais, combinação entre provedores, por onde a venda sai e a visão do
// painel.

import {
  SellerProviderAccountRow,
  chooseOwnSaleProvider,
  combineExternalProviderView,
  isOwnProviderAccountId,
  isPaypalOwnAccountId,
  isStripeOwnAccountId,
  normalizeCommissionPct,
  ownProviderConflict,
  paypalCaptureMismatch,
  rowIdFromOwnAccountId,
  sellerProviderStatusView,
  toPaypalOwnAccountId,
  toPaypalValue,
  toStripeOwnAccountId,
  validatePaypalCredentials,
  validateStripeKeys,
  whopIsCardDefault,
} from './seller-provider-accounts';

const row = (over: Partial<SellerProviderAccountRow> = {}): SellerProviderAccountRow => ({
  id: '11111111-2222-3333-4444-555555555555',
  seller_id: 'seller-1',
  provider: 'stripe',
  status: 'active',
  mode: 'live',
  account_ref: 'acct_123',
  display_name: 'Loja do Seller',
  public_key: 'pk_live_abc',
  secret_enc: 'cifrada',
  webhook_id: 'we_1',
  webhook_secret_enc: 'cifrada',
  last_error: null,
  last_checked_at: null,
  created_by: null,
  created_at: '2026-09-28',
  updated_at: '2026-09-28',
  ...over,
});

describe('ids das contas próprias', () => {
  it('stripel_ e paypall_ ida e volta, e contam como conta própria', () => {
    const stripe = toStripeOwnAccountId('abc');
    const paypal = toPaypalOwnAccountId('abc');
    expect(stripe).toBe('stripel_abc');
    expect(paypal).toBe('paypall_abc');
    expect(isStripeOwnAccountId(stripe)).toBe(true);
    expect(isPaypalOwnAccountId(paypal)).toBe(true);
    expect(rowIdFromOwnAccountId(stripe)).toBe('abc');
    expect(rowIdFromOwnAccountId(paypal)).toBe('abc');
    expect(isOwnProviderAccountId('whopl_biz_1')).toBe(true);
    expect(isOwnProviderAccountId(stripe)).toBe(true);
    expect(isOwnProviderAccountId('stripe_br_01')).toBe(false);
    expect(isOwnProviderAccountId('whop_main')).toBe(false);
    expect(isOwnProviderAccountId(null)).toBe(false);
  });
});

describe('validateStripeKeys', () => {
  it('aceita sk_/rk_ live com pk_live_', () => {
    expect(validateStripeKeys('sk_live_abc123', 'pk_live_xyz789')).toEqual({ mode: 'live' });
    expect(validateStripeKeys('rk_live_abc123', 'pk_live_xyz789')).toEqual({ mode: 'live' });
  });

  it('aceita o par de teste e marca o modo', () => {
    expect(validateStripeKeys('sk_test_abc', 'pk_test_xyz')).toEqual({ mode: 'test' });
    expect(validateStripeKeys(' rk_test_abc ', 'pk_test_xyz')).toEqual({ mode: 'test' });
  });

  it('recusa modos misturados', () => {
    expect(() => validateStripeKeys('sk_live_abc', 'pk_test_xyz')).toThrow('mesmo modo');
    expect(() => validateStripeKeys('sk_test_abc', 'pk_live_xyz')).toThrow('mesmo modo');
  });

  it('recusa prefixo errado ou chave trocada de campo', () => {
    expect(() => validateStripeKeys('pk_live_abc', 'sk_live_xyz')).toThrow('Secret key');
    expect(() => validateStripeKeys('sk_live_abc', 'rk_live_xyz')).toThrow('Publishable key');
    expect(() => validateStripeKeys('whsec_abc', 'pk_live_xyz')).toThrow('Secret key');
    expect(() => validateStripeKeys('', 'pk_live_xyz')).toThrow('Informe a Secret key');
    expect(() => validateStripeKeys('sk_live_abc', '')).toThrow('Informe a Publishable key');
  });
});

describe('validatePaypalCredentials', () => {
  const clientId = 'AaBbCcDdEeFfGgHhIiJjKkLl';
  const clientSecret = 'EeFfGgHhIiJjKkLlMmNnOoPp';

  it('aceita produção e sandbox', () => {
    expect(validatePaypalCredentials({ clientId, clientSecret, mode: 'live' }).mode).toBe('live');
    expect(validatePaypalCredentials({ clientId, clientSecret, mode: 'test' }).mode).toBe('test');
  });

  it('recusa modo desconhecido, campo vazio e credencial cortada', () => {
    expect(() => validatePaypalCredentials({ clientId, clientSecret, mode: 'sandbox' })).toThrow('Modo');
    expect(() => validatePaypalCredentials({ clientSecret, mode: 'live' })).toThrow('Client ID');
    expect(() => validatePaypalCredentials({ clientId, mode: 'live' })).toThrow('Client Secret');
    expect(() => validatePaypalCredentials({ clientId: 'curto', clientSecret, mode: 'live' })).toThrow('incompleto');
    expect(() => validatePaypalCredentials({ clientId: `${clientId}\nx`, clientSecret, mode: 'live' })).toThrow('incompleto');
  });
});

describe('Whop × Stripe exclusivas; PayPal combina com qualquer uma', () => {
  it('Stripe com a Whop ativa é recusada, e vice-versa', () => {
    expect(ownProviderConflict('stripe', { whop: true, stripe: false })).toMatch(/Desconecte a Whop/);
    expect(ownProviderConflict('whop', { whop: false, stripe: true })).toMatch(/Desconecte a Stripe/);
  });

  it('sem a outra ativa, conecta', () => {
    expect(ownProviderConflict('stripe', { whop: false, stripe: false })).toBeNull();
    expect(ownProviderConflict('whop', { whop: false, stripe: false })).toBeNull();
  });

  it('PayPal nunca conflita', () => {
    expect(ownProviderConflict('paypal', { whop: true, stripe: true })).toBeNull();
  });
});

describe('chooseOwnSaleProvider', () => {
  const none = { whopCharging: false, stripeCharging: false, paypalCharging: false };

  it('método paypal vai para o PayPal próprio, e só para ele', () => {
    expect(chooseOwnSaleProvider({ ...none, method: 'paypal', paypalCharging: true, stripeCharging: true })).toBe('paypal');
    expect(chooseOwnSaleProvider({ ...none, method: 'paypal', stripeCharging: true })).toBeNull();
  });

  it('cartão e demais métodos preferem a Stripe própria', () => {
    expect(chooseOwnSaleProvider({ ...none, method: 'card', stripeCharging: true, paypalCharging: true })).toBe('stripe');
    expect(chooseOwnSaleProvider({ ...none, method: 'pix', providerDefault: 'approvebly', stripeCharging: true })).toBe('stripe');
  });

  it('Whop própria só quando o provider do seller é a Whop (como sempre foi)', () => {
    expect(chooseOwnSaleProvider({ ...none, method: 'card', providerDefault: 'whop', whopCharging: true })).toBe('whop');
    expect(chooseOwnSaleProvider({ ...none, method: 'card', providerDefault: 'stripe', whopCharging: true })).toBeNull();
  });

  it('sem conta própria cobrando, segue o fluxo da Koopfy', () => {
    expect(chooseOwnSaleProvider({ ...none, method: 'card', providerDefault: 'whop' })).toBeNull();
  });

  it('Whop principal escolhida como padrão do cartão vence a Stripe e o provider_default', () => {
    expect(chooseOwnSaleProvider({ ...none, method: 'card', providerDefault: 'stripe', whopCharging: true, stripeCharging: true, whopIsCardDefault: true })).toBe('whop');
    expect(chooseOwnSaleProvider({ ...none, method: 'pix', whopCharging: true, whopIsCardDefault: true })).toBe('whop');
    // PayPal segue a conta PayPal escolhida.
    expect(chooseOwnSaleProvider({ ...none, method: 'paypal', whopCharging: true, paypalCharging: true, whopIsCardDefault: true })).toBe('paypal');
    // Whop sem cobrar (chave recusada): não força nada.
    expect(chooseOwnSaleProvider({ ...none, method: 'card', stripeCharging: true, whopIsCardDefault: true })).toBe('stripe');
  });
});

describe('whopIsCardDefault', () => {
  const stripe = (status: SellerProviderAccountRow['status']) => row({ provider: 'stripe', status });
  it('Whop cobrando e a Stripe guardada = a Whop é a padrão do cartão', () => {
    expect(whopIsCardDefault(true, [stripe('standby')])).toBe(true);
  });
  it('com uma Stripe cobrando, a Stripe é a padrão', () => {
    expect(whopIsCardDefault(true, [stripe('standby'), stripe('active')])).toBe(false);
  });
  it('sem Stripe guardada fica como sempre foi (provider_default)', () => {
    expect(whopIsCardDefault(true, [])).toBe(false);
    expect(whopIsCardDefault(true, [stripe('disabled')])).toBe(false);
  });
  it('Whop principal sem cobrar nunca é a padrão', () => {
    expect(whopIsCardDefault(false, [stripe('standby')])).toBe(false);
  });
});

describe('normalizeCommissionPct', () => {
  it('percentual do CRM vale, inclusive zero', () => {
    expect(normalizeCommissionPct(4.5)).toBe(4.5);
    expect(normalizeCommissionPct('2')).toBe(2);
    expect(normalizeCommissionPct(0)).toBe(0);
  });

  it('sem percentual gravado (ou inválido): 3%', () => {
    expect(normalizeCommissionPct(null)).toBe(3);
    expect(normalizeCommissionPct(undefined)).toBe(3);
    expect(normalizeCommissionPct('')).toBe(3);
    expect(normalizeCommissionPct(-1)).toBe(3);
    expect(normalizeCommissionPct('abc')).toBe(3);
  });
});

describe('valores do PayPal', () => {
  it('duas casas decimais nas moedas comuns', () => {
    expect(toPaypalValue(1234, 'USD')).toBe('12.34');
    expect(toPaypalValue(1000, 'brl')).toBe('10.00');
    expect(toPaypalValue(5, 'EUR')).toBe('0.05');
  });

  it('sem casas nas moedas sem decimal (centavos do pay ÷ 100)', () => {
    expect(toPaypalValue(100000, 'JPY')).toBe('1000');
    expect(toPaypalValue(123456, 'HUF')).toBe('1235');
  });

  it('captura confere pela transação, moeda e valor', () => {
    const tx = { id: 'tx-1', amount: 1990, currency: 'USD' };
    expect(paypalCaptureMismatch(tx, { customId: 'tx-1', value: '19.90', currency: 'USD' })).toBeNull();
    expect(paypalCaptureMismatch(tx, { customId: 'tx-2', value: '19.90', currency: 'USD' })).toMatch(/custom_id/);
    expect(paypalCaptureMismatch(tx, { customId: 'tx-1', value: '19.90', currency: 'EUR' })).toMatch(/moeda/);
    expect(paypalCaptureMismatch(tx, { customId: 'tx-1', value: '1.99', currency: 'USD' })).toMatch(/valor/);
  });
});

describe('visão do painel', () => {
  const whop = {
    allowed: true,
    connected: false,
    provider: 'whop' as const,
    accountName: null,
    commissionPct: 3,
    charging: false,
    walletReady: false,
    attention: null,
  };

  it('Stripe conectada: providers.stripe com modo, e connected/charging gerais', () => {
    const view = combineExternalProviderView(whop, { stripe: row(), paypal: null })!;
    expect(view.connected).toBe(true);
    expect(view.charging).toBe(true);
    expect(view.provider).toBe('stripe');
    expect(view.accountName).toBe('Loja do Seller');
    expect(view.commissionPct).toBe(3);
    expect(view.providers).toEqual({
      whop: null,
      stripe: { connected: true, charging: true, accountName: 'Loja do Seller', mode: 'live', attention: null },
      paypal: null,
    });
    // O segredo nunca aparece na visão.
    expect(JSON.stringify(view)).not.toContain('cifrada');
  });

  it('PayPal sandbox sem nome mostra o modo; chave recusada pede ação', () => {
    const paypal = sellerProviderStatusView(row({ provider: 'paypal', mode: 'test', display_name: null, public_key: 'client' }))!;
    expect(paypal.accountName).toBe('PayPal Sandbox');
    const invalid = sellerProviderStatusView(row({ status: 'invalid' }))!;
    expect(invalid.charging).toBe(false);
    expect(invalid.attention).toMatch(/Stripe recusou/);
  });

  it('desligada some; modo cortado no CRM some tudo', () => {
    expect(sellerProviderStatusView(row({ status: 'disabled' }))).toBeNull();
    expect(combineExternalProviderView(null, { stripe: row(), paypal: null })).toBeNull();
  });

  it('só a Whop: mantém os campos de hoje', () => {
    const view = combineExternalProviderView(
      { ...whop, connected: true, charging: true, accountName: 'Biz', walletReady: true },
      { stripe: null, paypal: null },
    )!;
    expect(view.provider).toBe('whop');
    expect(view.accountName).toBe('Biz');
    expect(view.walletReady).toBe(true);
    expect(view.providers.whop).toEqual({ connected: true, charging: true, accountName: 'Biz', attention: null });
  });
});
