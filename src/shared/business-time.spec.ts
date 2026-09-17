import { releaseDateAfter, formatBusinessDate, BUSINESS_TZ } from './business-time'

// Hora de parede em Brasília -> instante UTC (BRT = UTC-3, sem horário de verão).
const brt = (iso: string) => new Date(`${iso}-03:00`)

describe('releaseDateAfter', () => {
  it('libera às 21h de Brasília, não importa a hora da venda', () => {
    // Os dois exemplos do dono: mesma data, horas diferentes, mesma liberação.
    const manha = releaseDateAfter(brt('2026-09-16T10:00:00'), 2)
    const noite = releaseDateAfter(brt('2026-09-16T19:00:00'), 2)

    expect(manha.toISOString()).toBe(noite.toISOString())
    expect(formatBusinessDate(manha)).toBe('18/09/2026')
    expect(horaBrt(manha)).toBe('21:00')
  })

  it('respeita o settlementDays do seller', () => {
    const venda = brt('2026-09-16T10:00:00')
    expect(formatBusinessDate(releaseDateAfter(venda, 1))).toBe('17/09/2026')
    expect(formatBusinessDate(releaseDateAfter(venda, 2))).toBe('18/09/2026')
    expect(formatBusinessDate(releaseDateAfter(venda, 3))).toBe('19/09/2026')
  })

  it('não pula fim de semana — D+N é literal', () => {
    // 18/09/2026 é sexta; D+2 cai domingo. A regra antiga empurrava para
    // segunda ou quinta; a nova não desloca.
    const sexta = brt('2026-09-18T10:00:00')
    expect(formatBusinessDate(releaseDateAfter(sexta, 2))).toBe('20/09/2026')
  })

  it('venda depois das 21h conta a partir do dia dela em Brasília', () => {
    // 22h de 16/09 em BRT já é 17/09 em UTC: o dia que vale é o de Brasília.
    const tarde = brt('2026-09-16T22:30:00')
    expect(formatBusinessDate(releaseDateAfter(tarde, 2))).toBe('18/09/2026')
  })

  it('atravessa a virada de mês', () => {
    const fimDoMes = brt('2026-09-29T15:00:00')
    expect(formatBusinessDate(releaseDateAfter(fimDoMes, 3))).toBe('02/10/2026')
  })

  it('o instante gravado é 00:00Z — 21h BRT do dia anterior em UTC', () => {
    // Prova explícita de que 21h BRT == meia-noite UTC. É o que torna a
    // formatação com BUSINESS_TZ obrigatória em todo ponto de exibição.
    const at = releaseDateAfter(brt('2026-09-16T10:00:00'), 2)
    expect(at.toISOString()).toBe('2026-09-19T00:00:00.000Z')
    expect(formatBusinessDate(at)).toBe('18/09/2026') // BRT: ainda dia 18
  })
})

describe('formatBusinessDate', () => {
  it('não depende da TZ do processo', () => {
    const meiaNoiteUtc = new Date('2026-09-17T00:00:00Z')
    // Em UTC seria 17/09; em Brasília ainda é 16/09 (21h).
    expect(formatBusinessDate(meiaNoiteUtc)).toBe('16/09/2026')
  })
})

function horaBrt(d: Date): string {
  return d.toLocaleTimeString('pt-BR', {
    timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit',
  })
}
