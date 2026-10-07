import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { CryptoService } from '../crypto/crypto.service'
import { ClipAccountsService } from '../orchestrator/clip/clip-accounts.service'
import { currentCrmRequest } from './crm-request-context'

// ════════════════════════════════════════════════════════════════════════════
// CONTAS CLIP — gestão do roteamento no CRM
// ────────────────────────────────────────────────────────────────────────────
// Uma conta Clip (gw_clip_accounts) tem até duas pernas:
//   cartão → gw_card_accounts  (public key + secret, teto DIÁRIO em MXN)
//   SPEI   → gw_spei_accounts  (CLABE, teto de SALDO parado com colchão)
//
// O modo (só cartão / cartão + SPEI / só SPEI) e o status ficam na conta-mãe;
// o status das pernas é derivado por trigger no banco (ver a migration
// 20261007120000_gw_clip_accounts). Este serviço nunca escreve `status` numa
// perna: escrever ali seria um segundo interruptor, e o trigger o desfaria.
//
// ⚠️ Valores em CENTAVOS da moeda da conta (MXN), nunca em USD.
// ════════════════════════════════════════════════════════════════════════════

const MX_TZ = 'America/Mexico_City'
const DAY_MS = 24 * 60 * 60 * 1000

export type ClipMode = 'card' | 'spei' | 'both'
export type ClipStatus = 'active' | 'paused' | 'inactive'

export interface ClipCardInput {
  publicKey?: string
  /** Secret em claro; é cifrado aqui e nunca devolvido. */
  secretKey?: string
  dailyCapMinor?: number
  upsellHeadroomMinor?: number
  weight?: number
  priority?: number
  minTicketMinor?: number | null
  maxTicketMinor?: number | null
  cooldownUntil?: string | null
}

export interface ClipSpeiInput {
  clabe?: string
  banco?: string
  beneficiario?: string
  balanceCapMinor?: number
  bufferPct?: number
  weight?: number
  priority?: number
}

export interface ClipAccountInput {
  label?: string | null
  country?: string
  currency?: string
  riskLevel?: 'WHITE' | 'GRAY'
  status?: ClipStatus
  mode?: ClipMode
  notes?: string | null
  card?: ClipCardInput
  spei?: ClipSpeiInput
}

const CARD_COLS =
  'id, clip_account_id, label, public_key, currency, country, risk_level, status, daily_cap_minor, ' +
  'upsell_headroom_minor, weight, priority, min_ticket_minor, max_ticket_minor, cooldown_until, updated_at'
const SPEI_COLS =
  'id, clip_account_id, label, clabe, banco, beneficiario, currency, country, risk_level, status, ' +
  'balance_cap_minor, buffer_pct, occupied_minor, weight, priority, updated_at'

/** Dia da operação no fuso de Cidade do México (o teto do cartão vira ali). */
function mxDay(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: MX_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

function modeOf(p: { card_enabled: boolean; spei_enabled: boolean }): ClipMode | null {
  if (p.card_enabled && p.spei_enabled) return 'both'
  if (p.card_enabled) return 'card'
  if (p.spei_enabled) return 'spei'
  return null
}

function intOrThrow(v: unknown, field: string, { min = 0, allowNull = false } = {}): number | null {
  if (v === null || v === undefined || v === '') {
    if (allowNull) return null
    throw new BadRequestException(`${field} é obrigatório.`)
  }
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < min) throw new BadRequestException(`${field} inválido.`)
  return n
}

function maskClabe(clabe: string | null | undefined) {
  const s = String(clabe ?? '')
  return s.length > 4 ? `•••• ${s.slice(-4)}` : s
}

function maskKey(key: string | null | undefined) {
  const s = String(key ?? '')
  return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s
}

@Injectable()
export class CrmClipService {
  constructor(
    private readonly crypto: CryptoService,
    private readonly clipAccounts: ClipAccountsService,
  ) { }

  // ─── Leitura ──────────────────────────────────────────────────────────────

