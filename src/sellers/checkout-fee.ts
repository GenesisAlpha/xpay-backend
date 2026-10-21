// Taxa de checkout única do seller (seller_fees.checkout_fee_pct).
//
// Vale para toda venda, de qualquer formato, e a última escrita vence:
//   • o checkout grava o padrão do plano da conta (PUT internal/sellers/checkout-fee);
//   • a equipe grava pelo CRM ("Checkout (%)", crm.service).
// Quem ainda está em 'legacy' continua pagando o que pagava (ver
// checkoutFeeIsUnified em shared/fee.calculator.ts).

import { BadRequestException } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import {
  DEFAULT_FEE_SETTINGS,
  type CheckoutFeeSource,
  sellerFeesFromRow,
  sellerFeesRow,
} from '../shared/fee.calculator'
import { normalizeEmail } from '../integration/seller-accounts'

export interface CheckoutFeeView {
  sellerId: string
  pct: number
  source: CheckoutFeeSource
  updatedAt: string | null
}

/** Faixa aceita: a mesma do campo "Checkout (%)" do CRM. */
export function parseCheckoutFeePct(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw.replace(',', '.')) : Number(raw)
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(value) || value < 0 || value > 50) {
    throw new BadRequestException('pct inválido: use um valor entre 0 e 50.')
  }
  return Math.round(value * 100) / 100
}

/**
 * A escrita do plano vale? Só se for mais nova que a última gravação: o
 * retry atrasado de uma troca de plano não pode desfazer uma edição do CRM
 * (nem uma troca de plano) que veio depois.
 */
export function planWriteApplies(currentUpdatedAt: string | null | undefined, effectiveAt: string): boolean {
  if (!currentUpdatedAt) return true
  const current = Date.parse(currentUpdatedAt)
  const next = Date.parse(effectiveAt)
  if (!Number.isFinite(current) || !Number.isFinite(next)) return true
  return next >= current
}

/**
 * Sellers do dono do e-mail: a conta principal primeiro, depois as criadas a
 * mais por ele. O plano é da conta inteira, então vale para todas.
 */
export async function sellerIdsOfOwnerEmail(email: string): Promise<string[]> {
  const { data: owner } = await supabase.from('users').select('id').eq('email', normalizeEmail(email)).maybeSingle()
  if (!owner?.id) return []
  const { data: users } = await supabase.from('users').select('id').eq('owner_user_id', owner.id)
  const userIds = [owner.id, ...((users ?? []) as Array<{ id: string }>).map((u) => u.id)]
  const { data: sellers } = await supabase.from('seller_profiles').select('id, user_id').in('user_id', userIds)
  const rows = (sellers ?? []) as Array<{ id: string; user_id: string }>
  return rows
    .sort((a, b) => (a.user_id === owner.id ? -1 : b.user_id === owner.id ? 1 : 0))
    .map((s) => String(s.id))
}

async function feeRow(sellerId: string): Promise<Record<string, any> | null> {
  const { data } = await supabase.from('seller_fees').select('*').eq('seller_id', sellerId).maybeSingle()
  return (data as Record<string, any> | null) ?? null
}

function view(sellerId: string, row: Record<string, any> | null): CheckoutFeeView {
  const fees = row ? sellerFeesFromRow({ seller_id: sellerId, ...row }) : null
  return {
    sellerId,
    pct: fees ? fees.checkoutFeePct : DEFAULT_FEE_SETTINGS.checkoutFeePct,
    source: fees ? fees.checkoutFeeSource : 'legacy',
    updatedAt: fees ? fees.checkoutFeeUpdatedAt : null,
  }
}

/** A taxa da conta principal do dono (o checkout lê para as vendas que só ele vê). */
export async function checkoutFeeOfOwner(email: string): Promise<CheckoutFeeView | null> {
  const [main] = await sellerIdsOfOwnerEmail(email)
  if (!main) return null
  return view(main, await feeRow(main))
}

/**
 * Grava o padrão do plano em todas as contas do dono. Idempotente: repetir a
 * mesma escrita não muda nada, e escrita mais velha que a última é ignorada.
 */
export async function writePlanCheckoutFee(args: { email: string; pct: number; effectiveAt: string }) {
  const ids = await sellerIdsOfOwnerEmail(args.email)
  const results: Array<CheckoutFeeView & { applied: boolean }> = []
  for (const sellerId of ids) {
    const row = await feeRow(sellerId)
    if (row && !planWriteApplies(row.checkout_fee_updated_at, args.effectiveAt)) {
      results.push({ ...view(sellerId, row), applied: false })
      continue
    }
    // A linha toda é regravada a partir da leitura (fee_percentage é a soma);
    // só a taxa de checkout e a origem mudam.
    const base = row ? sellerFeesFromRow({ seller_id: sellerId, ...row }) : { ...DEFAULT_FEE_SETTINGS }
    const patch = {
      ...sellerFeesRow({ ...base, checkoutFeePct: args.pct }),
      checkout_fee_source: 'plan' as const,
      checkout_fee_updated_at: args.effectiveAt,
      updated_at: new Date().toISOString(),
    }
    if (row) {
      const { error } = await supabase.from('seller_fees').update(patch).eq('seller_id', sellerId)
      if (error) throw new Error(`seller_fees: ${error.message}`)
    } else {
      const { data: profile } = await supabase.from('seller_profiles').select('risk_level').eq('id', sellerId).maybeSingle()
      const { error } = await supabase.from('seller_fees').insert({
        seller_id: sellerId,
        risk_level: profile?.risk_level ?? 'WHITE',
        anticipation_days: 0,
        ...patch,
      })
      if (error) throw new Error(`seller_fees: ${error.message}`)
    }
    results.push({ sellerId, pct: args.pct, source: 'plan', updatedAt: args.effectiveAt, applied: true })
  }
  return { sellers: results }
}
