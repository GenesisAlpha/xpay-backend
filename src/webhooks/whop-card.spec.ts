import { whopCardOf } from './whop-card'

describe('whopCardOf', () => {
  it('lê card_brand e card_last4 da raiz do pagamento', () => {
    expect(whopCardOf({ card_brand: 'visa', card_last4: '4242', payment_method_type: 'card' }))
      .toEqual({ brand: 'visa', last4: '4242', methodType: 'card' })
  })

  it('cai para payment_method.card quando a raiz não tem', () => {
    expect(whopCardOf({ payment_method: { payment_method_type: 'card', card: { brand: 'Mastercard', last4: '8812' } } }))
      .toEqual({ brand: 'mastercard', last4: '8812', methodType: 'card' })
  })

  it('normaliza apelidos e ignora unknown', () => {
    expect(whopCardOf({ card_brand: 'american_express', card_last4: '0005' }).brand).toBe('amex')
    expect(whopCardOf({ card_brand: 'unknown', card_last4: '1111' })).toEqual({ brand: null, last4: '1111', methodType: null })
  })

  it('carteira: guarda o tipo e a bandeira do cartão por trás', () => {
    expect(whopCardOf({ payment_method_type: 'apple_pay', card_brand: 'visa', card_last4: '9999' }))
      .toEqual({ brand: 'visa', last4: '9999', methodType: 'apple_pay' })
  })

  it('sem dados de cartão (pix, cashapp) devolve nulos', () => {
    expect(whopCardOf({ payment_method_type: 'pix' })).toEqual({ brand: null, last4: null, methodType: 'pix' })
    expect(whopCardOf(null)).toEqual({ brand: null, last4: null, methodType: null })
  })
})
