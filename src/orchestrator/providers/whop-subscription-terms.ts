// ============================================================================
// Assinatura Koopfy → plano recorrente da Whop
// ----------------------------------------------------------------------------
// Regra da Koopfy (definida pelo dono em 2026-09-17): o VALOR INICIAL é o que o
// cliente paga na compra, NO LUGAR da primeira mensalidade; a recorrência
// começa um ciclo depois. Com teste grátis, a recorrência começa quando o
// teste acaba. Sem valor inicial, a compra cobra a primeira mensalidade.
//
// Na Whop, `initial_price` é SOMADO à primeira cobrança de um plano sem teste,
// e com teste é tudo o que se cobra na compra. Para cobrar exatamente o valor
// inicial hoje:
//   • valor inicial ≥ mensalidade: initial_price = inicial − mensalidade, sem
//     teste (a Whop cobra a soma, que dá o inicial);
//   • valor inicial < mensalidade: initial_price = inicial e um "teste" do
//     tamanho de um ciclo. A Whop não dá teste a quem já usou teste no mesmo
//     plano — então esse caso pede um plano novo (`freshPlan`), senão um
//     cliente que volta pagaria inicial + mensalidade.
// ============================================================================

export interface KoopfySubscriptionInput {
  /** Cobrado hoje, na moeda da cobrança (já com cupom). */
  todayCharge: number;
  renewalPrice: number;
  billingPeriodDays: number;
  /** Teste grátis configurado pelo seller. */
  trialPeriodDays: number;
  /** Valor inicial do plano do seller (só importa se é > 0). */
  planInitialPrice: number;
}

export interface WhopRenewalTerms {
  initialPrice: number;
  trialPeriodDays: number;
  freshPlan: boolean;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export function whopRenewalTerms(input: KoopfySubscriptionInput): WhopRenewalTerms | { error: string } {
  const today = round2(Number(input.todayCharge));
  const renewal = round2(Number(input.renewalPrice));
  const trial = Math.floor(Number(input.trialPeriodDays) || 0);
  const hasInitial = Number(input.planInitialPrice) > 0;

  if (!Number.isFinite(today) || today < 0) return { error: 'cobrança de hoje inválida' };

  // Teste grátis do seller: hoje é só o valor inicial (ou nada).
  if (trial > 0) return { initialPrice: today, trialPeriodDays: trial, freshPlan: false };

  if (hasInitial) {
    if (today >= renewal) {
      return { initialPrice: round2(today - renewal), trialPeriodDays: 0, freshPlan: false };
    }
    // Valor inicial menor que a mensalidade: só com um ciclo de "teste".
    return { initialPrice: today, trialPeriodDays: Math.floor(Number(input.billingPeriodDays)), freshPlan: true };
  }

  // Sem valor inicial: hoje é a primeira mensalidade. Menos que ela (cupom maior
  // que a cobrança) a Whop não consegue cobrar — cobraria a mensalidade cheia.
  const initialPrice = round2(today - renewal);
  if (initialPrice < 0) return { error: 'cobrança de hoje menor que a mensalidade' };
  return { initialPrice, trialPeriodDays: 0, freshPlan: false };
}
