// ============================================================================
// CONTAS POR LINK NO ROTEAMENTO — leituras e gravações
// ----------------------------------------------------------------------------
// Conta por link = o comprador paga fora do checkout da Koopfy: loja Shopify
// do seller (checkout da Shopify com Shopify Payments) ou conta Digistore24
// (formulário de pedido padrão da conta, só em oferta digital de pagamento
// único — quem decide é o backend, pelo `linkProviders` do config). O pay não
// tem credencial nem cobra nela: o backend do checkout registra a conta aqui e
// informa cada venda (aprovada, estornada, disputada), que alimenta a mesma
// estatística e os mesmos tetos das contas que o pay cobra.
// ============================================================================

import { BadRequestException } from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';
import { StatsTxRow, TodayTxRow, toDigistoreLinkAccountId, toShopifyLinkAccountId } from './seller-routing';

export const LINK_ACCOUNTS_TABLE = 'seller_link_accounts';
export const LINK_SALES_TABLE = 'routing_link_sales';

export type LinkProvider = 'shopify' | 'digistore24';
const LINK_PROVIDER_LIST: LinkProvider[] = ['shopify', 'digistore24'];
export type LinkSaleStatus = 'approved' | 'refunded' | 'partially_refunded' | 'chargeback';

export interface LinkAccountRow {
  id: string;
  seller_id: string;
  provider: LinkProvider;
  external_ref: string;
  display_name: string | null;
  shop_domain: string | null;
  currencies: string[] | null;
  status: 'active' | 'disabled';
  created_at: string | null;
}

const REF_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SALE_STATUSES: LinkSaleStatus[] = ['approved', 'refunded', 'partially_refunded', 'chargeback'];

export function linkAccountId(row: Pick<LinkAccountRow, 'id' | 'provider'>): string {
  return row.provider === 'digistore24' ? toDigistoreLinkAccountId(row.id) : toShopifyLinkAccountId(row.id);
}

/** Métodos que a conta por link atende (o checkout dela): só o slot do cartão. */
export function linkMethodsOf(provider: LinkProvider): string[] {
  return provider === 'digistore24' ? ['digistore_checkout'] : ['shopify_checkout'];
}

export function parseLinkProvider(value: unknown): LinkProvider {
  if (!LINK_PROVIDER_LIST.includes(value as LinkProvider)) throw new BadRequestException('Provedor por link inválido.');
  return value as LinkProvider;
}

export function parseExternalRef(value: unknown): string {
  const ref = String(value ?? '').trim();
  if (!REF_RE.test(ref)) throw new BadRequestException('Referência da conta inválida.');
  return ref;
}

export function parseCurrencies(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(item => String(item).trim().toUpperCase()).filter(code => /^[A-Z]{3}$/.test(code)))).slice(0, 250);
}

export interface LinkSaleInput {
  saleRef: string;
  status: LinkSaleStatus;
  amountUsdGrossCents: number;
  disputed: boolean;
  /** Só na aprovação: estorno e disputa mantêm o dia original da venda. */
  occurredAt: string | null;
}

export function parseLinkSale(body: any): LinkSaleInput {
  const saleRef = String(body?.saleRef ?? '').trim();
  if (!/^[A-Za-z0-9_:.-]{1,128}$/.test(saleRef)) throw new BadRequestException('Referência da venda inválida.');
  const status = String(body?.status ?? '') as LinkSaleStatus;
  if (!SALE_STATUSES.includes(status)) throw new BadRequestException('Situação da venda inválida.');
  const amount = Number(body?.amountUsdGrossCents);
  if (!Number.isInteger(amount) || amount < 0 || amount > 1e12) throw new BadRequestException('Valor da venda inválido.');
  let occurredAt: string | null = null;
  if (body?.occurredAt) {
    const at = Date.parse(String(body.occurredAt));
    if (!Number.isFinite(at)) throw new BadRequestException('Data da venda inválida.');
    occurredAt = new Date(at).toISOString();
  }
  return { saleRef, status, amountUsdGrossCents: amount, disputed: body?.disputed === true, occurredAt };
}

