import { catalogEnabledMethods, catalogMethodId } from './payment-method-catalog'

describe('catalogMethodId', () => {
  it('traduz os nomes do cadastro para os ids do catálogo', () => {
    expect(catalogMethodId('credit_card')).toBe('card')
    expect(catalogMethodId('debit_card')).toBe('card')
    expect(catalogMethodId(' MBWAY ')).toBe('mb_way')
    expect(catalogMethodId('sepa')).toBe('sepa_debit')
    expect(catalogMethodId('ideal')).toBe('ideal')
  })
})

describe('catalogEnabledMethods', () => {
  it('credit_card no cadastro libera o cartão', () => {
    const enabled = catalogEnabledMethods({ enabledMethods: ['credit_card', 'apple_pay', 'mbway'], ownCardAccount: false })
    expect(enabled.has('card')).toBe(true)
    expect(enabled.has('mb_way')).toBe(true)
    expect(enabled.has('google_pay')).toBe(false)
  })

  it('conta própria de cartão libera cartão e wallets sem aprovação', () => {
    const enabled = catalogEnabledMethods({ enabledMethods: [], ownCardAccount: true })
    expect([...enabled].sort()).toEqual(['apple_pay', 'card', 'google_pay'])
  })

  it('cadastro vazio e sem conta própria não libera nada', () => {
    expect(catalogEnabledMethods({ enabledMethods: null, ownCardAccount: false }).size).toBe(0)
  })
})
