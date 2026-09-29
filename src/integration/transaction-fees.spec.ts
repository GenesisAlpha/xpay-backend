import { MAX_FEE_IDS, feesFromRows, normalizeFeeIds } from './transaction-fees';

describe('transaction fees', () => {
  it('filtra ids inválidos e repetidos', () => {
    expect(normalizeFeeIds(['abc123', 'abc123', '', 'x', 'drop table;', 42, 'tx_ok-1'])).toEqual(['abc123', 'tx_ok-1']);
    expect(normalizeFeeIds('abc123')).toEqual([]);
  });

  it('limita a quantidade por chamada', () => {
    const ids = Array.from({ length: MAX_FEE_IDS + 50 }, (_, i) => `tx_${String(i).padStart(4, '0')}`);
    expect(normalizeFeeIds(ids)).toHaveLength(MAX_FEE_IDS);
  });

  it('converte centavos de USD em dólares', () => {
    expect(feesFromRows([{ id: 'a', fee: 1234 }, { id: 'b', fee: null }, { id: 'c', fee: '59' }]))
      .toEqual([{ id: 'a', fee: 12.34 }, { id: 'b', fee: 0 }, { id: 'c', fee: 0.59 }]);
  });
});
