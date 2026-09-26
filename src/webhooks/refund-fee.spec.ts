import { refundFeeCents } from './refund-fee'

// Estorno: seller arca com o valor cheio — a taxa da Koopfy não é reembolsável.

describe('refundFeeCents', () => {
  it('cobra a taxa que faltava: bruto − crédito revertido', () => {
    // pay_zwbiUYyHEMncDo: US$ 203,84 bruto, US$ 186,96 creditados, sem reserva.
    expect(refundFeeCents({ grossUsdCents: 20384, creditedCents: 18696, reserveHeldCents: 0 })).toBe(1688)
  })

  it('desconta a reserva presa, que já fica com a Koopfy', () => {
    expect(refundFeeCents({ grossUsdCents: 10000, creditedCents: 8000, reserveHeldCents: 900 })).toBe(1100)
  })

  it('nunca devolve dinheiro ao seller', () => {
    expect(refundFeeCents({ grossUsdCents: 10000, creditedCents: 10000, reserveHeldCents: 500 })).toBe(0)
  })

  it('sem bruto gravado, usa taxa + comissão de parceiro', () => {
    expect(refundFeeCents({ grossUsdCents: null, creditedCents: 9000, reserveHeldCents: 0, feeCents: 800, externalFeeCents: 200 })).toBe(1000)
    expect(refundFeeCents({ grossUsdCents: 0, creditedCents: 9000, reserveHeldCents: 0 })).toBe(0)
  })
})
