import { cuitValido, dadosDoPagadorKontino } from './pagador'
import { respostaAoCheckout, type CobrancaKontino } from './kontino'
import { METHOD_CATALOG, resolveMethodRoute, validateRule } from '../method-routing/method-routing'

describe('dados do comprador por trilho da Kontino', () => {
  it('Transferencias 3.0 exige CUIT/CUIL válido', () => {
    expect(cuitValido('20-12345678-6')).toBe(true)
    expect(cuitValido('20-12345678-5')).toBe(false)
    expect(dadosDoPagadorKontino('transfers_ar', { customer: { document: '20123456786' } })).toBeNull()
    expect(dadosDoPagadorKontino('transfers_ar', { customer: { document: '123' } })).toMatch(/CUIT/)
  })

  it('PSE exige tipo e número do documento, banco e celular colombiano', () => {
    const ok = { customer: { document: '1020304050', phone: '+57 300 123 4567' }, payment_data: { documentType: 'CC', bankCode: '1007' } }
    expect(dadosDoPagadorKontino('pse', ok)).toBeNull()
    expect(dadosDoPagadorKontino('pse', { ...ok, payment_data: { documentType: 'XX', bankCode: '1007' } })).toMatch(/tipo de documento/)
    expect(dadosDoPagadorKontino('pse', { ...ok, payment_data: { documentType: 'CC' } })).toMatch(/banco/)
    expect(dadosDoPagadorKontino('pse', { ...ok, customer: { document: '1020304050', phone: '+55 11 99999 0000' } })).toMatch(/celular/)
    expect(dadosDoPagadorKontino('pse', { ...ok, payment_data: { documentType: 'PASS', bankCode: '1007' } })).toMatch(/tipo de documento/)
    expect(dadosDoPagadorKontino('pse', { ...ok, customer: { document: '900.123.456', phone: '3001234567' }, payment_data: { documentType: 'NIT', bankCode: '1007' } })).toBeNull()
  })

  it('Pix e SPEI não pedem nada a mais', () => {
    expect(dadosDoPagadorKontino('pix', {})).toBeNull()
    expect(dadosDoPagadorKontino('spei', {})).toBeNull()
  })
})

describe('resposta ao checkout dos trilhos novos', () => {
  const base: CobrancaKontino = { id: 'col_1', status: 'pending', method: 'transfers_ar', amount: 100000, currency: 'ARS', reference: 'KT1', expires_at: '2026-11-18T12:30:00Z', instructions: { type: 'cvu', cvu: '0000003100000000000001', beneficiary_tax_id: '30712345678', reference: 'KT1' } }

  it('Transferencias 3.0 devolve o CVU para o modal automático', () => {
    const r: any = respostaAoCheckout('tx_1', base, 100000)
    expect(r.transferencia).toEqual(expect.objectContaining({ cvu: '0000003100000000000001', beneficiaryTaxId: '30712345678', chargeMinor: 100000, currency: 'ARS', automatico: true }))
  })

  it('PSE devolve o link do banco em redirectUrl', () => {
    const r: any = respostaAoCheckout('tx_2', { ...base, method: 'pse', currency: 'COP', instructions: { type: 'link', url: 'https://banco.example/pse/1' } }, 5000000)
    expect(r.redirectUrl).toBe('https://banco.example/pse/1')
    expect(r.pse.url).toBe('https://banco.example/pse/1')
  })
})

describe('catálogo só com Kaja e Kontino', () => {
  it('nenhum método aceita provedor fora de Kaja e Kontino', () => {
    for (const m of Object.values(METHOD_CATALOG)) for (const p of m.providers) expect(['kaja', 'kontino']).toContain(p)
    expect(validateRule({ method: 'pix', providers: ['kontino', 'whop'] })).toMatch(/não atende/)
  })

  it('moeda fixa da Kontino vale para os trilhos novos', () => {
    expect(validateRule({ method: 'transfers_ar', currency: 'USD', providers: ['kontino'] })).toMatch(/ARS/)
    expect(validateRule({ method: 'pse', currency: 'COP', providers: ['kontino'] })).toBeNull()
  })

  it('regra antiga com provedor fora de operação pula ele', () => {
    const r = resolveMethodRoute(
      [{ id: 'r1', method: 'pix', country: null, currency: null, seller_id: null, providers: ['kontino', 'whop'], enabled: true }],
      { kontino: { available: true }, whop: { available: false, reason: 'Fora de operação na Koopfy' } },
      { method: 'pix' },
    )
    expect(r.chain).toEqual(['kontino'])
  })
})
