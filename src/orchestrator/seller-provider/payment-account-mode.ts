// ============================================================================
// CONTA DE PAGAMENTO DO SELLER — Koopfy Payments ou provedor externo
// ----------------------------------------------------------------------------
// O seller pode ter as duas coisas: o provedor que a Koopfy configurou para
// ele (provider_default: Clip, Whop…) e contas próprias conectadas (Stripe,
// PayPal, Whop). Antes, a conta própria ganhava em silêncio — um seller com
// Clip e uma Stripe conectada vendia pela Stripe sem ter escolhido isso.
//
// A escolha agora é explícita e fica em seller_profiles.config.payment_account:
//   'koopfy'   → cobra pela Koopfy Payments; contas próprias e roteamento não
//                entram em nenhuma decisão (config do checkout nem cobrança).
//   'external' → cobra pelas contas próprias (o comportamento de antes).
//   ausente    → quem nunca escolheu segue como estava ('external' quando há
//                conta própria cobrando). Nada muda sozinho para ninguém.
//
// Leitura direta no supabase, sem injeção: quem consulta são funções soltas
// (ownAccountsCharging) e serviços que não podem importar uns aos outros —
// ver routing-store.ts.
//
// ⚠️ O filtro vale só para ESCOLHER a conta de uma venda NOVA. Reembolso,
// webhook e captura resolvem pela conta gravada na transação e não passam
// por aqui: venda antiga em conta própria continua sendo atendida.
// ============================================================================

import { supabase } from '../../lib/supabase.client';

export type PaymentAccountMode = 'koopfy' | 'external';

const CONFIG_KEY = 'payment_account';
// A config do checkout e a cobrança leem isto a cada venda.
const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { mode: PaymentAccountMode | null; at: number }>();

export function parsePaymentAccountMode(value: unknown): PaymentAccountMode | null {
  return value === 'koopfy' || value === 'external' ? value : null;
}

/** O que o seller escolheu, ou null quando nunca escolheu. */
export async function readPaymentAccountMode(sellerId: string): Promise<PaymentAccountMode | null> {
  if (!sellerId) return null;
  const hit = cache.get(sellerId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.mode;
  const { data, error } = await supabase
    .from('seller_profiles')
    .select('config')
    .eq('id', sellerId)
    .maybeSingle();
  if (error) {
    // Sem leitura, vale o comportamento de antes: nunca derruba uma venda.
    console.error('[PaymentAccount] leitura da escolha:', error.message);
    return null;
  }
  const mode = parsePaymentAccountMode((data as any)?.config?.[CONFIG_KEY]);
  cache.set(sellerId, { mode, at: Date.now() });
  return mode;
}

/** O seller escolheu cobrar pela Koopfy Payments: contas próprias ficam de fora. */
export async function sellerUsesKoopfyPayments(sellerId: string): Promise<boolean> {
  return (await readPaymentAccountMode(sellerId)) === 'koopfy';
}

/** Grava a escolha sem tocar nas outras chaves de config. */
export async function writePaymentAccountMode(sellerId: string, mode: PaymentAccountMode): Promise<void> {
  const { data, error: readError } = await supabase
    .from('seller_profiles')
    .select('config')
    .eq('id', sellerId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  const current = (data as any)?.config;
  const config = { ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}), [CONFIG_KEY]: mode };
  const { error } = await supabase.from('seller_profiles').update({ config }).eq('id', sellerId);
  if (error) throw new Error(error.message);
  cache.set(sellerId, { mode, at: Date.now() });
}

export function forgetPaymentAccountMode(sellerId?: string): void {
  if (sellerId) cache.delete(sellerId);
  else cache.clear();
}
