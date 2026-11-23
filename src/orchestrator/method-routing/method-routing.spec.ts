import { metodosComClip, normalizeMethod, pickRule, resolveMethodRoute, rotaDoCartaoClip, validateRule, type MethodRoute, type MethodRouteRule } from './method-routing'

const rule = (over: Partial<MethodRouteRule>): MethodRouteRule => ({
  id: over.id ?? 'r', method: 'card', country: null, currency: null, seller_id: null, providers: ['stripe'], enabled: true, ...over,
})

describe('provedor por método', () => {
  const rules = [
    rule({ id: 'pix', method: 'pix', providers: ['kontino', 'approvebly'] }),
    rule({ id: 'spei', method: 'spei', providers: ['kontino', 'clip'] }),
    rule({ id: 'card', method: 'card', providers: ['kaja', 'stripe', 'whop'] }),
    rule({ id: 'card-br', method: 'card', country: 'BR', providers: ['stripe'] }),
    rule({ id: 'card-br-brl', method: 'card', country: 'BR', currency: 'BRL', providers: ['whop'] }),
    rule({ id: 'card-seller', method: 'card', seller_id: 's1', providers: ['whop'] }),
    rule({ id: 'off', method: 'boleto', enabled: false, providers: ['approvebly'] }),
  ]

  it('Pix e SPEI no Kontino; cartão na Kaja', () => {
    expect(resolveMethodRoute(rules, {}, { method: 'pix' }).chain).toEqual(['kontino', 'approvebly'])
    expect(resolveMethodRoute(rules, {}, { method: 'spei' }).chain[0]).toBe('kontino')
    expect(resolveMethodRoute(rules, {}, { method: 'credit_card', country: 'US' }).chain).toEqual(['kaja', 'stripe', 'whop'])
  })

  it('regra mais específica vence: seller > país+moeda > país > método', () => {
    expect(pickRule(rules, { method: 'card', country: 'BR', currency: 'BRL', sellerId: 's1' })?.id).toBe('card-seller')
    expect(pickRule(rules, { method: 'card', country: 'BR', currency: 'BRL' })?.id).toBe('card-br-brl')
    expect(pickRule(rules, { method: 'card', country: 'br', currency: 'USD' })?.id).toBe('card-br')
    expect(pickRule(rules, { method: 'card', country: 'MX' })?.id).toBe('card')
  })

  it('exceção de outro seller não vale', () => {
    expect(pickRule(rules, { method: 'card', sellerId: 's2' })?.id).toBe('card')
  })

  it('provedor indisponível sai da cadeia com o motivo', () => {
    const r = resolveMethodRoute(rules, { kaja: { available: false, reason: 'aguardando credenciais' } }, { method: 'card' })
    expect(r.configured).toEqual(['kaja', 'stripe', 'whop'])
    expect(r.chain).toEqual(['stripe', 'whop'])
    expect(r.skipped).toEqual([{ provider: 'kaja', reason: 'aguardando credenciais' }])
  })

  it('sem regra (ou regra desligada) = comportamento antigo', () => {
    expect(resolveMethodRoute(rules, {}, { method: 'boleto' }).scope).toBe('legacy')
    expect(resolveMethodRoute(rules, {}, { method: 'crypto' }).ruleId).toBeNull()
  })

  it('normaliza nomes de método', () => {
    expect(normalizeMethod('CREDIT_CARD')).toBe('card')
    expect(normalizeMethod('applepay')).toBe('apple_pay')
  })

  it('valida a regra antes de gravar', () => {
    expect(validateRule({ method: 'pix', providers: ['kontino'] })).toBeNull()
    expect(validateRule({ method: 'pix', providers: ['kaja'] })).toMatch(/não atende Pix/)
    expect(validateRule({ method: 'pix', providers: [] })).toMatch(/ao menos um/)
    expect(validateRule({ method: 'pix', providers: ['kontino', 'kontino'] })).toMatch(/repetido/)
    expect(validateRule({ method: 'spei', currency: 'USD', providers: ['kontino'] })).toMatch(/só em MXN/)
    expect(validateRule({ method: 'card', country: 'BRA', providers: ['stripe'] })).toMatch(/2 letras/)
    expect(validateRule({ method: 'xpto', providers: ['stripe'] })).toMatch(/desconhecido/)
  })
})

