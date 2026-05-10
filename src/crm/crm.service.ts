import {
  Injectable, UnauthorizedException, NotFoundException,
  BadRequestException, ForbiddenException
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { supabase } from '../lib/supabase.client'
import * as bcrypt from 'bcrypt'

const FEE_TABLE = {
  WHITE: { fee_percentage: 9.99, fee_fixed_usd: 0.30, settlement_days: 3, reserve_percentage: 5.00, reserve_hold_days: 90, anticipation_fee_pct: 4.99 },
  GRAY: { fee_percentage: 14.99, fee_fixed_usd: 0.30, settlement_days: 3, reserve_percentage: 0.00, reserve_hold_days: 0, anticipation_fee_pct: 4.99 },
  BLACK: { fee_percentage: 24.99, fee_fixed_usd: 0.30, settlement_days: 3, reserve_percentage: 0.00, reserve_hold_days: 0, anticipation_fee_pct: 4.99 },
} as const

const VALID_PROVIDERS = ['stripe', 'viva', 'sibs', 'stripe_crypto', 'onramp'] as const
type ProviderDefault = typeof VALID_PROVIDERS[number] | null

@Injectable()
export class CrmService {
  constructor(private readonly jwtService: JwtService) { }

  // =========================================
  // AUTH
  // =========================================

  async login(email: string, password: string) {
    const { data: manager } = await supabase
      .from('crm_managers')
      .select('*')
      .eq('email', email.toLowerCase())
      .eq('is_active', true)
      .maybeSingle()

    if (!manager) throw new UnauthorizedException('Credenciais inválidas')

    const valid = await bcrypt.compare(password, manager.password_hash)
    if (!valid) throw new UnauthorizedException('Credenciais inválidas')

    // 🔥 new Date() em vez de .toISOString() para campos timestamp
    await supabase.from('crm_managers')
      .update({ last_login_at: new Date() })
      .eq('id', manager.id)

    const token = this.jwtService.sign({
      sub: manager.id,
      email: manager.email,
      role: manager.role,
      name: manager.name,
    })

    return {
      accessToken: token,
      manager: {
        id: manager.id,
        name: manager.name,
        email: manager.email,
        role: manager.role,
        avatarUrl: manager.avatar_url,
      },
    }
  }

  async getMe(managerId: string) {
    const { data } = await supabase
      .from('crm_managers')
      .select('id, name, email, role, avatar_url, last_login_at')
      .eq('id', managerId)
      .single()

    if (!data) throw new NotFoundException('Gerente não encontrado')
    return data
  }

  // =========================================
  // DASHBOARD STATS
  // =========================================

  async getDashboardStats(managerId: string, role: string) {
    const isAdmin = ['admin', 'supervisor'].includes(role)

    const { data: statusCounts } = await supabase
      .from('seller_profiles')
      .select('status')

    const counts = { pending: 0, active: 0, rejected: 0, suspended: 0 }
    for (const s of statusCounts ?? []) {
      if (s.status === 'pending_review') counts.pending++
      else if (s.status in counts) counts[s.status as keyof typeof counts]++
    }

    let myQuery = supabase
      .from('crm_assignments')
      .select('seller_id', { count: 'exact' })
      .eq('status', 'active')
    if (!isAdmin) myQuery = myQuery.eq('manager_id', managerId)
    const { count: myCount } = await myQuery

    // 🔥 Corrigido: duas queries em vez de subquery inline
    const { data: assignedRows } = await supabase
      .from('crm_assignments')
      .select('seller_id')
      .eq('status', 'active')

    const assignedIds = (assignedRows ?? []).map(r => r.seller_id)

    let unassignedQuery = supabase
      .from('seller_profiles')
      .select('id', { count: 'exact' })
      .eq('status', 'pending_review')

    if (assignedIds.length > 0) {
      unassignedQuery = unassignedQuery.not('id', 'in', `(${assignedIds.join(',')})`)
    }

    const { count: unassigned } = await unassignedQuery

    return { ...counts, myAssignments: myCount ?? 0, unassigned: unassigned ?? 0 }
  }

  // =========================================
  // LISTAR SELLERS
  // =========================================

  async listSellers(params: {
    managerId: string
    role: string
    status?: string
    assignedToMe?: boolean
    unassigned?: boolean
    search?: string
    page?: number
    pageSize?: number
  }) {
    const { managerId, role, status, assignedToMe, unassigned, search, page = 1, pageSize = 20 } = params
    const from = (page - 1) * pageSize
    const isAdmin = ['admin', 'supervisor'].includes(role)

    let query = supabase
      .from('v_crm_sellers')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1)

    if (status && status !== 'all') query = query.eq('status', status)
    if (assignedToMe) query = query.eq('manager_id', managerId)
    if (unassigned) query = query.is('manager_id', null)
    if (!isAdmin && !assignedToMe && !unassigned) {
      query = query.or(`manager_id.eq.${managerId},manager_id.is.null`)
    }
    if (search) {
      query = query.or(
        `name.ilike.%${search}%,email.ilike.%${search}%,instagram.ilike.%${search}%,whatsapp.ilike.%${search}%`
      )
    }

    const { data, count, error } = await query
    if (error) throw new BadRequestException(error.message)

    return {
      data: data ?? [],
      total: count ?? 0,
      page,
      totalPages: Math.ceil((count ?? 0) / pageSize),
    }
  }

  // =========================================
  // DETALHE DO SELLER
  // =========================================

  async getSellerDetail(sellerId: string) {
    const { data: seller } = await supabase
      .from('v_crm_sellers')
      .select('*')
      .eq('seller_id', sellerId)
      .single()

    if (!seller) throw new NotFoundException('Seller não encontrado')

    // 🔥 Busca user_id separado para o KYC
    const { data: sp } = await supabase
      .from('seller_profiles')
      .select('user_id')
      .eq('id', sellerId)
      .single()

    const [offersRes, feesRes, notesRes, logRes, kycRes] = await Promise.all([
      supabase.from('offers').select('*').eq('seller_id', sellerId).order('created_at', { ascending: false }),
      supabase.from('seller_fees').select('*').eq('seller_id', sellerId).maybeSingle(),
      supabase.from('crm_notes').select('*, crm_managers(name, avatar_url)').eq('seller_id', sellerId).order('is_pinned', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('crm_action_log').select('*, crm_managers(name)').eq('seller_id', sellerId).order('created_at', { ascending: false }).limit(50),
      sp?.user_id
        ? supabase.from('kyc_info').select('*').eq('user_id', sp.user_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    return {
      seller,
      offers: offersRes.data ?? [],
      fees: feesRes.data,
      notes: notesRes.data ?? [],
      log: logRes.data ?? [],
      kyc: kycRes.data,
    }
  }

  // =========================================
  // ASSUMIR / ATRIBUIR SELLER
  // =========================================

  async assignSeller(sellerId: string, managerId: string, notes?: string) {
    const { data: existing } = await supabase
      .from('crm_assignments')
      .select('manager_id, crm_managers(name)')
      .eq('seller_id', sellerId)
      .eq('status', 'active')
      .maybeSingle()

    if (existing) {
      const mgr = (existing as any).crm_managers?.name ?? 'outro gerente'
      throw new ForbiddenException(`Este seller já está sendo atendido por ${mgr}.`)
    }

    await supabase.from('crm_assignments').insert({
      seller_id: sellerId,
      manager_id: managerId,
      status: 'active',
      notes: notes ?? null,
      assigned_at: new Date(), // 🔥
    })

    await this.log(sellerId, managerId, 'assigned', { notes })
    return { message: 'Seller atribuído com sucesso' }
  }

  async releaseSeller(sellerId: string, managerId: string, notes?: string) {
    await supabase.from('crm_assignments')
      .update({ status: 'released', released_at: new Date() }) // 🔥
      .eq('seller_id', sellerId)
      .eq('manager_id', managerId)
      .eq('status', 'active')

    await this.log(sellerId, managerId, 'released', { notes })
    return { message: 'Seller liberado' }
  }

  async transferSeller(sellerId: string, fromManagerId: string, toManagerId: string, notes?: string) {
    await supabase.from('crm_assignments')
      .update({ status: 'transferred', released_at: new Date() }) // 🔥
      .eq('seller_id', sellerId)
      .eq('manager_id', fromManagerId)
      .eq('status', 'active')

    await supabase.from('crm_assignments').insert({
      seller_id: sellerId,
      manager_id: toManagerId,
      status: 'active',
      notes: notes ?? null,
      assigned_at: new Date(), // 🔥
    })

    await this.log(sellerId, fromManagerId, 'transferred', { to: toManagerId, notes })
    return { message: 'Seller transferido' }
  }

  // =========================================
  // APROVAR SELLER
  // =========================================

  async approveSeller(sellerId: string, managerId: string, dto: {
    riskLevel: 'WHITE' | 'GRAY' | 'BLACK'
    enabledMethods: string[]
    feeOverride?: {
      fee_percentage?: number
      fee_fixed_usd?: number
      settlement_days?: number
      reserve_percentage?: number
      anticipation_fee_pct?: number
    }
    notes?: string
  }) {
    await this.assertAssigned(sellerId, managerId)

    const { data: seller, error: sellerError } = await supabase
      .from('seller_profiles')
      .select('user_id, status')
      .eq('id', sellerId)
      .single()

    if (sellerError || !seller) throw new NotFoundException('Seller não encontrado')
    if (seller.status === 'active') throw new BadRequestException('Seller já está ativo')

    const baseFees = FEE_TABLE[dto.riskLevel]
    const fees = { ...baseFees, ...(dto.feeOverride ?? {}) }

    // 🔥 1. Atualiza seller_profile — new Date() para timestamps
    const { error: profileError } = await supabase
      .from('seller_profiles')
      .update({
        status: 'active',
        risk_level: dto.riskLevel,
        enabled_methods: dto.enabledMethods,
        reviewed_at: new Date(),
        reviewed_by: managerId,
        rejection_reason: null,
      })
      .eq('id', sellerId)

    if (profileError) throw new BadRequestException('Erro ao atualizar perfil: ' + profileError.message)

    // 🔥 2. Upsert seller_fees
    const { error: feesError } = await supabase
      .from('seller_fees')
      .upsert({
        seller_id: sellerId,
        risk_level: dto.riskLevel,
        fee_percentage: fees.fee_percentage,
        fee_fixed_usd: fees.fee_fixed_usd,
        settlement_days: fees.settlement_days,
        reserve_percentage: fees.reserve_percentage,
        reserve_hold_days: fees.reserve_hold_days ?? 90,
        anticipation_fee_pct: fees.anticipation_fee_pct,
        anticipation_days: 0,
        overridden_by: dto.feeOverride ? managerId : null,
        override_notes: dto.feeOverride ? (dto.notes ?? null) : null,
        updated_at: new Date(),
      }, { onConflict: 'seller_id' })

    if (feesError) throw new BadRequestException('Erro ao salvar taxas: ' + feesError.message)

    // 🔥 3. KYC aprovado
    await supabase
      .from('kyc_info')
      .update({ review_status: 'approved', reviewed_at: new Date() })
      .eq('user_id', seller.user_id)

    // 🔥 4. Marca onboarding completo — operação crítica com log de erro
    const { error: userError } = await supabase
      .from('users')
      .update({ onboarding_completed: true })
      .eq('id', seller.user_id)

    if (userError) {
      console.error('[CrmService.approveSeller] Erro ao marcar onboarding_completed:', userError)
      throw new BadRequestException('Erro ao finalizar aprovação: ' + userError.message)
    }

    await this.log(sellerId, managerId, 'approved', {
      riskLevel: dto.riskLevel,
      enabledMethods: dto.enabledMethods,
      feeOverride: dto.feeOverride,
      notes: dto.notes,
    })

    return { message: 'Seller aprovado', fees }
  }

  // =========================================
  // REJEITAR SELLER
  // =========================================

  async rejectSeller(sellerId: string, managerId: string, dto: { reason: string; notes?: string }) {
    await this.assertAssigned(sellerId, managerId)

    const { data: seller } = await supabase
      .from('seller_profiles').select('user_id').eq('id', sellerId).single()
    if (!seller) throw new NotFoundException()

    await supabase.from('seller_profiles').update({
      status: 'rejected',
      rejection_reason: dto.reason,
      reviewed_at: new Date(), // 🔥
      reviewed_by: managerId,
    }).eq('id', sellerId)

    await supabase.from('kyc_info').update({
      review_status: 'rejected',
      review_notes: dto.reason,
      reviewed_at: new Date(), // 🔥
    }).eq('user_id', seller.user_id)

    await this.log(sellerId, managerId, 'rejected', { reason: dto.reason })
    return { message: 'Seller rejeitado' }
  }

  // =========================================
  // ALTERAR NÍVEL DE RISCO
  // =========================================

  async changeRiskLevel(sellerId: string, managerId: string, dto: {
    riskLevel: 'WHITE' | 'GRAY' | 'BLACK'
    reason: string
  }) {
    const { data: seller } = await supabase
      .from('seller_profiles').select('risk_level').eq('id', sellerId).single()

    const newFees = FEE_TABLE[dto.riskLevel]

    const { error: riskError } = await supabase
      .from('seller_profiles')
      .update({ risk_level: dto.riskLevel })
      .eq('id', sellerId)

    if (riskError) throw new BadRequestException('Erro ao atualizar risco: ' + riskError.message)

    await supabase.from('seller_fees').upsert({
      seller_id: sellerId,
      risk_level: dto.riskLevel,
      fee_percentage: newFees.fee_percentage,
      fee_fixed_usd: newFees.fee_fixed_usd,
      settlement_days: newFees.settlement_days,
      reserve_percentage: newFees.reserve_percentage,
      reserve_hold_days: newFees.reserve_hold_days,
      anticipation_fee_pct: newFees.anticipation_fee_pct,
      anticipation_days: 0,
      overridden_by: null,
      updated_at: new Date(), // 🔥
    }, { onConflict: 'seller_id' })

    await this.log(sellerId, managerId, 'risk_changed', {
      from: seller?.risk_level, to: dto.riskLevel, reason: dto.reason,
    })

    return { message: 'Nível de risco atualizado', fees: newFees }
  }

  // =========================================
  // OVERRIDE DE TAXAS
  // =========================================

  async overrideFees(sellerId: string, managerId: string, dto: {
    fee_percentage?: number
    fee_fixed_usd?: number
    settlement_days?: number
    reserve_percentage?: number
    anticipation_fee_pct?: number
    notes: string
  }) {
    const { notes, ...feeFields } = dto

    await supabase.from('seller_fees').update({
      ...feeFields,
      overridden_by: managerId,
      override_notes: notes,
      updated_at: new Date(), // 🔥
    }).eq('seller_id', sellerId)

    await this.log(sellerId, managerId, 'fee_overridden', { ...feeFields, notes })
    return { message: 'Taxas atualizadas' }
  }

  // =========================================
  // MÉTODOS ATIVOS
  // =========================================

  async updateEnabledMethods(sellerId: string, managerId: string, dto: {
    enabledMethods: string[]
    notes?: string
  }) {
    const { data: current } = await supabase
      .from('seller_profiles').select('enabled_methods').eq('id', sellerId).single()

    await supabase.from('seller_profiles')
      .update({ enabled_methods: dto.enabledMethods })
      .eq('id', sellerId)

    await this.log(sellerId, managerId, 'methods_updated', {
      from: current?.enabled_methods,
      to: dto.enabledMethods,
      notes: dto.notes,
    })

    return { message: 'Métodos atualizados' }
  }

  // =========================================
  // SUSPENDER / REATIVAR
  // =========================================

  async suspendSeller(sellerId: string, managerId: string, reason: string) {
    await supabase.from('seller_profiles').update({
      status: 'suspended', rejection_reason: reason,
    }).eq('id', sellerId)

    await this.log(sellerId, managerId, 'suspended', { reason })
    return { message: 'Seller suspenso' }
  }

  async activateSeller(sellerId: string, managerId: string) {
    await supabase.from('seller_profiles').update({
      status: 'active', rejection_reason: null,
    }).eq('id', sellerId)

    await this.log(sellerId, managerId, 'activated', {})
    return { message: 'Seller reativado' }
  }

  // =========================================
  // OFERTAS
  // =========================================

  async approveOffer(offerId: string, sellerId: string, managerId: string, notes?: string) {
    await supabase.from('offers').update({
      status: 'approved', review_notes: notes ?? null, reviewed_at: new Date(), // 🔥
    }).eq('id', offerId)

    await this.log(sellerId, managerId, 'offer_approved', { offerId, notes })
    return { message: 'Oferta aprovada' }
  }

  async rejectOffer(offerId: string, sellerId: string, managerId: string, reason: string) {
    await supabase.from('offers').update({
      status: 'rejected', review_notes: reason, reviewed_at: new Date(), // 🔥
    }).eq('id', offerId)

    await this.log(sellerId, managerId, 'offer_rejected', { offerId, reason })
    return { message: 'Oferta rejeitada' }
  }

  // =========================================
  // NOTAS
  // =========================================

  async addNote(sellerId: string, managerId: string, content: string, isPinned = false) {
    const { data } = await supabase.from('crm_notes').insert({
      seller_id: sellerId,
      manager_id: managerId,
      content,
      is_pinned: isPinned,
      created_at: new Date(), // 🔥
      updated_at: new Date(), // 🔥
    }).select().single()

    await this.log(sellerId, managerId, 'note_added', { isPinned })
    return data
  }

  async deleteNote(noteId: string, managerId: string) {
    await supabase.from('crm_notes').delete()
      .eq('id', noteId).eq('manager_id', managerId)
    return { message: 'Nota removida' }
  }

  // =========================================
  // REGISTRAR CONTATO
  // =========================================

  async logContact(sellerId: string, managerId: string, dto: {
    type: 'whatsapp' | 'call' | 'email' | 'meeting'
    notes: string
    outcome?: 'no_answer' | 'in_progress' | 'scheduled' | 'completed'
  }): Promise<{ message: string }> {
    await this.log(sellerId, managerId, 'contact_' + dto.type, {
      notes: dto.notes, outcome: dto.outcome,
    })
    return { message: 'Contato registrado' }
  }

  // =========================================
  // GERENTES
  // =========================================

  async listManagers() {
    const { data } = await supabase
      .from('crm_managers')
      .select('id, name, email, role, is_active, last_login_at, avatar_url')
      .order('name')

    return data ?? []
  }

  async createManager(dto: { name: string; email: string; password: string; role: string }) {
    const hash = await bcrypt.hash(dto.password, 12)
    const { data, error } = await supabase.from('crm_managers').insert({
      name: dto.name,
      email: dto.email.toLowerCase(),
      password_hash: hash,
      role: dto.role,
    }).select('id, name, email, role').single()

    if (error) throw new BadRequestException('Email já cadastrado ou erro ao criar gerente')
    return data
  }

  // =========================================
  // HELPERS PRIVADOS
  // =========================================

  private async assertAssigned(sellerId: string, managerId: string) {
    const { data } = await supabase
      .from('crm_assignments')
      .select('id')
      .eq('seller_id', sellerId)
      .eq('manager_id', managerId)
      .eq('status', 'active')
      .maybeSingle()

    if (!data) {
      throw new ForbiddenException(
        'Você precisa assumir este seller antes de tomar ações sobre ele.'
      )
    }
  }

  private async log(
    sellerId: string,
    managerId: string,
    action: string,
    payload: Record<string, any>,
  ) {
    await supabase.from('crm_action_log').insert({
      seller_id: sellerId,
      manager_id: managerId,
      action,
      payload,
      created_at: new Date(), // 🔥
    }).then(() => { })
  }

  // =========================================
  // ALTERAR PROVIDER DEFAULT
  // =========================================

  async updateProviderDefault(sellerId: string, managerId: string, dto: {
    provider: ProviderDefault
    notes?: string
  }) {
    // Validação: aceita null (limpa) ou um dos valores válidos
    if (dto.provider !== null && !VALID_PROVIDERS.includes(dto.provider as any)) {
      throw new BadRequestException(
        `Provider inválido. Use um de: ${VALID_PROVIDERS.join(', ')} ou null.`
      )
    }

    const { data: current } = await supabase
      .from('seller_profiles')
      .select('provider_default')
      .eq('id', sellerId)
      .single()

    if (!current) throw new NotFoundException('Seller não encontrado')

    const { error } = await supabase
      .from('seller_profiles')
      .update({ provider_default: dto.provider })
      .eq('id', sellerId)

    if (error) throw new BadRequestException('Erro ao atualizar provider: ' + error.message)

    await this.log(sellerId, managerId, 'provider_changed', {
      from: current.provider_default ?? null,
      to: dto.provider,
      notes: dto.notes,
    })

    return { message: 'Provider atualizado', provider: dto.provider }
  }


}