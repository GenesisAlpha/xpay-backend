import {
  availableCents,
  classifyWhopWithdrawal,
  isWhopConnectedPayout,
  newPayoutExecution,
  payoutNetCents,
  payoutTransferKey,
  payoutWithdrawalKey,
  pickPayoutMethod,
} from './whop-connected-payout';

describe('pickPayoutMethod', () => {
  const methods = [
    { id: 'potk_a', is_default: false },
    { id: 'potk_b', is_default: true },
  ];

  it('usa a conta escolhida quando ela ainda existe', () => {
    expect(pickPayoutMethod(methods, 'potk_a')).toEqual({ ok: true, id: 'potk_a' });
  });

  it('recusa a escolhida que sumiu, em vez de cair na padrão', () => {
    expect(pickPayoutMethod(methods, 'potk_x')).toMatchObject({ ok: false });
  });

  it('sem escolha, usa a padrão', () => {
    expect(pickPayoutMethod(methods)).toEqual({ ok: true, id: 'potk_b' });
  });

  it('sem padrão, usa a única cadastrada', () => {
    expect(pickPayoutMethod([{ id: 'potk_only' }])).toEqual({ ok: true, id: 'potk_only' });
  });

  it('não chuta entre várias sem padrão', () => {
    expect(pickPayoutMethod([{ id: 'potk_a' }, { id: 'potk_b' }])).toMatchObject({ ok: false });
  });

  it('sem conta bancária, bloqueia', () => {
    expect(pickPayoutMethod([])).toMatchObject({ ok: false });
    expect(pickPayoutMethod(undefined)).toMatchObject({ ok: false });
  });
});

describe('payoutNetCents', () => {
  it('prefere o líquido gravado na solicitação', () => {
    expect(payoutNetCents({ amount: 10000, fee: 300, metadata: { net_cents: 9700 } })).toBe(9700);
  });

  it('sem metadata, desconta a taxa do valor', () => {
    expect(payoutNetCents({ amount: 10000, fee: 250 })).toBe(9750);
  });

  it('sem taxa, o líquido é o valor', () => {
    expect(payoutNetCents({ amount: 10000, fee: null })).toBe(10000);
  });
});

describe('classifyWhopWithdrawal', () => {
  it.each([
    ['completed', 'succeeded'],
    ['failed', 'failed'],
    ['canceled', 'failed'],
    ['denied', 'failed'],
    ['requested', 'processing'],
    ['awaiting_payment', 'processing'],
    ['in_transit', 'processing'],
    [undefined, 'processing'],
  ])('%s → %s', (status, expected) => {
    expect(classifyWhopWithdrawal({ status })).toBe(expected);
  });
});

describe('chaves de idempotência', () => {
  it('são derivadas do saque, não da tentativa de rede', () => {
    expect(payoutTransferKey('p1')).toBe(payoutTransferKey('p1'));
    expect(payoutWithdrawalKey('p1', 1)).toBe(payoutWithdrawalKey('p1', 1));
  });

  it('um reenvio pedido pelo CRM é um saque novo', () => {
    expect(payoutWithdrawalKey('p1', 2)).not.toBe(payoutWithdrawalKey('p1', 1));
  });
});

describe('availableCents', () => {
  it('lê o disponível da moeda, não o saldo total', () => {
    const balances = [{ symbol: 'USD', balance: 500, breakdown: { available: 120.55 } }];
    expect(availableCents(balances, 'usd')).toBe(12055);
  });

  it('moeda ausente é zero', () => {
    expect(availableCents([{ symbol: 'EUR', balance: 10 }], 'usd')).toBe(0);
  });
});

it('isWhopConnectedPayout reconhece só a execução automática', () => {
  expect(isWhopConnectedPayout({ execution: newPayoutExecution('biz_1') })).toBe(true);
  expect(isWhopConnectedPayout({ method: 'pix' })).toBe(false);
  expect(isWhopConnectedPayout(null)).toBe(false);
});
