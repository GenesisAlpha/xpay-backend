import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { CrmAuthGuard, Roles } from '../crm/crm.module'
import { AffiliateCrmService, type AffiliateCrmContext } from './affiliate-crm.service'

function ctxFromReq(req: any): AffiliateCrmContext {
  const manager = req.manager
  if (!manager) throw new Error('req.manager está vazio — CrmAuthGuard não foi aplicado?')

  return {
    managerId: manager.sub,
    ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip,
    userAgent: req.headers['user-agent'],
  }
}

/** Operação do programa de indicação. Mesmo guard do resto do CRM. */
@Controller('crm/admin/affiliates')
@UseGuards(CrmAuthGuard)
@Roles('admin', 'supervisor')
export class AffiliateCrmController {
  constructor(private readonly affiliates: AffiliateCrmService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    return this.affiliates.list(limit ? Number(limit) : undefined)
  }

  @Get(':sellerId')
  detail(@Param('sellerId') sellerId: string) {
    return this.affiliates.detail(sellerId)
  }

  // Alterar dinheiro é de admin. O @Roles da classe deixa supervisor ler; estes
  // três reduzem para admin.
  @Post(':sellerId/cycle')
  @Roles('admin')
  setCycle(
    @Req() req: any,
    @Param('sellerId') sellerId: string,
    @Body() body: { payoutDay?: number; holdDays?: number },
  ) {
    return this.affiliates.setCycle(ctxFromReq(req), sellerId, body ?? {})
  }

  @Post(':sellerId/rate')
  @Roles('admin')
  setRate(@Req() req: any, @Param('sellerId') sellerId: string, @Body() body: { ratePct?: number }) {
    return this.affiliates.setRate(ctxFromReq(req), sellerId, Number(body?.ratePct))
  }

  @Post(':sellerId/suspend')
  @Roles('admin')
  suspend(@Req() req: any, @Param('sellerId') sellerId: string, @Body() body: { reason?: string }) {
    return this.affiliates.suspend(ctxFromReq(req), sellerId, body?.reason)
  }
}