  async overview() {
    const today = mxDay()
    const since30 = mxDay(new Date(Date.now() - 29 * DAY_MS))
    const since30Iso = new Date(Date.now() - 30 * DAY_MS).toISOString()

    const [parents, cards, speis, usage, capacity, reservations, captures, sellers] = await Promise.all([
      supabase.from('gw_clip_accounts').select('*').order('created_at'),
      supabase.from('gw_card_accounts').select(CARD_COLS),
      supabase.from('gw_spei_accounts').select(SPEI_COLS),
      supabase.from('gw_card_usage').select('account_id, day, reserved_minor, captured_minor').gte('day', since30),
      supabase.from('gw_capacity').select('*').eq('method', 'spei'),
      supabase.from('gw_reservations')
        .select('account_id, method, state, resolution_reason')
        .gte('created_at', since30Iso)
        .limit(20000),
      supabase.from('gw_captures')
        .select('account_id, method, amount_minor, created_at')
        .eq('method', 'spei')
        .gte('created_at', since30Iso)
        .limit(20000),
      supabase.from('seller_profiles')
        .select('id, risk_level, status, enabled_methods')
        .eq('provider_default', 'clip'),
    ])

    if (parents.error) {
      if (/gw_clip_accounts|schema cache|does not exist/i.test(parents.error.message)) {
        throw new BadRequestException(
          'Tabela gw_clip_accounts não existe. Rode a migration 20261007120000_gw_clip_accounts no banco do pay.',
        )
      }
      throw new BadRequestException(parents.error.message)
    }

    const cardByParent = new Map<string, any>()
    const orphanCards: any[] = []
    for (const c of (cards.data ?? []) as any[]) {
      if (c.clip_account_id) cardByParent.set(c.clip_account_id, c)
      else orphanCards.push(c)
    }
    const speiByParent = new Map<string, any>()
    const orphanSpeis: any[] = []
    for (const s of (speis.data ?? []) as any[]) {
      if (s.clip_account_id) speiByParent.set(s.clip_account_id, s)
      else orphanSpeis.push(s)
    }

    const usageByAccount = new Map<string, any[]>()
    for (const u of (usage.data ?? []) as any[]) {
      const list = usageByAccount.get(u.account_id) ?? []
      list.push(u)
      usageByAccount.set(u.account_id, list)
    }
    const speiCap = new Map<string, any>(((capacity.data ?? []) as any[]).map(r => [r.id, r]))

    const resStats = new Map<string, { captured: number; declined: number; abandoned: number }>()
    for (const r of (reservations.data ?? []) as any[]) {
      const k = `${r.method}:${r.account_id}`
      const st = resStats.get(k) ?? { captured: 0, declined: 0, abandoned: 0 }
      if (r.state === 'captured') st.captured++
      else if (r.resolution_reason === 'declined') st.declined++
      else if (r.state === 'expired' || r.state === 'released') st.abandoned++
      resStats.set(k, st)
    }

    const speiReceived = new Map<string, { total: number; count: number; days: Map<string, number> }>()
    for (const c of (captures.data ?? []) as any[]) {
      const st = speiReceived.get(c.account_id) ?? { total: 0, count: 0, days: new Map() }
      st.total += Number(c.amount_minor ?? 0)
      st.count++
      const d = mxDay(new Date(c.created_at))
      st.days.set(d, (st.days.get(d) ?? 0) + Number(c.amount_minor ?? 0))
      speiReceived.set(c.account_id, st)
    }

    const cardIds = [...cardByParent.values()].map(c => c.id)
    const secrets = new Map<string, boolean>(
      await Promise.all(cardIds.map(async id => {
        const { data } = await supabase.rpc('gw_card_has_secret', { p_account_id: id })
        return [id, data === true] as [string, boolean]
      })),
    )

    const days = Array.from({ length: 14 }, (_, i) => mxDay(new Date(Date.now() - (13 - i) * DAY_MS)))

    const accounts = ((parents.data ?? []) as any[]).map(p => {
      const card = cardByParent.get(p.id) ?? null
      const spei = speiByParent.get(p.id) ?? null

      let cardView: any = null
      if (card) {
        const rows = usageByAccount.get(card.id) ?? []
        const todayRow = rows.find(r => r.day === today)
        const sumSince = (n: number) => {
          const from = mxDay(new Date(Date.now() - (n - 1) * DAY_MS))
          return rows.filter(r => r.day >= from).reduce((a, r) => a + Number(r.captured_minor ?? 0), 0)
        }
        const st = resStats.get(`card:${card.id}`) ?? { captured: 0, declined: 0, abandoned: 0 }
        const decided = st.captured + st.declined
        cardView = {
          id: card.id,
          publicKeyMasked: maskKey(card.public_key),
          hasSecret: secrets.get(card.id) ?? false,
          status: card.status,
          dailyCapMinor: Number(card.daily_cap_minor),
          upsellHeadroomMinor: Number(card.upsell_headroom_minor),
          weight: Number(card.weight ?? 1),
          priority: Number(card.priority ?? 100),
          minTicketMinor: card.min_ticket_minor,
          maxTicketMinor: card.max_ticket_minor,
          cooldownUntil: card.cooldown_until,
          today: {
            capturedMinor: Number(todayRow?.captured_minor ?? 0),
            inFlightMinor: Number(todayRow?.reserved_minor ?? 0),
            freeMinor: Math.max(Number(card.daily_cap_minor) - Number(todayRow?.captured_minor ?? 0), 0),
          },
          last7Minor: sumSince(7),
          last30Minor: sumSince(30),
          approvals30d: { ...st, rate: decided > 0 ? st.captured / decided : null },
          series: days.map(d => Number(rows.find(r => r.day === d)?.captured_minor ?? 0)),
        }
      }

      let speiView: any = null
      if (spei) {
        const cap = speiCap.get(spei.id)
        const rec = speiReceived.get(spei.id)
        const st = resStats.get(`spei:${spei.id}`) ?? { captured: 0, declined: 0, abandoned: 0 }
        speiView = {
          id: spei.id,
          clabe: spei.clabe,
          clabeMasked: maskClabe(spei.clabe),
          banco: spei.banco,
          beneficiario: spei.beneficiario,
          status: spei.status,
          balanceCapMinor: Number(spei.balance_cap_minor),
          bufferPct: Number(spei.buffer_pct),
          weight: Number(spei.weight ?? 1),
          priority: Number(spei.priority ?? 100),
          // Teto COM colchão — o que o roteador respeita.
          operationalCapMinor: Number(cap?.cap_minor ?? Math.floor(Number(spei.balance_cap_minor) * (1 - Number(spei.buffer_pct)))),
          occupiedMinor: Number(spei.occupied_minor ?? 0),
          inFlightMinor: Number(cap?.em_voo_minor ?? 0),
          parkedMinor: Number(cap?.confirmado_minor ?? 0),
          freeMinor: Number(cap?.livre_minor ?? 0),
          received30dMinor: rec?.total ?? 0,
          received30dCount: rec?.count ?? 0,
          orders30d: st,
          series: days.map(d => rec?.days.get(d) ?? 0),
        }
      }

      const warnings: string[] = []
      if (p.status === 'active') {
        if (!p.card_enabled && !p.spei_enabled) warnings.push('Ativa, mas sem nenhum método ligado.')
        if (p.card_enabled && !card) warnings.push('Cartão ligado sem configuração de cartão.')
        if (p.card_enabled && card && !cardView?.hasSecret) warnings.push('Cartão ligado sem secret key cadastrada: a cobrança vai falhar.')
        if (p.spei_enabled && !spei) warnings.push('SPEI ligado sem CLABE cadastrada.')
        if (cardView && cardView.today.freeMinor <= 0 && p.card_enabled) warnings.push('Teto diário do cartão esgotado hoje.')
        if (speiView && speiView.freeMinor <= 0 && p.spei_enabled) warnings.push('Saldo SPEI cheio: registre um saque para liberar.')
      }

      return {
        id: p.id,
        label: p.label,
        country: p.country,
        currency: p.currency,
        riskLevel: p.risk_level,
        status: p.status as ClipStatus,
        mode: modeOf(p),
        cardEnabled: p.card_enabled,
        speiEnabled: p.spei_enabled,
        notes: p.notes,
        updatedAt: p.updated_at,
        updatedBy: p.updated_by,
        card: cardView,
        spei: speiView,
        warnings,
      }
    })

    // Quantos sellers cada combinação país/risco atende — o que some se a
    // última conta de um risco for pausada.
    const sellerRows = ((sellers.data ?? []) as any[]).filter(s => s.status === 'active')
    const coverage = (['WHITE', 'GRAY'] as const).map(risk => {
      const riskSellers = sellerRows.filter(s => String(s.risk_level ?? '').toUpperCase() === risk)
      const live = accounts.filter(a => a.status === 'active' && a.riskLevel === risk)
      return {
        riskLevel: risk,
        sellers: riskSellers.length,
        cardAccounts: live.filter(a => a.cardEnabled && a.card).length,
        speiAccounts: live.filter(a => a.speiEnabled && a.spei).length,
      }
    })

    const totals = {
      cardTodayMinor: accounts.reduce((a, x) => a + (x.card?.today.capturedMinor ?? 0), 0),
      cardTodayCapMinor: accounts
        .filter(x => x.status === 'active' && x.cardEnabled && x.card)
        .reduce((a, x) => a + (x.card?.dailyCapMinor ?? 0), 0),
      card30dMinor: accounts.reduce((a, x) => a + (x.card?.last30Minor ?? 0), 0),
      speiParkedMinor: accounts.reduce((a, x) => a + (x.spei?.parkedMinor ?? 0), 0),
      speiFreeMinor: accounts
        .filter(x => x.status === 'active' && x.speiEnabled && x.spei)
        .reduce((a, x) => a + (x.spei?.freeMinor ?? 0), 0),
      spei30dMinor: accounts.reduce((a, x) => a + (x.spei?.received30dMinor ?? 0), 0),
    }

    return {
      today,
      days,
      accounts,
      coverage,
      totals,
      sellersOnClip: sellerRows.length,
      // Pernas sem conta-mãe (cadastradas à mão depois da migration).
      orphans: {
        card: orphanCards.map(c => ({ id: c.id, label: c.label, status: c.status, riskLevel: c.risk_level })),
        spei: orphanSpeis.map(s => ({ id: s.id, label: s.label, status: s.status, riskLevel: s.risk_level })),
      },
    }
  }

