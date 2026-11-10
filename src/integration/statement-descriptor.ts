import { connectedStatementDescriptor } from '../orchestrator/whop/whop-connected';

// Nome que aparece na fatura do cartão do comprador, para o painel do seller
// (detalhe da transação). Só quando é certo: na conta própria do seller o
// descritor é o dele (não sabemos) e fora do cartão não há fatura.

const CARD_METHODS = new Set(['credit_card', 'card', 'debit_card', 'apple_pay', 'google_pay']);

export function statementDescriptorFor(
  provider: unknown,
  method: unknown,
  ownAccount: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (ownAccount) return null;
  if (!CARD_METHODS.has(String(method ?? '').toLowerCase())) return null;
  const p = String(provider ?? '').toLowerCase();
  // Whop (master e conectadas): produto da cobrança com WHOP*KOOPFY.
  if (p === 'whop') return connectedStatementDescriptor(env.WHOP_CONNECTED_STATEMENT_DESCRIPTOR);
  // Kaja: Koopfy como vendedora de registro, KOOPFY + telefone de atendimento.
  if (p === 'kaja') {
    const phone = String(env.KOOPFY_SUPPORT_PHONE ?? '').trim();
    return phone ? `KOOPFY ${phone}` : 'KOOPFY';
  }
  return null;
}
