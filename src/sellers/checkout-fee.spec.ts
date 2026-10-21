// Taxa de checkout única: a origem decide o que cada formato cobra, e a
// última escrita (plano ou CRM) vence.
const tables: Record<string, any[]> = {}

jest.mock('../lib/supabase.client', () => {
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = []
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return builder },
      in: (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return builder },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: rows(), error: null }),
      insert: async (row: any) => { (tables[table] ??= []).push({ ...row }); return { error: null } },
      update: (patch: any) => {
        const inner: any = {
          eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return inner },
          then: (resolve: any) => { for (const r of rows()) Object.assign(r, patch); return resolve({ error: null }) },
        }
        return inner
      },
    }
    return builder
  }
  return { supabase: { from } }
})

import { BadRequestException, UnauthorizedException } from '@nestjs/common'
import {
  DEFAULT_FEE_SETTINGS,
  DEFAULT_SELLER_FEES,
  checkoutFeeIsUnified,
  onboardingFeeRow,
  sellerFeesFromRow,
  sellerFeesRow,
} from '../shared/fee.calculator'
import { checkoutFeeWrite } from '../crm/fee-config'
import { ownSaleCommissionPct } from '../orchestrator/seller-provider/seller-provider-accounts'
import { ownAccountCommissionUsdCents, ownAccountFeeLines } from '../orchestrator/routing/seller-routing'
import { checkoutFeeOfOwner, parseCheckoutFeePct, planWriteApplies, writePlanCheckoutFee } from './checkout-fee'
import { CheckoutFeeInternalController } from './checkout-fee-internal.controller'

const row = (over: Record<string, unknown> = {}) => ({
  seller_id: 's1', risk_level: 'WHITE', ...sellerFeesRow(DEFAULT_FEE_SETTINGS), ...over,
})

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key]
  tables.users = [{ id: 'u1', email: 'dono@loja.com' }, { id: 'u2', email: 'dono+conta-1@loja.com', owner_user_id: 'u1' }]
  tables.seller_profiles = [{ id: 's2', user_id: 'u2', risk_level: 'WHITE' }, { id: 's1', user_id: 'u1', risk_level: 'GRAY' }]
})

describe('origem da taxa (legacy × plano × CRM)', () => {
  it('linha sem origem (antes da migration) e seller sem linha são legacy', () => {
    expect(sellerFeesFromRow(row()).checkoutFeeSource).toBe('legacy')
    expect(sellerFeesFromRow(row({ checkout_fee_source: 'plan' })).checkoutFeeSource).toBe('plan')
    expect(DEFAULT_SELLER_FEES.checkoutFeeSource).toBe('legacy')
    expect(checkoutFeeIsUnified(DEFAULT_SELLER_FEES)).toBe(false)
  })

  it('conta própria legacy: o percentual do CRM ou 3% (como antes)', () => {
    const legacy = sellerFeesFromRow(row({ checkout_fee_pct: 1.9 }))
    expect(ownSaleCommissionPct(legacy, null)).toBe(3)
    expect(ownSaleCommissionPct(legacy, 2.2)).toBe(2.2)
    expect(ownSaleCommissionPct(null, undefined)).toBe(3)
  })

  it('conta própria com taxa única (plano ou CRM): a taxa de checkout, não a do CRM antigo', () => {
    expect(ownSaleCommissionPct(sellerFeesFromRow(row({ checkout_fee_pct: 2.1, checkout_fee_source: 'plan' })), 3)).toBe(2.1)
    expect(ownSaleCommissionPct(sellerFeesFromRow(row({ checkout_fee_pct: 2, checkout_fee_source: 'crm' })), 3)).toBe(2)
  })

  it('roteamento entra uma vez, à parte, só quando ligado', () => {
    // PRO (2,1%) com roteamento: 2,1 + 0,8 sobre US$ 100.
    expect(ownAccountCommissionUsdCents(10_000, 2.1, 0.8)).toBe(290)
    expect(ownAccountFeeLines(10_000, 2.1, 0.8)).toEqual({ checkout_fee_usd_cents: 210, routing_fee_usd_cents: 80 })
    expect(ownAccountFeeLines(10_000, 2.1, 0)).toEqual({ checkout_fee_usd_cents: 210, routing_fee_usd_cents: 0 })
    expect(ownAccountCommissionUsdCents(10_000, 2.1, 0)).toBe(210)
  })
})

describe('CRM grava a origem', () => {
  it('mudou "Checkout (%)": origem crm com a hora', () => {
    const now = new Date('2026-10-21T12:00:00Z')
    expect(checkoutFeeWrite(DEFAULT_FEE_SETTINGS, { ...DEFAULT_FEE_SETTINGS, checkoutFeePct: 2 }, now))
      .toEqual({ checkout_fee_source: 'crm', checkout_fee_updated_at: '2026-10-21T12:00:00.000Z' })
  })

  it('editou outra taxa: não mexe na origem', () => {
    expect(checkoutFeeWrite(DEFAULT_FEE_SETTINGS, { ...DEFAULT_FEE_SETTINGS, processingFeePct: 7 })).toEqual({})
  })
})

