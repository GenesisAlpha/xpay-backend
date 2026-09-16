/**
 * Quando a comissão de uma venda cai na carteira do afiliado.
 *
 * O afiliado recebe em data fixa do mês (`payoutDay`), e cada ciclo fecha um
 * período: só entra o que já passou da carência (`holdDays`) na data do ciclo.
 * Com dia 30 e carência de 15, o pagamento do dia 30 cobre as vendas do dia 1
 * ao 15; o resto vai para o ciclo seguinte.
 *
 * Função pura de propósito — é a regra que decide dinheiro, e regra de dinheiro
 * precisa ser testável sem banco.
 */

export interface PayoutCycle {
  /** Dia do mês do pagamento (1–31). 31 num mês curto cai no último dia. */
  payoutDay: number
  /** Dias mínimos entre a venda e o pagamento. */
  holdDays: number
}

export const DEFAULT_PAYOUT_CYCLE: PayoutCycle = { payoutDay: 30, holdDays: 15 }

const DAY_MS = 24 * 60 * 60 * 1000

/** Data do ciclo naquele mês, encurtada quando o mês não tem o dia. */
function cycleDateIn(year: number, monthIndex: number, payoutDay: number): Date {
  const lastDayOfMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  const day = Math.min(payoutDay, lastDayOfMonth)
  // Meio-dia UTC: longe das bordas onde um fuso jogaria o pagamento pro dia
  // anterior ou seguinte.
  return new Date(Date.UTC(year, monthIndex, day, 12, 0, 0))
}

/**
 * Primeira data de ciclo em que esta comissão pode ser paga.
 *
 * `saleAvailableAt` é a liquidação da própria venda: a Koopfy não paga comissão
 * sobre receita que ainda não recebeu, então nunca sai antes disso.
 */
export function nextPayoutDate(
  saleDate: Date,
  saleAvailableAt: Date,
  cycle: PayoutCycle = DEFAULT_PAYOUT_CYCLE,
): Date {
  const holdUntil = new Date(saleDate.getTime() + cycle.holdDays * DAY_MS)
  const earliest = holdUntil > saleAvailableAt ? holdUntil : saleAvailableAt

  const candidate = cycleDateIn(earliest.getUTCFullYear(), earliest.getUTCMonth(), cycle.payoutDay)
  if (candidate >= earliest) return candidate

  // O ciclo deste mês já passou do que esta venda alcança — vai pro próximo.
  return cycleDateIn(earliest.getUTCFullYear(), earliest.getUTCMonth() + 1, cycle.payoutDay)
}

/** Sanitiza o que vem do CRM antes de virar regra de pagamento. */
export function normalizeCycle(input: Partial<PayoutCycle> | null | undefined): PayoutCycle {
  const payoutDay = Number(input?.payoutDay)
  const holdDays = Number(input?.holdDays)

  return {
    payoutDay: Number.isInteger(payoutDay) && payoutDay >= 1 && payoutDay <= 31
      ? payoutDay
      : DEFAULT_PAYOUT_CYCLE.payoutDay,
    // Teto de 90 dias: acima disso não é carência, é retenção — e retenção
    // precisa de decisão humana, não de um número no banco.
    holdDays: Number.isInteger(holdDays) && holdDays >= 0 && holdDays <= 90
      ? holdDays
      : DEFAULT_PAYOUT_CYCLE.holdDays,
  }
}