  async history(id: string) {
    const { data, error } = await supabase
      .from('crm_action_log')
      .select('action, payload, created_at, crm_managers(name)')
      .eq('resource_type', 'clip_account')
      .eq('resource_id', id)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new BadRequestException(error.message)
    return data ?? []
  }

  async recentReservations(id: string) {
    const parent = await this.getParent(id)
    const [{ data: card }, { data: spei }] = await Promise.all([
      supabase.from('gw_card_accounts').select('id').eq('clip_account_id', parent.id).maybeSingle(),
      supabase.from('gw_spei_accounts').select('id').eq('clip_account_id', parent.id).maybeSingle(),
    ])
    const ids = [card?.id, spei?.id].filter(Boolean) as string[]
    if (!ids.length) return []
    const { data, error } = await supabase
      .from('gw_reservations')
      .select('id, seller_id, method, account_id, state, amount_minor, charge_minor, held_minor, resolution_reason, external_reference, created_at, resolved_at, expires_at')
      .in('account_id', ids)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new BadRequestException(error.message)
    return data ?? []
  }

  // ─── Escrita ──────────────────────────────────────────────────────────────

  async create(managerId: string, dto: ClipAccountInput) {
    const risk = this.risk(dto.riskLevel ?? 'GRAY')
    const country = String(dto.country ?? 'MX').toUpperCase()
    const currency = String(dto.currency ?? 'MXN').toUpperCase()
    const id = await this.nextId(country, risk)

    const { error } = await supabase.from('gw_clip_accounts').insert({
      id,
      label: dto.label?.trim() || null,
      country, currency, risk_level: risk,
      // Nasce desligada; o update abaixo liga depois de as pernas existirem.
      status: 'inactive',
      card_enabled: false,
      spei_enabled: false,
      notes: dto.notes ?? null,
      updated_by: managerId,
    })
    if (error) throw new BadRequestException('Erro ao criar conta Clip: ' + error.message)

    await this.log(managerId, id, 'clip_account_created', { label: dto.label, country, currency, riskLevel: risk })

    try {
      return await this.update(id, managerId, { ...dto, riskLevel: risk, country, currency }, { creating: true })
    } catch (e) {
      // Falhou na validação das pernas: não deixa uma conta vazia para trás.
      await supabase.from('gw_card_accounts').delete().eq('clip_account_id', id)
      await supabase.from('gw_spei_accounts').delete().eq('clip_account_id', id)
      await supabase.from('gw_clip_accounts').delete().eq('id', id)
      throw e
    }
  }

