import { isWhopInitiatedRefund, refundFeeCents } from './refund-fee'

describe('isWhopInitiatedRefund', () => {
  it('estorno da Whop sem pedido nosso cobra a taxa de chargeback', () => {
    expect(isWhopInitiatedRefund({ provider: 'whop', metadata: {} })).toBe(true)
    expect(isWhopInitiatedRefund({ provider: 'whop', metadata: null })).toBe(true)
  })

  it('reembolso pedido do nosso lado não cobra', () => {
    expect(isWhopInitiatedRefund({ provider: 'whop', metadata: { refunded_by: 'mgr-1' } })).toBe(false)
    expect(isWhopInitiatedRefund({ provider: 'whop', metadata: { refund_requested_by: 'seller' } })).toBe(false)
  })

  it('só vale para a Whop', () => {
    expect(isWhopInitiatedRefund({ provider: 'stripe', metadata: {} })).toBe(false)
  })
})

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
