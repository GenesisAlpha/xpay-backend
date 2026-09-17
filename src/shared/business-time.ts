/**
 * Fuso do negócio.
 *
 * O processo Node roda em UTC no container (não há TZ no deploy), mas o
 * vendedor lê tudo em horário de Brasília. Enquanto o agendamento e a exibição
 * usavam o fuso do processo, a data prometida e a data real divergiam: um
 * repasse gravado com `available_at` em 00:00Z era mostrado como o dia
 * seguinte e caía às 21h do dia anterior no Brasil.
 *
 * Aqui o fuso é explícito, e é o mesmo dos dois lados — quando agenda e quando
 * mostra. Nada neste arquivo depende da TZ do processo.
 */

export const BUSINESS_TZ = 'America/Sao_Paulo'

/**
 * Hora da liberação, no fuso do negócio.
 *
 * ATENÇÃO: 21:00 em Brasília é exatamente 00:00 UTC. Isso é intencional, mas
 * não deixa margem: qualquer data derivada de `available_at` que venha a ser
 * formatada SEM `BUSINESS_TZ` cai no dia seguinte e volta a mostrar a data
 * errada. Use sempre `formatBusinessDate`.
 */
export const RELEASE_HOUR = 21

/** Deslocamento do fuso (ms) no instante dado — positivo a leste de Greenwich. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)

  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
  // `hour12: false` devolve 24 em vez de 0 em parte das engines.
  const asIfUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'),
  )
  return asIfUtc - date.getTime()
}

/** Ano/mês/dia de um instante, lidos no fuso do negócio. */
function businessYmd(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day') }
}

/**
 * Instante UTC correspondente a uma hora de parede no fuso do negócio.
 *
 * Resolve em dois passos porque o deslocamento depende do próprio instante que
 * se quer descobrir: estima tratando a hora de parede como UTC, mede o
 * deslocamento ali e corrige. O segundo passo cobre a virada de horário de
 * verão (o Brasil não tem desde 2019, mas o método não depende disso).
 */
function businessWallTimeToUtc(
  year: number, month: number, day: number, hour: number,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, 0, 0, 0)
  const firstPass = new Date(wall - tzOffsetMs(new Date(wall), BUSINESS_TZ))
  return new Date(wall - tzOffsetMs(firstPass, BUSINESS_TZ))
}

/**
 * Data de liberação: D+`days` contados no calendário de Brasília, sempre às
 * `RELEASE_HOUR` daquele dia.
 *
 * O horário da venda não influencia o horário da liberação — só o dia. Uma
 * venda das 10h e outra das 19h do mesmo dia liberam juntas.
 */
export function releaseDateAfter(from: Date, days: number): Date {
  const { year, month, day } = businessYmd(from)
  return businessWallTimeToUtc(year, month, day + days, RELEASE_HOUR)
}

/** Data (dd/mm/aaaa) no fuso do negócio, independente da TZ do processo. */
export function formatBusinessDate(value: Date | string | number): string {
  return new Date(value).toLocaleDateString('pt-BR', { timeZone: BUSINESS_TZ })
}
