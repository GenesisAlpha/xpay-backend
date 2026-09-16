import {
  WhopLinkedAccountRow,
  isLinkedProviderAccountId,
  linkedChargeBlocker,
  linkedCommissionCents,
  sellerExternalProviderView,
  toLinkedProviderAccountId,
  whopAccountIdFromLinkedProviderAccountId,
} from './whop-linked';

const row = (over: Partial<WhopLinkedAccountRow> = {}): WhopLinkedAccountRow => ({
  seller_id: 'seller-1',
  whop_account_id: 'biz_do_seller',
  company_title: 'Loja do Seller',
  api_key: 'cifrada',
  api_url: null,
  webhook_id: null,
  webhook_secret: null,
  status: 'active',
  wallet_ready: true,
  commission_pct: 3,
  affiliate_id: null,
  affiliate_code: null,
  affiliate_override_id: null,
  last_checked_at: null,
  last_error: null,
  created_by: null,
  created_at: '2026-09-16',
  updated_at: '2026-09-16',
  ...over,
});

describe('ids da conta própria', () => {
  it('separa a conta própria da master e da conectada', () => {
    const id = toLinkedProviderAccountId('biz_do_seller');
    expect(id).toBe('whopl_biz_do_seller');
    expect(isLinkedProviderAccountId(id)).toBe(true);
    expect(whopAccountIdFromLinkedProviderAccountId(id)).toBe('biz_do_seller');

    expect(isLinkedProviderAccountId('whop_main')).toBe(false);
    expect(isLinkedProviderAccountId('whopc_biz_conectada')).toBe(false);
    expect(isLinkedProviderAccountId(null)).toBe(false);
  });
});

describe('linkedChargeBlocker', () => {
  it('conta ativa e com id válido cobra', () => {
    expect(linkedChargeBlocker(row())).toBeNull();
  });

  it('diz o motivo quando não dá para cobrar', () => {
    expect(linkedChargeBlocker(null)).toMatch(/sem conta Whop própria/);
    expect(linkedChargeBlocker(row({ status: 'disabled' }))).toMatch(/desligada/);
    expect(linkedChargeBlocker(row({ status: 'allowed' }))).toMatch(/ainda não conectou/);
    expect(linkedChargeBlocker(row({ status: 'invalid', last_error: 'chave revogada' })))
      .toMatch(/recusada pela Whop: chave revogada/);
    expect(linkedChargeBlocker(row({ whop_account_id: 'user_errado' }))).toMatch(/id válido/);
  });
});

describe('sellerExternalProviderView', () => {
  it('sem liberação da equipe, o painel não vê nada', () => {
    expect(sellerExternalProviderView(null)).toBeNull();
    expect(sellerExternalProviderView({ allowed: false, connected: false })).toBeNull();
  });

  it('liberado e ainda não conectado: o painel oferece conectar', () => {
    const view = sellerExternalProviderView({
      allowed: true,
      connected: false,
      status: 'allowed',
      commissionPct: 3,
      blocker: 'modo liberado, mas o seller ainda não conectou a conta dele',
    });
    expect(view).toMatchObject({ allowed: true, connected: false, charging: false, provider: 'whop' });
    expect(view?.attention).toBeNull();
  });

  it('não vaza afiliado, override nem recado interno', () => {
    const view = sellerExternalProviderView({
      allowed: true,
      connected: true,
      status: 'active',
      companyTitle: 'Loja do Seller',
      commissionPct: 3,
      affiliateReady: true,
      walletReady: true,
      blocker: null,
      lastError: 'comissão salva só na Koopfy',
    });
    expect(view).toEqual({
      allowed: true,
      connected: true,
      provider: 'whop',
      accountName: 'Loja do Seller',
      commissionPct: 3,
      charging: true,
      walletReady: true,
      attention: null,
    });
  });

  it('chave sem permissão de saldo avisa que o financeiro não abre', () => {
    const view = sellerExternalProviderView({
      allowed: true,
      connected: true,
      status: 'active',
      commissionPct: 3,
      walletReady: false,
      blocker: null,
    });
    expect(view?.charging).toBe(true);
    expect(view?.walletReady).toBe(false);
    expect(view?.attention).toMatch(/saldo e saque/);
  });

  it('chave recusada vira recado para ele conectar de novo', () => {
    const view = sellerExternalProviderView({
      allowed: true,
      connected: true,
      status: 'invalid',
      commissionPct: 3,
      blocker: 'chave de API recusada pela Whop: revogada',
    });
    expect(view?.charging).toBe(false);
    expect(view?.attention).toMatch(/nova/);
  });
});

describe('linkedCommissionCents', () => {
  it('comissão da Koopfy sobre o bruto da venda', () => {
    expect(linkedCommissionCents(10000, 3)).toBe(300);
    expect(linkedCommissionCents(9999, 2.5)).toBe(250);
  });

  it('sem comissão combinada ou sem venda, é zero', () => {
    expect(linkedCommissionCents(10000, 0)).toBe(0);
    expect(linkedCommissionCents(0, 5)).toBe(0);
    expect(linkedCommissionCents(-100, 5)).toBe(0);
  });
});