export async function listLinkRows(sellerId: string): Promise<LinkAccountRow[]> {
  const { data, error } = await supabase.from(LINK_ACCOUNTS_TABLE).select('*').eq('seller_id', sellerId);
  if (error) {
    // Tabela ausente (migration não aplicada) = sem contas por link.
    console.error('[RoutingLinks] leitura das contas por link:', error.message);
    return [];
  }
  return (Array.isArray(data) ? data : []) as LinkAccountRow[];
}

export async function findLinkRow(sellerId: string, provider: LinkProvider, externalRef: string): Promise<LinkAccountRow | null> {
  const { data, error } = await supabase.from(LINK_ACCOUNTS_TABLE).select('*')
    .eq('seller_id', sellerId).eq('provider', provider).eq('external_ref', externalRef).maybeSingle();
  if (error) throw new BadRequestException(`Não foi possível consultar a conta por link: ${error.message}`);
  return (data as LinkAccountRow) ?? null;
}

export async function upsertLinkRow(sellerId: string, input: {
  provider: LinkProvider; externalRef: string; displayName: string | null; shopDomain: string | null; currencies: string[];
}): Promise<{ row: LinkAccountRow; created: boolean }> {
  const existing = await findLinkRow(sellerId, input.provider, input.externalRef);
  const { data, error } = await supabase.from(LINK_ACCOUNTS_TABLE).upsert({
    ...(existing ? { id: existing.id } : {}),
    seller_id: sellerId, provider: input.provider, external_ref: input.externalRef,
    display_name: input.displayName, shop_domain: input.shopDomain, currencies: input.currencies,
    status: 'active', updated_at: new Date().toISOString(),
  }, { onConflict: 'seller_id,provider,external_ref' }).select('*').single();
  if (error || !data) throw new BadRequestException(`Não foi possível registrar a conta no roteamento: ${error?.message ?? 'sem retorno'}`);
  return { row: data as LinkAccountRow, created: !existing };
}

export async function disableLinkRow(sellerId: string, provider: LinkProvider, externalRef: string): Promise<LinkAccountRow | null> {
  const { data, error } = await supabase.from(LINK_ACCOUNTS_TABLE)
    .update({ status: 'disabled', updated_at: new Date().toISOString() })
    .eq('seller_id', sellerId).eq('provider', provider).eq('external_ref', externalRef).select('*').maybeSingle();
  if (error) throw new BadRequestException(`Não foi possível desligar a conta no roteamento: ${error.message}`);
  return (data as LinkAccountRow) ?? null;
}

export async function upsertLinkSale(sellerId: string, accountId: string, sale: LinkSaleInput) {
  const { error } = await supabase.from(LINK_SALES_TABLE).upsert({
    provider_account_id: accountId, seller_id: sellerId, sale_ref: sale.saleRef, status: sale.status,
    amount_usd_gross_cents: sale.amountUsdGrossCents, disputed: sale.disputed,
    ...(sale.occurredAt ? { created_at: sale.occurredAt } : {}), updated_at: new Date().toISOString(),
  }, { onConflict: 'provider_account_id,sale_ref' });
  if (error) throw new BadRequestException(`Não foi possível registrar a venda no roteamento: ${error.message}`);
}

/** Vendas por link desde `sinceIso`, no formato das transações do roteamento. */
export async function loadLinkSales(sellerId: string, ids: string[], sinceIso: string, limit: number): Promise<Array<StatsTxRow & TodayTxRow>> {
  if (!ids.length) return [];
  const { data, error } = await supabase.from(LINK_SALES_TABLE)
    .select('provider_account_id, status, amount_usd_gross_cents, disputed')
    .eq('seller_id', sellerId).in('provider_account_id', ids).gte('created_at', sinceIso).limit(limit);
  if (error) {
    console.error('[RoutingLinks] vendas por link:', error.message);
    return [];
  }
  return (Array.isArray(data) ? data : []).map((row: any) => ({
    provider_account_id: row.provider_account_id,
    status: row.status,
    amount_usd_gross_cents: row.amount_usd_gross_cents,
    link_dispute: row.disputed === true || undefined,
  }));
}
