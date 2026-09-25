// src/crm/crm-tickets.controller.ts
//
// Fila de tickets de suporte no CRM. Os tickets vivem no checkout (tabelas
// ticket/ticket_message); o CRM lê e responde pelo canal interno, porque o
// gestor do CRM não tem o login de staff que o /platform/tickets exige.
//
// Qualquer gestor logado vê e responde: é trabalho de suporte, não de conta.

import {
  BadRequestException, Body, Controller, Get, HttpCode, HttpStatus,
  Param, Post, Query, Req, UseGuards,
} from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { CrmAuthGuard } from './crm.module'
import { checkoutFailureMessage, checkoutInternal } from './checkout-internal'

const STATUSES = ['all', 'open', 'pending', 'resolved', 'escalated']
const TICKET_ID_RE = /^[A-Za-z0-9-]{1,64}$/

/** Nome que o cliente vê na resposta — a equipe fala como a plataforma. */
const REPLY_AUTHOR = 'Koopfy Support'

function assertTicketId(id: string) {
  if (!TICKET_ID_RE.test(id)) throw new BadRequestException('Ticket inválido.')
}

async function logTicketAction(managerId: string, action: string, metadata: Record<string, unknown>) {
  const { error } = await supabase.from('crm_action_log').insert({
    seller_id: null,
    manager_id: managerId,
    action,
    metadata,
  })
  if (error) console.error(`[CrmTickets] log ${action}:`, error.message)
}

@Controller('crm/tickets')
@UseGuards(CrmAuthGuard)
export class CrmTicketsController {
  @Get()
  async list(
    @Query('status') status?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('cursor') cursor?: string,
  ) {
    if (status && !STATUSES.includes(status)) throw new BadRequestException('Status inválido.')
    const qs = new URLSearchParams()
    if (status) qs.set('status', status)
    if (workspaceId) qs.set('workspaceId', workspaceId)
    if (cursor) qs.set('cursor', cursor)
    qs.set('limit', '50')

    const res = await checkoutInternal<any>(`tickets?${qs.toString()}`)
    if (!res) throw new BadRequestException(checkoutFailureMessage('consultar os tickets'))
    return res
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    assertTicketId(id)
    const res = await checkoutInternal<any>(`tickets/${id}`)
    if (!res) throw new BadRequestException(checkoutFailureMessage('abrir o ticket'))
    return res
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  async reply(@Req() req: any, @Param('id') id: string, @Body() body: { body?: string }) {
    assertTicketId(id)
    const text = body?.body?.trim() ?? ''
    if (!text) throw new BadRequestException('Escreva a resposta.')

    const res = await checkoutInternal<any>(`tickets/${id}/messages`, { body: text, authorName: REPLY_AUTHOR })
    if (!res) throw new BadRequestException(checkoutFailureMessage('enviar a resposta'))
    await logTicketAction(req.manager.sub, 'ticket_replied', { ticketId: id })
    return res
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  async setStatus(@Req() req: any, @Param('id') id: string, @Body() body: { status?: string }) {
    assertTicketId(id)
    const status = body?.status
    if (!status || status === 'all' || !STATUSES.includes(status)) {
      throw new BadRequestException('Status inválido.')
    }
    const res = await checkoutInternal<any>(`tickets/${id}/status`, { status })
    if (!res) throw new BadRequestException(checkoutFailureMessage('atualizar o ticket'))
    await logTicketAction(req.manager.sub, 'ticket_status_changed', { ticketId: id, status })
    return res
  }
}
