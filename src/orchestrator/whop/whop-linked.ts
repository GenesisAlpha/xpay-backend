// ============================================================================
// CONTA WHOP PRÓPRIA DO SELLER — regras puras
// ----------------------------------------------------------------------------
// Modo conexão: o seller já tem conta na Whop e autoriza a Koopfy a cobrar nela
// com uma chave de API. A venda nasce e fica na conta DELE — a Koopfy não
// recebe o dinheiro, não guarda reserva e não paga repasse. Por isso:
//
//   • a cobrança vai SEM application fee (não há para onde mandar);
//   • as taxas da Koopfy na venda são zero (a remuneração é comissão de
//     afiliado, cobrada na conta dele pela própria Whop);
//   • a aprovação NÃO credita a carteira do pay.
//
// O id da conta no roteador é `whopl_<biz_…>`, para o pipeline distinguir dos
// três casos: master (`whop_main`), conectada (`whopc_…`) e própria (`whopl_…`).
// ============================================================================

const LINKED_PREFIX = 'whopl_';

/** Comissão padrão da Koopfy no modo conexão (o CRM altera por seller). */
export const DEFAULT_LINKED_COMMISSION_PCT = 3;

export function toLinkedProviderAccountId(whopAccountId: string): string {
  return `${LINKED_PREFIX}${whopAccountId}`;
}

export function isLinkedProviderAccountId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(LINKED_PREFIX);
}

export function whopAccountIdFromLinkedProviderAccountId(id: string): string {
  return id.slice(LINKED_PREFIX.length);
}

export interface WhopLinkedAccountRow {
  seller_id: string;
  /** Só existe depois que o seller conecta a conta dele. */
  whop_account_id: string | null;
  company_title: string | null;
  api_key: string | null;
  api_url: string | null;
  webhook_id: string | null;
  webhook_secret: string | null;
  status: 'allowed' | 'active' | 'invalid' | 'disabled';
  commission_pct: number;
  affiliate_id: string | null;
  affiliate_code: string | null;
  affiliate_override_id: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Motivo para não cobrar nesta conta, ou null quando ela está pronta. */
export function linkedChargeBlocker(row: WhopLinkedAccountRow | null): string | null {
  if (!row) return 'seller sem conta Whop própria conectada';
  if (row.status === 'disabled') return 'conexão desligada pela equipe';
  if (row.status === 'allowed') return 'modo liberado, mas o seller ainda não conectou a conta dele';
  if (row.status === 'invalid') return `chave de API recusada pela Whop${row.last_error ? `: ${row.last_error}` : ''}`;
  if (!row.whop_account_id?.startsWith('biz_')) return 'conta Whop sem id válido';
  return null;
}

/** O que o painel do seller vê da conta externa — sem detalhe interno nosso. */
export interface SellerExternalProviderView {
  /** A equipe liberou o modo: o painel oferece "Conecte seu provedor externo". */
  allowed: boolean;
  connected: boolean;
  provider: 'whop';
  accountName: string | null;
  commissionPct: number;
  /** Cobrando na conta dele (conectada e sem impedimento). */
  charging: boolean;
  /** Recado para ele agir — chave recusada, por exemplo. */
  attention: string | null;
}

/**
 * Traduz a visão interna (CRM) para o painel do seller: nada de id de afiliado,
 * override ou recado operacional nosso — só o que ele precisa fazer.
 */
export function sellerExternalProviderView(view: any): SellerExternalProviderView | null {
  if (!view || !view.allowed) return null;
  const connected = Boolean(view.connected);
  return {
    allowed: true,
    connected,
    provider: 'whop',
    accountName: view.companyTitle ?? null,
    commissionPct: Number(view.commissionPct ?? DEFAULT_LINKED_COMMISSION_PCT),
    charging: connected && view.status === 'active' && !view.blocker,
    attention:
      connected && view.status === 'invalid'
        ? 'A Whop recusou a chave de API. Gere uma nova e conecte de novo.'
        : null,
  };
}

/**
 * Comissão da Koopfy na venda, em centavos de USD. É só o registro do que a
 * Whop vai creditar como afiliado — não sai da carteira de ninguém aqui.
 */
export function linkedCommissionCents(grossUsdCents: number, commissionPct: number): number {
  const gross = Math.max(0, Math.round(Number(grossUsdCents) || 0));
  const pct = Number(commissionPct) || 0;
  if (gross <= 0 || pct <= 0) return 0;
  return Math.round((gross * pct) / 100);
}
