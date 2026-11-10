import { BadRequestException, Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { CrmAdminService } from './crm-admin.service'

/**
 * Reembolso de compliance (Política de Uso Aceitável, exigência da Kaja Payments).
 *
 * O checkout chama quando um produto é removido por violação: todo pedido pago e
 * não entregue é reembolsado integralmente ao comprador. Canal interno
 * (x-internal-key, o mesmo segredo de internal/affiliates).
 *
 * Só responde 'refunded' quando o estorno SAIU pela API do provedor (Stripe e
 * Slash, via CrmAdminService.refundTransaction). Nos demais o CRM só marcaria o
 * banco — o comprador seria avisado de um reembolso que não recebeu — então a
 * resposta é 'manual' e a equipe estorna no painel do provedor no mesmo dia.
 *
 * COMPLIANCE_MANAGER_ID: id do gestor do CRM "Compliance (sistema)" que assina a
 * auditoria. Sem ele, tudo vira 'manual'.
 */
const API_REFUND_PROVIDERS = new Set(['stripe', 'slash'])

function assertInternalKey(key: string) {
  const expected = process.env.INTERNAL_API_KEY || process.env.CHECKOUT_INTERNAL_KEY
  if (!expected) throw new UnauthorizedException('CHECKOUT_INTERNAL_KEY não configurada no pay.')
  if (!key || key !== expected) throw new UnauthorizedException('Chave interna inválida.')
}

@Controller('internal/compliance')
export class ComplianceInternalController {
  constructor(private readonly admin: CrmAdminService) {}

  @Post('refund')
  @HttpCode(200)
  async refund(
    @Headers('x-internal-key') key: string,
    @Body() body: { transactionId?: string; reason?: string },
  ) {
    assertInternalKey(key)
    const transactionId = String(body?.transactionId ?? '').trim()
    if (!transactionId) throw new BadRequestException('transactionId é obrigatório.')
    const reason = String(body?.reason ?? '').trim() || 'Produto removido por violação da Política de Uso Aceitável'

    const { data: byId } = await supabase
      .from('transactions').select('id, status, provider').eq('id', transactionId).maybeSingle()
    const tx = byId ?? (await supabase
      .from('transactions').select('id, status, provider').eq('provider_transaction_id', transactionId).maybeSingle()).data

    if (!tx) return { status: 'manual', message: 'Transação não encontrada no pay.' }
    if (tx.status === 'refunded') return { status: 'refunded', message: 'Já reembolsada.' }
    if (tx.status !== 'approved') return { status: 'manual', message: `Transação ${tx.status}: conferir no CRM.` }

    const managerId = (process.env.COMPLIANCE_MANAGER_ID ?? '').trim()
    if (!managerId) return { status: 'manual', message: 'COMPLIANCE_MANAGER_ID não configurado: estornar pelo CRM.' }
    if (!API_REFUND_PROVIDERS.has(String(tx.provider))) {
      return { status: 'manual', message: `Provedor ${tx.provider} sem estorno pela API: estornar no painel do provedor.` }
    }

    try {
      await this.admin.refundTransaction({ managerId, role: 'admin' }, tx.id, { reason: `[compliance] ${reason}` })
      return { status: 'refunded', message: 'Estorno enviado ao provedor.' }
    } catch (err: any) {
      return { status: 'failed', message: err?.message ?? 'Falha no estorno.' }
    }
  }
}
