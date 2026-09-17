import {
  availableCents,
  classifyWhopPayout,
  checkPayoutFields,
  toRequiredField,
  whopPayoutFailureReason,
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

describe('classifyWhopPayout', () => {
  it.each([
    ['completed', 'succeeded'],
    ['failed', 'failed'],
    ['canceled', 'failed'],
    ['denied', 'failed'],
    // Voltou depois de liquidado: o dinheiro está de novo na conta conectada.
    ['reversed', 'failed'],
    ['requested', 'processing'],
    ['in_review', 'processing'],
    ['processing', 'processing'],
    [undefined, 'processing'],
  ])('%s → %s', (status, expected) => {
    expect(classifyWhopPayout({ status })).toBe(expected);
  });

  it('usa a mensagem de falha da Whop', () => {
    expect(whopPayoutFailureReason({ status: 'failed', failure: { message: 'Conta encerrada' } })).toBe('Conta encerrada');
    expect(whopPayoutFailureReason({ status: 'denied', failure: null })).toBe('saque denied');
  });
});

describe('pickPayoutMethod com conta quebrada', () => {
  it('ignora conta marcada como broken pela Whop', () => {
    const methods = [{ id: 'potk_ok' }, { id: 'potk_broken', status: 'broken', is_default: true }];
    expect(pickPayoutMethod(methods)).toEqual({ ok: true, id: 'potk_ok' });
  });
});

describe('checkPayoutFields', () => {
  const schema = [
    toRequiredField({ id: 'fld_bank_account_number', label: 'Número da conta', required: true, validation: '^[0-9]{4,17}$', input_type: 'text' }),
    toRequiredField({ id: 'fld_bank_account_type', label: 'Tipo', required: true, input_type: 'options', options: ['Checking', 'Savings'] }),
    toRequiredField({ id: 'fld_nickname', label: 'Apelido', required: false, input_type: 'text' }),
  ];

  it('aceita valores válidos e só repassa campos do schema', () => {
    const result = checkPayoutFields(schema, {
      fld_bank_account_number: ' 8825310472 ',
      fld_bank_account_type: 'Checking',
      fld_intruso: 'x',
    });
    expect(result.ok).toBe(true);
    expect(result.fields).toEqual({ fld_bank_account_number: '8825310472', fld_bank_account_type: 'Checking' });
  });

  it('aponta obrigatório vazio, regex e opção inválida', () => {
    const result = checkPayoutFields(schema, { fld_bank_account_number: '12ab', fld_bank_account_type: 'Poupança' });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.errors).sort()).toEqual(['fld_bank_account_number', 'fld_bank_account_type']);

    expect(checkPayoutFields(schema, {}).errors).toHaveProperty('fld_bank_account_number');
  });

  it('regex inválida da Whop não derruba a validação', () => {
    const broken = [toRequiredField({ id: 'fld_x', label: 'X', required: true, validation: '([' })];
    expect(checkPayoutFields(broken, { fld_x: 'qualquer' }).ok).toBe(true);
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