  async update(id: string, managerId: string, dto: ClipAccountInput, opts: { creating?: boolean } = {}) {
    const parent = await this.getParent(id)
    const before = await this.snapshot(parent.id)

    const risk = dto.riskLevel !== undefined ? this.risk(dto.riskLevel) : parent.risk_level
    const country = dto.country !== undefined ? String(dto.country).toUpperCase() : parent.country
    const currency = dto.currency !== undefined ? String(dto.currency).toUpperCase() : parent.currency

    // 1) Pernas primeiro: ligar um método exige a perna pronta.
    if (dto.card) await this.upsertCard(parent.id, dto.label ?? parent.label, { risk, country, currency }, dto.card)
    if (dto.spei) await this.upsertSpei(parent.id, dto.label ?? parent.label, { risk, country, currency }, dto.spei)

    // País/moeda/risco são filtros DUROS no gw_hold_*: a perna tem que acompanhar
    // a mãe, senão a conta some do pool sem aviso.
    if (risk !== parent.risk_level || country !== parent.country || currency !== parent.currency) {
      const patch = { risk_level: risk, country, currency, updated_at: new Date().toISOString() }
      await supabase.from('gw_card_accounts').update(patch).eq('clip_account_id', parent.id)
      await supabase.from('gw_spei_accounts').update(patch).eq('clip_account_id', parent.id)
    }

    // 2) Modo e status.
    let cardEnabled = parent.card_enabled as boolean
    let speiEnabled = parent.spei_enabled as boolean
    if (dto.mode !== undefined) {
      if (!['card', 'spei', 'both'].includes(dto.mode)) throw new BadRequestException('Modo inválido.')
      cardEnabled = dto.mode === 'card' || dto.mode === 'both'
      speiEnabled = dto.mode === 'spei' || dto.mode === 'both'
    }
    const status: ClipStatus = dto.status ?? (opts.creating ? 'active' : parent.status)
    if (!['active', 'paused', 'inactive'].includes(status)) throw new BadRequestException('Status inválido.')

    if (cardEnabled || speiEnabled) {
      const [{ data: card }, { data: spei }] = await Promise.all([
        supabase.from('gw_card_accounts').select('id').eq('clip_account_id', parent.id).maybeSingle(),
        supabase.from('gw_spei_accounts').select('id').eq('clip_account_id', parent.id).maybeSingle(),
      ])
      if (cardEnabled && !card) throw new BadRequestException('Para usar cartão, informe a public key e a secret key da conta Clip.')
      if (speiEnabled && !spei) throw new BadRequestException('Para usar SPEI, informe CLABE, banco e beneficiário.')
      if (cardEnabled && card && status === 'active') {
        const { data: hasSecret } = await supabase.rpc('gw_card_has_secret', { p_account_id: card.id })
        if (hasSecret !== true) throw new BadRequestException('A conta não tem secret key cadastrada; o cartão não pode ser ligado.')
      }
    } else if (status === 'active') {
      throw new BadRequestException('Escolha ao menos um método (cartão, SPEI ou os dois) para ativar a conta.')
    }

    const { error } = await supabase.from('gw_clip_accounts').update({
      label: dto.label !== undefined ? (dto.label?.trim() || null) : parent.label,
      country, currency, risk_level: risk,
      status,
      card_enabled: cardEnabled,
      spei_enabled: speiEnabled,
      notes: dto.notes !== undefined ? dto.notes : parent.notes,
      updated_by: managerId,
      updated_at: new Date().toISOString(),
    }).eq('id', parent.id)
    if (error) throw new BadRequestException('Erro ao salvar conta Clip: ' + error.message)

    this.clipAccounts.invalidate()

    const after = await this.snapshot(parent.id)
    await this.log(managerId, parent.id, opts.creating ? 'clip_account_configured' : 'clip_account_updated', {
      from: opts.creating ? null : before, to: after,
      secretChanged: !!dto.card?.secretKey,
    })

    return { id: parent.id, message: 'Conta Clip salva' }
  }

