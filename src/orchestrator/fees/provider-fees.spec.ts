jest.mock('../../lib/supabase.client', () => ({ supabase: {} }));

import { DEFAULT_FEE_SETTINGS, calculateSaleFees } from '../../shared/fee.calculator';
import { koopfySaleRevenueCents, providerCostCents, saleProfitCents } from './provider-fees';

describe('lucro da venda', () => {
  it('receita da Koopfy menos o custo do provider gravado na venda', () => {
    // US$ 100 fora de USD: taxa 1229 + câmbio 200 = 1429; custo 270 + 30 + 80 + 150 = 530.
    const sale = calculateSaleFees(10000, DEFAULT_FEE_SETTINGS, { currencyConverted: true });
    const tx = { fee: sale.platformFeeCents, fee_breakdown: sale.breakdown };

    expect(providerCostCents(tx.fee_breakdown)).toBe(530);
    expect(koopfySaleRevenueCents(tx)).toBe(1429);
    expect(saleProfitCents(tx)).toBe(899);
  });

  it('lucro negativo quando o provider custa mais que a taxa da Koopfy', () => {
    const tx = { fee: 100, fee_breakdown: { fx_fee_cents: 0, provider_cost: { total_cents: 130 } } };
    expect(saleProfitCents(tx)).toBe(-30);
  });

  it('venda anterior ao modelo não tem custo nem lucro', () => {
    expect(providerCostCents(null)).toBeNull();
    expect(providerCostCents({ fx_fee_cents: 10 })).toBeNull();
    expect(saleProfitCents({ fee: 500, fee_breakdown: { fx_fee_cents: 0 } })).toBeNull();
    expect(koopfySaleRevenueCents({ fee: 500 })).toBe(500);
  });
});
