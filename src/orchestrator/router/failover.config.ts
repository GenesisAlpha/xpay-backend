import { ProviderName } from '../provider-accounts.config';

// ============================================================================
// FAILOVER CROSS-PSP — para onde o pagamento vai quando o pool preferido acaba
// ----------------------------------------------------------------------------
// POR QUE ISTO EXISTE. Um pool de contas Stripe protege contra a restrição de
// UM titular. Não protege contra o que de fato para a operação: a Stripe
// decidir que o segmento inteiro não serve, e restringir os titulares em
// cascata (é assim que costuma acontecer — o linking é automático e o gatilho
// é o mesmo produto). Contra isso, a única defesa é não ser um PSP só.
//
// A cadeia abaixo é por MÉTODO porque a alternativa real muda com o método:
// quem substitui Stripe no cartão não é quem substitui no Pix.
//
// ⚠️ O FAILOVER NÃO ATRAVESSA UM PEDIDO. Toda tentativa do mesmo pedido cai na
// mesma conta (stickiness) — com titulares independentes, reembolso parcial
// atravessando dois PSPs não tem solução: o saldo está em entidades
// diferentes. A troca acontece ENTRE pedidos, nunca dentro de um.
//
// ⚠️ E NÃO É PARA ESCONDER VOLUME. Trocar de PSP porque o atual restringiu a
// operação por risco, sem consertar a causa, só transfere o problema — com um
// agravante: o histórico segue via bureaus de merchant (MATCH/Terminated
// Merchant File) e a próxima aprovação fica mais difícil, não menos. A cadeia
// existe para continuidade durante o conserto, não no lugar dele.
// ============================================================================

export const FAILOVER_CHAIN: Record<string, ProviderName[]> = {
  card:       ['stripe', 'whop', 'rox_pay', 'setinel_gate', 'approvebly'],
  apple_pay:  ['stripe', 'whop', 'setinel_gate'],
  google_pay: ['stripe', 'whop', 'setinel_gate'],
  link:       ['stripe'],
  pix:        ['approvebly', 'whop'],
  boleto:     ['approvebly'],
  mbway:      ['setinel_gate'],
  crypto:     ['coinflow', 'whop'],
};

// Usada quando o método não está no mapa (ou não veio). Deliberadamente curta:
// mandar um método desconhecido para cinco PSPs em sequência gasta segundos do
// comprador para falhar cinco vezes.
export const FAILOVER_CHAIN_DEFAULT: ProviderName[] = ['stripe', 'whop'];

// ─────────────────────────────────────────────
// Quantos PSPs tentar numa mesma requisição.
//
// Cada elo custa uma ida à API do provider dentro do tempo em que o comprador
// está olhando um spinner. Dois elos cobrem o caso real (o preferido caiu);
// cinco cobrem uma fantasia e entregam um checkout que trava por 40 segundos
// antes de dizer que não deu.
// ─────────────────────────────────────────────
export const FAILOVER_MAX_HOPS = 2;

export function failoverChainFor(method?: string): ProviderName[] {
  if (!method) return FAILOVER_CHAIN_DEFAULT;
  return FAILOVER_CHAIN[String(method).toLowerCase()] ?? FAILOVER_CHAIN_DEFAULT;
}

// Cadeia a partir do provider preferido: mantém a ordem do mapa e remove o que
// já foi tentado. Se o preferido não está na cadeia do método (configuração
// incoerente), ele ainda é tentado primeiro — a preferência explícita do seller
// ganha do mapa.
export function buildFailoverOrder(args: {
  preferred?: string | null;
  method?: string;
}): ProviderName[] {
  const chain = failoverChainFor(args.method);
  const preferred = args.preferred?.toLowerCase() as ProviderName | undefined;

  if (!preferred) return chain.slice(0, FAILOVER_MAX_HOPS + 1);

  const rest = chain.filter(p => p !== preferred);
  return [preferred, ...rest].slice(0, FAILOVER_MAX_HOPS + 1);
}
