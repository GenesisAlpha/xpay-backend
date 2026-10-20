// ============================================================================
// ROTEAMENTO — leituras e gravações diretas (sem injeção)
// ----------------------------------------------------------------------------
// As conexões de conta (Whop, Stripe, PayPal) precisam saber se o roteamento
// está ligado antes de decidir entre "trocar a conta" e "adicionar mais uma".
// Esses serviços são dependência do SellerRoutingService; importar o serviço
// de volta fecharia um ciclo e a injeção do Nest receberia `undefined`. Por
// isso as consultas simples moram aqui, só com o supabase.
// ============================================================================

import { supabase } from '../../lib/supabase.client';
import { OwnProvider } from '../seller-provider/seller-provider-accounts';

export const SETTINGS_TABLE = 'seller_routing_settings';
export const ACCOUNTS_TABLE = 'seller_routing_accounts';
export const ASSIGNMENTS_TABLE = 'routing_assignments';

export interface RoutingSettingsRow {
  seller_id: string;
  enabled: boolean;
  enabled_at: string | null;
  fee_accepted_at: string | null;
  card_strategy: string | null;
  paypal_strategy: string | null;
  /** Estratégia por slot de método ({ slot: estratégia }); ausente antes da migration. */
  method_strategies?: Record<string, string> | null;
  routing_fee_pct: number | string | null;
  dispute_pause_pct: number | string | null;
  updated_by?: string | null;
  updated_at?: string | null;
}

/** Linha de configuração do seller, ou null (nunca ligou / migration pendente). */
export async function readRoutingSettings(sellerId: string): Promise<RoutingSettingsRow | null> {
  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .select('*')
    .eq('seller_id', sellerId)
    .maybeSingle();
  if (error) {
    // Tabela ausente (migration pendente) = roteamento desligado. Nunca pode
    // derrubar conexão nem venda de quem não usa o roteamento.
    console.error('[SellerRouting] leitura da configuração:', error.message);
    return null;
  }
  return (data as RoutingSettingsRow) ?? null;
}

export async function sellerRoutingEnabled(sellerId: string): Promise<boolean> {
  return Boolean((await readRoutingSettings(sellerId))?.enabled);
}

/**
 * Apelido da conta no roteamento. Só grava quando veio apelido: conta nova
 * sem linha usa o padrão (peso 100, prioridade 100), e reconectar não pode
 * apagar o apelido que o seller já deu.
 */
export async function saveRoutingLabel(args: {
  sellerId: string;
  accountId: string;
  provider: OwnProvider;
  label?: string | null;
}): Promise<void> {
  const label = String(args.label ?? '').trim().slice(0, 60);
  if (!label) return;
  const { error } = await supabase.from(ACCOUNTS_TABLE).upsert(
    {
      provider_account_id: args.accountId,
      seller_id: args.sellerId,
      provider: args.provider,
      label,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'provider_account_id' },
  );
  if (error) console.error(`[SellerRouting] apelido da conta ${args.accountId}:`, error.message);
}
