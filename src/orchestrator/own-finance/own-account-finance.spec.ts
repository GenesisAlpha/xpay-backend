import {
  capabilitiesOf,
  fromStripeAmount,
  mapPaypalBalance,
  mapStripeBalance,
  mapStripePayouts,
  mapStripeSchedule,
  parseWithdrawInput,
  sumBalances,
  toStripeMinor,
  withdrawCeiling,
} from './own-account-finance';

/**
 * Cada provedor fala o dinheiro de um jeito. Um zero a mais aqui é saldo
 * mostrado 100x maior — ou um saque 100x maior — "com sucesso".
 */
describe('financeiro das contas próprias — formatos', () => {
  it('Stripe: menor unidade da moeda vira centavos do pay (JPY sem centavo, KWD com três casas)', () => {
    expect(fromStripeAmount(12345, 'usd')).toBe(12345);
    expect(fromStripeAmount(1000, 'jpy')).toBe(100000);
    expect(fromStripeAmount(12340, 'kwd')).toBe(1234);
    expect(toStripeMinor(12345, 'usd')).toBe(12345);
    expect(toStripeMinor(100000, 'jpy')).toBe(1000);
    expect(toStripeMinor(1234, 'kwd')).toBe(12340);
  });

  it('Stripe: saldo por moeda, com a moeda padrão da conta na frente', () => {
    const balance = mapStripeBalance({
      available: [{ amount: 5000, currency: 'eur' }, { amount: 120000, currency: 'usd' }],
      pending: [{ amount: 30000, currency: 'usd' }],
    }, 'eur');
    expect(balance).toMatchObject({ currency: 'eur', availableCents: 5000, pendingCents: 0, withdrawableCents: 5000 });
    expect(balance.currencies).toEqual([
      { currency: 'eur', availableCents: 5000, pendingCents: 0, reservedCents: 0 },
      { currency: 'usd', availableCents: 120000, pendingCents: 30000, reservedCents: 0 },
    ]);
    // Sem moeda padrão: a que tem mais dinheiro.
    expect(mapStripeBalance({ available: [{ amount: 5000, currency: 'eur' }, { amount: 120000, currency: 'usd' }] }).currency).toBe('usd');
  });

  it('Stripe: saldo negativo (estornos) não vira teto de saque', () => {
    const balance = mapStripeBalance({ available: [{ amount: -4200, currency: 'usd' }] }, 'usd');
    expect(balance.availableCents).toBe(-4200);
    expect(balance.withdrawableCents).toBe(0);
  });

  it('Stripe: repasses com status traduzido e os automáticos marcados', () => {
    const payouts = mapStripePayouts({
      data: [
        { id: 'po_1', amount: 50000, currency: 'usd', status: 'paid', automatic: true, arrival_date: 1790000000, created: 1789900000 },
        { id: 'po_2', amount: 1000, currency: 'jpy', status: 'failed', automatic: false, failure_message: 'conta fechada', created: 1789900000 },
      ],
    });
    expect(payouts[0]).toMatchObject({ id: 'po_1', amountCents: 50000, status: 'completed', automatic: true });
    expect(payouts[0].estimatedAt).toBe(new Date(1790000000 * 1000).toISOString());
    expect(payouts[1]).toMatchObject({ amountCents: 100000, status: 'failed', failureReason: 'conta fechada', automatic: false });
  });

  it('Stripe: agenda de repasse', () => {
    expect(mapStripeSchedule({ settings: { payouts: { schedule: { interval: 'daily', delay_days: 2 } } } })).toEqual({ interval: 'daily', delayDays: 2 });
    expect(mapStripeSchedule(null)).toBeNull();
  });

  it('PayPal: disponível e retido por moeda, com a moeda principal da conta', () => {
    const balance = mapPaypalBalance({
      as_of_time: '2026-10-01T10:00:00Z',
      balances: [
        { currency: 'EUR', available_balance: { currency_code: 'EUR', value: '10.50' }, withheld_balance: { currency_code: 'EUR', value: '0.00' } },
        { currency: 'USD', primary: true, available_balance: { currency_code: 'USD', value: '1234.56' }, withheld_balance: { currency_code: 'USD', value: '100.00' } },
      ],
    });
    expect(balance).toMatchObject({ currency: 'usd', availableCents: 123456, reservedCents: 10000, pendingCents: 0, withdrawableCents: 123456 });
    expect(balance.currencies).toHaveLength(2);
  });

  it('total por moeda: soma contas de provedores diferentes sem converter', () => {
    const whop = { currency: 'usd', availableCents: 10000, pendingCents: 5000, reservedCents: 0, withdrawableCents: 10000, currencies: [], payoutStatus: null, settlementAt: null };
    const stripe = mapStripeBalance({ available: [{ amount: 20000, currency: 'usd' }, { amount: 3000, currency: 'eur' }] }, 'usd');
    expect(sumBalances([whop, stripe, null])).toEqual([
      { currency: 'usd', availableCents: 30000, pendingCents: 5000, reservedCents: 0, accounts: 2 },
      { currency: 'eur', availableCents: 3000, pendingCents: 0, reservedCents: 0, accounts: 1 },
    ]);
  });

  it('teto do saque: o que o provedor libera na moeda pedida', () => {
    const balance = mapStripeBalance({ available: [{ amount: 20000, currency: 'usd' }, { amount: 3000, currency: 'eur' }] }, 'usd');
    expect(withdrawCeiling(balance, 'USD')).toBe(20000);
    expect(withdrawCeiling(balance, 'eur')).toBe(3000);
    expect(withdrawCeiling(balance, 'brl')).toBe(0);
  });

  it('pedido de saque inválido é recusado antes de qualquer chamada', () => {
    expect(parseWithdrawInput({ amountCents: '1500.9', currency: ' USD ', payoutMethodId: ' pm_1 ' })).toEqual({ amountCents: 1500, currency: 'usd', payoutMethodId: 'pm_1' });
    expect(() => parseWithdrawInput({ amountCents: 0, currency: 'usd' })).toThrow('maior que zero');
    expect(() => parseWithdrawInput({ amountCents: 100, currency: 'dolar' })).toThrow('Moeda');
  });

  it('o painel só oferece o que o provedor faz por API', () => {
    expect(capabilitiesOf('whop')).toMatchObject({ withdraw: true, chooseDestination: true, history: true });
    expect(capabilitiesOf('stripe', 'test')).toMatchObject({ withdraw: true, chooseDestination: false, manageUrl: 'https://dashboard.stripe.com/test/payouts' });
    expect(capabilitiesOf('paypal')).toMatchObject({ balance: true, withdraw: false, history: false });
  });
});
