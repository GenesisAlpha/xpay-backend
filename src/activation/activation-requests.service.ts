import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { MailService } from '../utils/mail'
import { contactEmailFor } from '../integration/seller-accounts'

// ═══════════════════════════════════════════════════════════════════════════
// SOLICITAÇÕES DE ATIVAÇÃO — exceções ao onboarding por LLC
// ---------------------------------------------------------------------------
// O onboarding padrão aceita só LLC americana (conta conectada na Whop). Quem
// não tem LLC pede ativação por CNPJ ou orientação para abrir uma empresa
// americana. O CRM decide:
//   approve_cnpj  → libera o cadastro com CNPJ (vende pela conta master)
//   direct_to_llc → orienta a abrir uma LLC (mensagem por e-mail e no painel)
//   reject        → recusa com motivo
// ═══════════════════════════════════════════════════════════════════════════

export type ActivationKind = 'cnpj' | 'us_company'
export type ActivationDecision = 'approve_cnpj' | 'direct_to_llc' | 'reject'

const TABLE = 'seller_activation_requests'

const DECISION_STATUS: Record<ActivationDecision, string> = {
  approve_cnpj: 'approved',
  direct_to_llc: 'directed_to_llc',
  reject: 'rejected',
}

@Injectable()
export class ActivationRequestsService {
  constructor(private readonly mail: MailService) { }

  // ─── Seller ───────────────────────────────────────────────────────────────

  async isCnpjAllowed(userId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from(TABLE)
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'approved')
      .limit(1)

    if (error) {
      console.error('[ActivationRequests] isCnpjAllowed:', error.message)
      throw new BadRequestException('Não foi possível verificar a liberação do CNPJ agora. Tente novamente.')
    }
    return (data ?? []).length > 0
  }

  async getForUser(userId: string) {
    const [allowed, latest] = await Promise.all([
      this.isCnpjAllowed(userId),
      supabase
        .from(TABLE)
        .select('id, kind, status, seller_message, seller_facing_message, decided_at, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    return { cnpjAllowed: allowed, latest: latest.data ?? null }
  }

  async request(userId: string, dto: { kind: ActivationKind; message?: string }) {
    if (dto.kind === 'cnpj' && await this.isCnpjAllowed(userId)) return this.getForUser(userId)

    const { data: seller } = await supabase.from('seller_profiles').select('id').eq('user_id', userId).maybeSingle()

    const { error } = await supabase.from(TABLE).insert({
      user_id: userId,
      seller_id: seller?.id ?? null,
      kind: dto.kind,
      seller_message: dto.message?.trim() || null,
    })

    if (error) {
      // Índice parcial: uma solicitação pendente por usuário.
      if ((error as any).code === '23505') {
        throw new ConflictException('Você já tem uma solicitação em análise. Aguarde a resposta da equipe.')
      }
      console.error('[ActivationRequests] request:', error.message)
      throw new BadRequestException('Não foi possível enviar sua solicitação agora. Tente novamente.')
    }

    return this.getForUser(userId)
  }

  // ─── CRM ──────────────────────────────────────────────────────────────────

  async list(params: { status?: string }) {
    let query = supabase.from(TABLE).select('*').order('created_at', { ascending: false }).limit(200)
    if (params.status && params.status !== 'all') query = query.eq('status', params.status)

    const { data, error } = await query
    if (error) throw new BadRequestException(error.message)

    const rows = data ?? []
    const userIds = [...new Set(rows.map(r => r.user_id))]
    const { data: users } = userIds.length
      ? await supabase.from('users').select('id, name, email, whatsapp, instagram').in('id', userIds)
      : { data: [] as any[] }
    const usersById = new Map((users ?? []).map(u => [u.id, u]))

    return rows.map(r => ({ ...r, user: usersById.get(r.user_id) ?? null }))
  }

  async decide(id: string, managerId: string, dto: { decision: ActivationDecision; notes?: string; message?: string }) {
    const status = DECISION_STATUS[dto.decision]
    if (!status) throw new BadRequestException('Decisão inválida.')

    const message = dto.message?.trim() || null
    if (dto.decision !== 'approve_cnpj' && !message) {
      throw new BadRequestException('Escreva a mensagem para o seller: ele recebe por e-mail e vê no cadastro.')
    }

    const { data: current } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle()
    if (!current) throw new NotFoundException('Solicitação não encontrada.')
    if (current.status !== 'pending') throw new BadRequestException(`Solicitação já decidida (${current.status}).`)

    const now = new Date().toISOString()
    const { data: updated, error } = await supabase
      .from(TABLE)
      .update({
        status,
        decision_notes: dto.notes?.trim() || null,
        seller_facing_message: message,
        decided_by: managerId,
        decided_at: now,
        updated_at: now,
      })
      .eq('id', id)
      .eq('status', 'pending') // CAS: duas pessoas decidindo ao mesmo tempo
      .select('*')
      .maybeSingle()

    if (error || !updated) {
      throw new BadRequestException('Não foi possível registrar a decisão. Outra pessoa pode ter decidido antes.')
    }

    const { error: logError } = await supabase.from('crm_action_log').insert({
      seller_id: current.seller_id,
      manager_id: managerId,
      action: `activation_request.${dto.decision}`,
      resource_type: 'seller',
      resource_id: current.seller_id ?? current.user_id,
      payload: { request_id: id, kind: current.kind, notes: dto.notes ?? null },
      created_at: new Date(),
    })
    if (logError) console.error('[ActivationRequests] crm_action_log:', logError.message)

    // O e-mail não desfaz a decisão se falhar: a mensagem também aparece no
    // cadastro do seller. O CRM recebe `emailSent` para saber se precisa avisar.
    const { data: user } = await supabase.from('users').select('name, email, owner_user_id').eq('id', current.user_id).maybeSingle()
    // Conta a mais tem e-mail interno: a resposta vai para o dono.
    const to = await contactEmailFor(user)
    let emailSent = false
    if (to) {
      try {
        await this.mail.sendActivationDecisionEmail({
          to,
          name: user.name ?? '',
          decision: dto.decision,
          message,
        })
        emailSent = true
      } catch (err: any) {
        console.error('[ActivationRequests] e-mail da decisão:', err?.message)
      }
    }

    return { request: updated, emailSent }
  }
}