describe('seller novo', () => {
  it('nasce com 2,5% (gratuito), origem plan', () => {
    const r = onboardingFeeRow(null, new Date('2026-10-21T00:00:00Z'))
    expect(r).toMatchObject({ checkout_fee_pct: 2.5, checkout_fee_source: 'plan', processing_fee_pct: 8.9 })
  })

  it('reenvio do onboarding mantém a taxa e a origem que já estavam', () => {
    expect(onboardingFeeRow({ checkout_fee_pct: 1.9, checkout_fee_source: null, checkout_fee_updated_at: null }))
      .toMatchObject({ checkout_fee_pct: 1.9, checkout_fee_source: 'legacy' })
  })
})

describe('escrita do plano (PUT internal/sellers/checkout-fee)', () => {
  it('grava o padrão do plano em todas as contas do dono, com a soma refeita', async () => {
    tables.seller_fees = [row({ seller_id: 's1', checkout_fee_pct: 1.9, checkout_fee_source: 'legacy' })]
    const res = await writePlanCheckoutFee({ email: 'DONO@loja.com', pct: 2.3, effectiveAt: '2026-10-21T10:00:00.000Z' })
    expect(res.sellers.map((s) => [s.sellerId, s.applied])).toEqual([['s1', true], ['s2', true]])
    const s1 = tables.seller_fees.find((r) => r.seller_id === 's1')
    expect(s1).toMatchObject({ checkout_fee_pct: 2.3, checkout_fee_source: 'plan', checkout_fee_updated_at: '2026-10-21T10:00:00.000Z', fee_percentage: 12.1 })
    // Conta extra sem linha: nasce com a tarifa padrão e a taxa do plano.
    expect(tables.seller_fees.find((r) => r.seller_id === 's2')).toMatchObject({ checkout_fee_pct: 2.3, checkout_fee_source: 'plan', risk_level: 'WHITE' })
  })

  it('CRM depois do plano: um retry atrasado do plano não desfaz o CRM', async () => {
    tables.seller_fees = [row({ seller_id: 's1', checkout_fee_pct: 2, checkout_fee_source: 'crm', checkout_fee_updated_at: '2026-10-21T11:00:00.000Z' })]
    const res = await writePlanCheckoutFee({ email: 'dono@loja.com', pct: 2.3, effectiveAt: '2026-10-21T10:00:00.000Z' })
    expect(res.sellers[0]).toMatchObject({ sellerId: 's1', applied: false, pct: 2, source: 'crm' })
    expect(tables.seller_fees[0]).toMatchObject({ checkout_fee_pct: 2, checkout_fee_source: 'crm' })
  })

  it('plano depois do CRM: a troca nova volta ao padrão do plano', async () => {
    tables.seller_fees = [row({ seller_id: 's1', checkout_fee_pct: 2, checkout_fee_source: 'crm', checkout_fee_updated_at: '2026-10-21T11:00:00.000Z' })]
    await writePlanCheckoutFee({ email: 'dono@loja.com', pct: 2.1, effectiveAt: '2026-10-22T09:00:00.000Z' })
    expect(tables.seller_fees[0]).toMatchObject({ checkout_fee_pct: 2.1, checkout_fee_source: 'plan' })
  })

  it('repetir a mesma escrita é idempotente', async () => {
    tables.seller_fees = [row({ seller_id: 's1' })]
    const args = { email: 'dono@loja.com', pct: 2.4, effectiveAt: '2026-10-21T10:00:00.000Z' }
    await writePlanCheckoutFee(args)
    const res = await writePlanCheckoutFee(args)
    expect(res.sellers[0]).toMatchObject({ applied: true, pct: 2.4 })
    expect(tables.seller_fees.filter((r) => r.seller_id === 's1')).toHaveLength(1)
  })

  it('a leitura devolve a conta principal com a origem', async () => {
    tables.seller_fees = [row({ seller_id: 's1', checkout_fee_pct: 1.9 })]
    expect(await checkoutFeeOfOwner('dono@loja.com')).toEqual({ sellerId: 's1', pct: 1.9, source: 'legacy', updatedAt: null })
    expect(await checkoutFeeOfOwner('ninguem@x.com')).toBeNull()
  })

  it('planWriteApplies e a faixa do pct', () => {
    expect(planWriteApplies(null, '2026-10-21T00:00:00Z')).toBe(true)
    expect(planWriteApplies('2026-10-22T00:00:00Z', '2026-10-21T00:00:00Z')).toBe(false)
    expect(parseCheckoutFeePct('2,3')).toBe(2.3)
    expect(() => parseCheckoutFeePct(80)).toThrow(BadRequestException)
    expect(() => parseCheckoutFeePct(null)).toThrow(BadRequestException)
  })
})

describe('CheckoutFeeInternalController', () => {
  const controller = new CheckoutFeeInternalController()
  beforeEach(() => { process.env.INTERNAL_API_KEY = 'k' })

  it('exige a chave interna', async () => {
    await expect(controller.get('errada', 'dono@loja.com')).rejects.toBeInstanceOf(UnauthorizedException)
    expect(() => controller.put('errada', {})).toThrow(UnauthorizedException)
  })

  it("só aceita source 'plan' e grava", async () => {
    expect(() => controller.put('k', { email: 'dono@loja.com', pct: 2.3, source: 'crm' })).toThrow(BadRequestException)
    tables.seller_fees = [row({ seller_id: 's1' })]
    const res = await controller.put('k', { email: 'dono@loja.com', pct: 2.3, source: 'plan', effectiveAt: '2026-10-21T10:00:00Z' })
    expect(res.sellers[0]).toMatchObject({ sellerId: 's1', pct: 2.3, source: 'plan', applied: true })
  })
})
