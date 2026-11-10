import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { CrmAuthGuard, Roles } from './crm.module'
import { supabase } from '../lib/supabase.client'
import { MethodRoutingService } from '../orchestrator/method-routing/method-routing.service'

/**
 * CRM › Roteamento por método: quem cobra cada método (Pix/SPEI → Kontino,
 * cartão → Kaja…), regras por país/moeda, exceções por seller, disponibilidade
 * de cada provedor, simulador e histórico. Supervisor lê; só admin altera.
 */
function actorOf(req: any): string {
  const m = req.manager
  if (!m) throw new Error('req.manager está vazio — CrmAuthGuard não foi aplicado?')
  return `crm:${m.email ?? m.sub}`
}

async function audit(req: any, action: string, resourceId: string, payload: Record<string, unknown>) {
  const m = req.manager
  const { error } = await supabase.from('crm_action_log').insert({
    seller_id: (payload.seller_id as string) ?? null,
    manager_id: m?.sub ?? null,
    action,
    resource_type: 'seller',
    resource_id: resourceId,
    payload,
    ip_address: (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || null,
    user_agent: req.headers['user-agent'] ?? null,
    created_at: new Date(),
  })
  if (error) console.error('[CrmMethodRouting] auditoria:', error.message)
}

@Controller('crm/method-routing')
@UseGuards(CrmAuthGuard)
@Roles('admin', 'supervisor')
export class CrmMethodRoutingController {
  constructor(private readonly routing: MethodRoutingService) {}

  @Get()
  overview() { return this.routing.overview() }

  @Get('preview')
  preview(@Query('method') method: string, @Query('country') country?: string, @Query('currency') currency?: string, @Query('sellerId') sellerId?: string) {
    return this.routing.preview({ method, country: country || null, currency: currency || null, sellerId: sellerId || null })
  }

  @Post('rules')
  @Roles('admin')
  @HttpCode(200)
  async create(@Req() req: any, @Body() body: any) {
    const saved = await this.routing.upsert({ ...body, id: undefined }, actorOf(req))
    await audit(req, 'method_routing.created', saved.id, { ...saved })
    return saved
  }

  @Put('rules/:id')
  @Roles('admin')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const saved = await this.routing.upsert({ ...body, id }, actorOf(req))
    await audit(req, 'method_routing.updated', id, { ...saved })
    return saved
  }

  @Delete('rules/:id')
  @Roles('admin')
  async remove(@Req() req: any, @Param('id') id: string) {
    const out = await this.routing.remove(id, actorOf(req))
    await audit(req, 'method_routing.deleted', id, {})
    return out
  }
}