import { buildFailoverOrder } from '../router/failover.config'

describe('failover com a cadeia da regra', () => {
  it('usa a ordem da regra no lugar da cadeia fixa', () => {
    expect(buildFailoverOrder({ method: 'card', preferred: 'whop', chain: ['stripe', 'whop'] })).toEqual(['stripe', 'whop'])
  })
  it('sem cadeia, mantém o comportamento antigo', () => {
    expect(buildFailoverOrder({ method: 'card', preferred: 'whop' })[0]).toBe('whop')
  })
  it('respeita o limite de saltos', () => {
    expect(buildFailoverOrder({ chain: ['stripe', 'whop', 'rox_pay', 'setinel_gate'] }).length).toBe(3)
  })
})

describe('Clip só no cartão', () => {
  const rota = (over: Partial<MethodRoute> = {}): MethodRoute => ({
    ruleId: 'r', scope: 'country', configured: ['clip'], chain: ['clip'], skipped: [], ...over,
  })

  it('entra em regra de cartão do México, sem moeda', () => {
    expect(validateRule({ method: 'card', country: 'MX', providers: ['clip'] })).toBeNull()
    expect(validateRule({ method: 'card', country: 'mx', providers: ['clip', 'kaja'] })).toBeNull()
  })

  it('fora do México, com moeda ou em outro método é recusada', () => {
    expect(validateRule({ method: 'card', providers: ['clip'] })).toContain('México')
    expect(validateRule({ method: 'card', country: 'BR', providers: ['clip'] })).toContain('México')
    expect(validateRule({ method: 'card', country: 'MX', currency: 'MXN', providers: ['clip'] })).toContain('moeda')
    for (const method of ['spei', 'apple_pay', 'google_pay', 'pix']) {
      expect(validateRule({ method, country: 'MX', providers: ['clip'] })).toContain('não atende')
    }
  })

  it('com reserva, o cartão fica na Clip mesmo fora da regra', () => {
    const r = rotaDoCartaoClip(rota({ configured: ['kaja'], chain: ['kaja'] }), { method: 'credit_card', temReserva: true })
    expect(r?.chain).toEqual(['clip'])
    expect(rotaDoCartaoClip(rota({ ruleId: null, scope: 'legacy', chain: [], configured: [] }), { method: 'card', temReserva: true })?.chain).toEqual(['clip'])
  })

  it('seller com Clip padrão e sem regra segue pelo caminho antigo', () => {
    const legada = rota({ ruleId: null, scope: 'legacy', chain: [], configured: [] })
    expect(rotaDoCartaoClip(legada, { method: 'card', temReserva: true, provedorPadrao: 'clip' })).toBe(legada)
  })

  it('sem reserva, a Clip sai da cadeia e sobra a reserva ou o provedor do seller', () => {
    expect(rotaDoCartaoClip(rota({ chain: ['clip', 'kaja'] }), { method: 'card', temReserva: false })?.chain).toEqual(['kaja'])
    const semOutro = rotaDoCartaoClip(rota(), { method: 'card', temReserva: false })
    expect(semOutro?.ruleId).toBeNull()
    expect(semOutro?.scope).toBe('legacy')
  })

  it('não mexe em outros métodos', () => {
    const r = rota({ configured: ['kontino'], chain: ['kontino'] })
    expect(rotaDoCartaoClip(r, { method: 'spei', temReserva: true })).toBe(r)
  })

  it('checkout com Clip: só cartão, e trilhos locais só com conta Kontino', () => {
    const m = ['credit_card', 'apple_pay', 'google_pay', 'spei', 'mbway']
    expect(metodosComClip(m, false)).toEqual(['credit_card'])
    expect(metodosComClip(m, true)).toEqual(['credit_card', 'spei'])
  })
})