  /** Atalho do painel: pausar / reativar / desligar sem abrir o formulário. */
  async setStatus(id: string, managerId: string, status: ClipStatus, reason?: string) {
    const res = await this.update(id, managerId, { status })
    if (reason) await this.log(managerId, id, 'clip_account_status_reason', { status, reason })
    return res
  }

  /**
   * Liga a uma conta-mãe uma perna que ficou sem mãe (cadastrada à mão depois
   * da migration). A perna herda risco/país/moeda da mãe.
   */
  async attach(id: string, managerId: string, body: { cardId?: string; speiId?: string }) {
    const parent = await this.getParent(id)
    const patch = {
      clip_account_id: parent.id, risk_level: parent.risk_level, country: parent.country,
      currency: parent.currency, updated_at: new Date().toISOString(),
    }
    if (body.cardId) {
      const { data: taken } = await supabase.from('gw_card_accounts').select('id').eq('clip_account_id', parent.id).maybeSingle()
      if (taken) throw new BadRequestException('Esta conta já tem configuração de cartão.')
      const { error } = await supabase.from('gw_card_accounts').update(patch).eq('id', body.cardId).is('clip_account_id', null)
      if (error) throw new BadRequestException(error.message)
    }
    if (body.speiId) {
      const { data: taken } = await supabase.from('gw_spei_accounts').select('id').eq('clip_account_id', parent.id).maybeSingle()
      if (taken) throw new BadRequestException('Esta conta já tem configuração de SPEI.')
      const { error } = await supabase.from('gw_spei_accounts').update(patch).eq('id', body.speiId).is('clip_account_id', null)
      if (error) throw new BadRequestException(error.message)
    }
    this.clipAccounts.invalidate()
    await this.log(managerId, parent.id, 'clip_account_attached', body)
    return { id: parent.id, message: 'Configuração vinculada' }
  }

