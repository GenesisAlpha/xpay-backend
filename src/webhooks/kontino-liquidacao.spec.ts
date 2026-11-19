import { valoresDaLiquidacaoKontino } from './kontino-liquidacao'

describe('valores da venda Kontino pela liquidação real', () => {
  it('usa o bruto e o líquido da BlindPay e desconta a taxa da venda', () => {
    // 18/11: ARS 34.900 → bruto US$ 20,41, BlindPay + Kontino US$ 1,11, líquido US$ 19,30; taxa US$ 3,21.
    expect(valoresDaLiquidacaoKontino({ gross: 2041, net: 1930 }, 3490000, 321)).toEqual({
      amount_usd_gross_cents: 2041,
      amount_usd_net_cents: 1609,
      fx_fee_cents: 0,
      fx_rate: 2041 / 3490000,
    })
  })

  it('sem liquidação não mexe em nada', () => {
    expect(valoresDaLiquidacaoKontino(null, 3490000, 321)).toEqual({})
    expect(valoresDaLiquidacaoKontino({ gross: null, net: null }, 3490000, 321)).toEqual({})
  })

  it('líquido nunca fica negativo', () => {
    expect(valoresDaLiquidacaoKontino({ gross: 100, net: 50 }, 10000, 300).amount_usd_net_cents).toBe(0)
  })
})
