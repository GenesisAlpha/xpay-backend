// ============================================================================
// DESCRITOR DA COBRANÇA NO PROVIDER
// ----------------------------------------------------------------------------
// `plan.title` é o único campo que chegava ao provider dizendo O QUE foi
// vendido — e ele é lido pelo comprador (recibo e nome da assinatura na Whop).
//
// Política (2026-09-16, definida pelo dono): o catálogo do seller não sai da
// Koopfy. No lugar do nome do produto vai a LOJA + o número do pedido:
//
//   • o provider não aprende o que a loja vende (o produto viaja só como uuid
//     opaco no metadata, que é o que reconcilia a venda no webhook);
//   • o comprador reconhece a compra no recibo — é o que segura "não reconheço
//     a cobrança" — e o nome da loja o provider já conhece de qualquer forma,
//     porque é a company da conta.
//
// O nome REAL do produto continua aparecendo onde é nosso: página de checkout,
// e-mail de confirmação, área do cliente e painel do seller.
// ============================================================================

/** Limite duro da API da Whop: acima disso a compra inteira falha com 400. */
export const PLAN_TITLE_MAX = 30;

/** Pedido curto o suficiente para caber no descritor junto com a loja. */
function shortRef(orderRef: string): string {
  const ref = String(orderRef ?? '').trim().replace(/\s+/g, '');
  if (!ref) return '';
  // Sem número de pedido sobra o id da transação (uuid): os últimos 8 bastam
  // para o suporte achar a venda e cabem no descritor.
  return ref.length > 12 ? ref.slice(-8) : ref;
}

/**
 * Descritor da cobrança: `<Loja> · #<pedido>`, dentro do limite do provider.
 *
 * Sem loja conhecida, sobra o pedido. Loja comprida é cortada para o pedido
 * sobreviver inteiro — é ele que liga o recibo à compra no atendimento.
 */
export function maskedPlanTitle(
  storeName: string | null | undefined,
  orderRef: string,
  max: number = PLAN_TITLE_MAX,
): string {
  const ref = shortRef(orderRef);
  const suffix = ref ? `#${ref}` : '';
  const store = String(storeName ?? '').trim().replace(/\s+/g, ' ');

  // O pedido nunca é cortado: um número pela metade não acha a venda no
  // atendimento e não ajuda o comprador a reconhecer a compra.
  const onlyRef = () => (`Pedido ${suffix}`.length <= max ? `Pedido ${suffix}` : suffix.slice(0, max));

  if (!store) return suffix ? onlyRef() : 'Pedido';
  if (!suffix) return store.slice(0, max);

  const separator = ' · ';
  const room = max - suffix.length - separator.length;
  // Não vale cortar a loja até virar sigla: abaixo disso, só o pedido.
  if (room < 4) return onlyRef();

  const shown = store.length > room ? `${store.slice(0, room - 1).trimEnd()}…` : store;
  return `${shown}${separator}${suffix}`;
}