  // ─── Pernas ───────────────────────────────────────────────────────────────

  private async upsertCard(
    parentId: string,
    label: string | null,
    base: { risk: string; country: string; currency: string },
    input: ClipCardInput,
  ) {
    const { data: existing } = await supabase
      .from('gw_card_accounts').select('id, public_key').eq('clip_account_id', parentId).maybeSingle()

    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    if (input.publicKey !== undefined) {
      const pk = String(input.publicKey).trim()
      if (!pk) throw new BadRequestException('Public key da Clip é obrigatória.')
      patch.public_key = pk
    }
    if (input.dailyCapMinor !== undefined) patch.daily_cap_minor = intOrThrow(input.dailyCapMinor, 'Teto diário do cartão', { min: 100 })
    if (input.upsellHeadroomMinor !== undefined) patch.upsell_headroom_minor = intOrThrow(input.upsellHeadroomMinor, 'Folga de upsell')
    if (input.weight !== undefined) patch.weight = this.weight(input.weight)
    if (input.priority !== undefined) patch.priority = intOrThrow(input.priority, 'Prioridade')
    if (input.minTicketMinor !== undefined) patch.min_ticket_minor = intOrThrow(input.minTicketMinor, 'Ticket mínimo', { allowNull: true })
    if (input.maxTicketMinor !== undefined) patch.max_ticket_minor = intOrThrow(input.maxTicketMinor, 'Ticket máximo', { allowNull: true })
    if (input.cooldownUntil !== undefined) {
      if (input.cooldownUntil && Number.isNaN(Date.parse(input.cooldownUntil))) throw new BadRequestException('Data de pausa inválida.')
      patch.cooldown_until = input.cooldownUntil || null
    }
    const min = patch.min_ticket_minor, max = patch.max_ticket_minor
    if (min != null && max != null && min > max) throw new BadRequestException('Ticket mínimo maior que o máximo.')

    let cardId = existing?.id as string | undefined
    if (!cardId) {
      if (!patch.public_key) throw new BadRequestException('Para configurar o cartão, informe a public key.')
      if (!input.secretKey?.trim()) throw new BadRequestException('Para configurar o cartão, informe a secret key.')
      cardId = parentId
      const { error } = await supabase.from('gw_card_accounts').insert({
        id: cardId,
        clip_account_id: parentId,
        label,
        provider: 'clip',
        risk_level: base.risk,
        country: base.country,
        currency: base.currency,
        status: 'inactive', // o trigger deriva da mãe
        daily_cap_minor: patch.daily_cap_minor ?? 1000000,
        upsell_headroom_minor: patch.upsell_headroom_minor ?? 65300,
        weight: patch.weight ?? 1,
        priority: patch.priority ?? 100,
        min_ticket_minor: patch.min_ticket_minor ?? null,
        max_ticket_minor: patch.max_ticket_minor ?? null,
        cooldown_until: patch.cooldown_until ?? null,
        public_key: patch.public_key,
      })
      if (error) throw new BadRequestException('Erro ao cadastrar o cartão: ' + error.message)
    } else if (Object.keys(patch).length > 1) {
      const { error } = await supabase.from('gw_card_accounts').update(patch).eq('id', cardId)
      if (error) throw new BadRequestException('Erro ao salvar o cartão: ' + error.message)
    }

    if (input.secretKey?.trim()) {
      const { error } = await supabase.rpc('gw_set_card_secret', {
        p_account_id: cardId,
        p_secret_enc: this.crypto.encrypt(input.secretKey.trim()),
      })
      if (error) throw new BadRequestException('Erro ao salvar a secret key: ' + error.message)
    }
  }

