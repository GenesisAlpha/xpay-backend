import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { supabase } from '../../lib/supabase.client'
import { getActiveProviderAccounts } from '../provider-accounts.config'
import { kontinoConfigurado } from '../kontino/kontino'
import {
  METHOD_CATALOG, PROVIDER_LABEL, normalizeMethod, resolveMethodRoute, validateRule,
  type MethodRoute, type MethodRouteRule, type ProviderAvailability, type RoutedProvider,
} from './method-routing'

const CACHE_MS = 20_000

/** Provedores que dependem de contas do pool estático (provider-accounts.config). */
const STATIC_POOL: ReadonlySet<string> = new Set(['approvebly', 'setinel_gate', 'rox_pay', 'coinflow'])

/**
 * Provedor por método: regras no banco (payment_method_routes), cache curto e
 * disponibilidade de cada provedor. Ver method-routing.ts.
 */
@Injectable()
export class MethodRoutingService {
  private cache: { at: number; rules: MethodRouteRule[] } | null = null

  async rules(): Promise<MethodRouteRule[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.rules
    const { data, error } = await supabase
      .from('payment_method_routes')
      .select('id, method, country, currency, seller_id, providers, enabled')
    if (error) {
      // Tabela ainda não criada (migration pendente) ou falha de leitura: sem
      // regra = comportamento antigo. Nunca derruba a cobrança.
      console.error('[MethodRouting] regras indisponíveis, seguindo sem regra:', error.message)
      return this.cache?.rules ?? []
    }
    this.cache = { at: Date.now(), rules: (data ?? []) as MethodRouteRule[] }
    return this.cache.rules
  }

  invalidate() { this.cache = null }

  /**
   * Disponível = dá para tentar cobrar. Kaja ainda não tem integração (API e
   * credenciais pendentes): fica configurável e é pulada. Whop/Stripe/PayPal/
   * Slash/Clip dependem da conta do seller ou do pool dinâmico: o router decide
   * por cobrança, então aqui contam como disponíveis.
   */
  availability(): ProviderAvailability {
    const stat = getActiveProviderAccounts() as Array<{ provider: string }>
    const out: ProviderAvailability = {}
    for (const p of Object.keys(PROVIDER_LABEL)) {
      if (p === 'kontino') {
        out[p] = kontinoConfigurado()
          ? { available: true }
          : { available: false, reason: 'KONTINO_SECRET_KEY não configurada' }
      } else if (p === 'kaja') {
        out[p] = { available: false, reason: 'Aguardando a API e as credenciais da Kaja Payments' }
      } else if (STATIC_POOL.has(p)) {
        const n = stat.filter(a => String(a.provider) === p).length
        out[p] = n > 0 ? { available: true } : { available: false, reason: 'Nenhuma conta ativa' }
      } else {
        out[p] = { available: true }
      }
    }
    return out
  }

  async resolve(ctx: { method?: string | null; country?: string | null; currency?: string | null; sellerId?: string | null }): Promise<MethodRoute> {
    if (!ctx.method) return { ruleId: null, scope: 'legacy', configured: [], chain: [], skipped: [] }
    const route = resolveMethodRoute(await this.rules(), this.availability(), { ...ctx, method: ctx.method })
    if (route.skipped.length) {
      console.warn(`[MethodRouting] ${ctx.method}: pulados ${route.skipped.map(s => `${s.provider} (${s.reason})`).join(', ')}`)
    }
    return route
  }

  // ─── CRM ────────────────────────────────────────────────────────────────

  async overview() {
    const [{ data: rules }, { data: history }] = await Promise.all([
      supabase.from('payment_method_routes').select('*').order('method').order('seller_id', { nullsFirst: true }),
      supabase.from('payment_method_route_history').select('*').order('created_at', { ascending: false }).limit(50),
    ])
    const availability = this.availability()
    return {
      catalog: Object.entries(METHOD_CATALOG).map(([key, v]) => ({ method: key, label: v.label, providers: v.providers })),
      providers: Object.entries(PROVIDER_LABEL).map(([key, label]) => ({ provider: key, label, ...availability[key] })),
      rules: rules ?? [],
      history: history ?? [],
    }
  }

  async upsert(input: {
    id?: string; method?: string; country?: string | null; currency?: string | null; sellerId?: string | null
    providers?: string[]; enabled?: boolean; notes?: string | null
  }, actor: string) {
    const problem = validateRule(input)
    if (problem) throw new BadRequestException(problem)
    const row = {
      method: normalizeMethod(input.method),
      country: input.country ? String(input.country).toUpperCase() : null,
      currency: input.currency ? String(input.currency).toUpperCase() : null,
      seller_id: input.sellerId || null,
      providers: (input.providers ?? []).map(p => String(p).toLowerCase()),
      enabled: input.enabled !== false,
      notes: input.notes ? String(input.notes).slice(0, 500) : null,
      updated_by: actor,
      updated_at: new Date().toISOString(),
    }

    let before: any = null
    if (input.id) {
      const { data } = await supabase.from('payment_method_routes').select('*').eq('id', input.id).maybeSingle()
      if (!data) throw new NotFoundException('Regra não encontrada.')
      before = data
    }
    const query = input.id
      ? supabase.from('payment_method_routes').update(row).eq('id', input.id).select('*').single()
      : supabase.from('payment_method_routes').insert(row).select('*').single()
    const { data: saved, error } = await query
    if (error) {
      if (/duplicate|unique/i.test(error.message)) throw new BadRequestException('Já existe uma regra para esse método, país, moeda e seller.')
      throw new BadRequestException(error.message)
    }
    await this.log(saved.id, before ? 'updated' : 'created', before, saved, actor)
    this.invalidate()
    return saved
  }

  async remove(id: string, actor: string) {
    const { data: before } = await supabase.from('payment_method_routes').select('*').eq('id', id).maybeSingle()
    if (!before) throw new NotFoundException('Regra não encontrada.')
    const { error } = await supabase.from('payment_method_routes').delete().eq('id', id)
    if (error) throw new BadRequestException(error.message)
    await this.log(id, 'deleted', before, null, actor)
    this.invalidate()
    return { ok: true }
  }

  /** Simulador do CRM: "quem cobra um cartão de um comprador do BR em BRL?" */
  async preview(ctx: { method: string; country?: string | null; currency?: string | null; sellerId?: string | null }) {
    const route = await this.resolve(ctx)
    return {
      ...route,
      labels: Object.fromEntries([...route.configured].map(p => [p, PROVIDER_LABEL[p as RoutedProvider] ?? p])),
    }
  }

  private async log(routeId: string, action: 'created' | 'updated' | 'deleted', before: unknown, after: unknown, actor: string) {
    const { error } = await supabase.from('payment_method_route_history').insert({ route_id: routeId, action, before, after, actor })
    if (error) console.error('[MethodRouting] histórico não gravado:', error.message)
  }
}