  private async upsertSpei(
    parentId: string,
    label: string | null,
    base: { risk: string; country: string; currency: string },
    input: ClipSpeiInput,
  ) {
    const { data: existing } = await supabase
      .from('gw_spei_accounts').select('id').eq('clip_account_id', parentId).maybeSingle()

    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    if (input.clabe !== undefined) {
      const clabe = String(input.clabe).replace(/\D/g, '')
      if (!/^\d{18}$/.test(clabe)) throw new BadRequestException('A CLABE precisa ter 18 dígitos.')
      patch.clabe = clabe
    }
    if (input.banco !== undefined) {
      if (!String(input.banco).trim()) throw new BadRequestException('Banco é obrigatório.')
      patch.banco = String(input.banco).trim()
    }
    if (input.beneficiario !== undefined) {
      if (!String(input.beneficiario).trim()) throw new BadRequestException('Beneficiário é obrigatório.')
      patch.beneficiario = String(input.beneficiario).trim()
    }
    if (input.balanceCapMinor !== undefined) patch.balance_cap_minor = intOrThrow(input.balanceCapMinor, 'Teto de saldo SPEI', { min: 100 })
    if (input.bufferPct !== undefined) {
      const b = Number(input.bufferPct)
      if (!Number.isFinite(b) || b < 0 || b >= 0.9) throw new BadRequestException('Colchão deve ficar entre 0% e 90%.')
      patch.buffer_pct = b
    }
    if (input.weight !== undefined) patch.weight = this.weight(input.weight)
    if (input.priority !== undefined) patch.priority = intOrThrow(input.priority, 'Prioridade')

    if (!existing) {
      if (!patch.clabe || !patch.banco || !patch.beneficiario) {
        throw new BadRequestException('Para configurar o SPEI, informe CLABE, banco e beneficiário.')
      }
      const speiId = parentId.startsWith('clip_') ? parentId.replace(/^clip_/, 'spei_') : `spei_${parentId}`
      const { error } = await supabase.from('gw_spei_accounts').insert({
        id: speiId,
        clip_account_id: parentId,
        label,
        risk_level: base.risk,
        country: base.country,
        currency: base.currency,
        status: 'inactive', // o trigger deriva da mãe
        clabe: patch.clabe,
        banco: patch.banco,
        beneficiario: patch.beneficiario,
        balance_cap_minor: patch.balance_cap_minor ?? 1000000,
        buffer_pct: patch.buffer_pct ?? 0.2,
        weight: patch.weight ?? 1,
        priority: patch.priority ?? 100,
      })
      if (error) throw new BadRequestException('Erro ao cadastrar o SPEI: ' + error.message)
    } else if (Object.keys(patch).length > 1) {
      const { error } = await supabase.from('gw_spei_accounts').update(patch).eq('id', existing.id)
      if (error) throw new BadRequestException('Erro ao salvar o SPEI: ' + error.message)
    }
  }

  // ─── Apoio ────────────────────────────────────────────────────────────────

  private async getParent(id: string) {
    const { data, error } = await supabase.from('gw_clip_accounts').select('*').eq('id', id).maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!data) throw new NotFoundException('Conta Clip não encontrada')
    return data as any
  }

  /** Estado legível para o histórico (sem segredos). */
  private async snapshot(id: string) {
    const [{ data: p }, { data: c }, { data: s }] = await Promise.all([
      supabase.from('gw_clip_accounts').select('label, status, card_enabled, spei_enabled, risk_level, country, currency').eq('id', id).maybeSingle(),
      supabase.from('gw_card_accounts').select('public_key, daily_cap_minor, upsell_headroom_minor, weight, priority, min_ticket_minor, max_ticket_minor, cooldown_until').eq('clip_account_id', id).maybeSingle(),
      supabase.from('gw_spei_accounts').select('clabe, banco, beneficiario, balance_cap_minor, buffer_pct, weight, priority').eq('clip_account_id', id).maybeSingle(),
    ])
    return {
      ...(p ?? {}),
      card: c ? { ...c, public_key: maskKey((c as any).public_key) } : null,
      spei: s ? { ...s, clabe: maskClabe((s as any).clabe) } : null,
    }
  }

  private async nextId(country: string, risk: string) {
    const prefix = `clip_${country.toLowerCase()}_${risk.toLowerCase()}_`
    const { data } = await supabase.from('gw_clip_accounts').select('id').like('id', `${prefix}%`)
    const used = new Set((data ?? []).map((r: any) => r.id))
    for (let n = 1; n < 1000; n++) {
      const id = `${prefix}${String(n).padStart(2, '0')}`
      // As pernas antigas podem ter o id sem mãe; não reaproveitar.
      if (used.has(id)) continue
      const { data: card } = await supabase.from('gw_card_accounts').select('id').eq('id', id).maybeSingle()
      if (!card) return id
    }
    throw new BadRequestException('Não foi possível gerar o id da conta.')
  }

  private risk(v: unknown): 'WHITE' | 'GRAY' {
    const r = String(v ?? '').toUpperCase()
    if (r !== 'WHITE' && r !== 'GRAY') throw new BadRequestException('Risco deve ser WHITE ou GRAY.')
    return r
  }

  private weight(v: unknown) {
    const w = Number(v)
    if (!Number.isFinite(w) || w <= 0 || w > 100) throw new BadRequestException('Peso deve ser maior que 0 e até 100.')
    return w
  }

  private async log(managerId: string, accountId: string, action: string, payload: Record<string, any>) {
    const request = currentCrmRequest()
    const { error } = await supabase.from('crm_action_log').insert({
      seller_id: null,
      manager_id: managerId,
      action,
      resource_type: 'clip_account',
      resource_id: accountId,
      payload,
      ip_address: request?.ip ?? null,
      user_agent: request?.userAgent ?? null,
      created_at: new Date(),
    })
    if (error) console.error(`[CrmClipService.log] ação ${action} não registrada:`, error.message)
  }
}
