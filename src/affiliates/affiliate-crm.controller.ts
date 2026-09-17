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

  /** Ativa pelo e-mail do checkout, para quem ainda não tem Koopfy Payments. */
  @Post('activate-by-email')
  @Roles('admin')
  activateByEmail(@Req() req: any, @Body() body: { email?: string; ratePct?: number }) {
    return this.affiliates.activateByEmail(ctxFromReq(req), String(body?.email ?? ''), body ?? {})
  }

  /** Desativa/reativa um afiliado que ainda não tem Koopfy Payments. */
  @Post('pending/:affiliateId/status')
  @Roles('admin')
  pendingStatus(@Req() req: any, @Param('affiliateId') affiliateId: string, @Body() body: { status?: string }) {
    return this.affiliates.updatePending(ctxFromReq(req), affiliateId, body?.status === 'active' ? 'active' : 'inactive')
  }

  /** Ativa o programa para a conta e devolve o link de indicação. */
  @Post(':sellerId/activate')
  @Roles('admin')
  activate(@Req() req: any, @Param('sellerId') sellerId: string, @Body() body: { ratePct?: number }) {
    return this.affiliates.activate(ctxFromReq(req), sellerId, body ?? {})
  }

  /** Tira o link do ar; com closeReferrals, também encerra a comissão dos indicados. */
  @Post(':sellerId/deactivate')
  @Roles('admin')
  deactivate(
    @Req() req: any,
    @Param('sellerId') sellerId: string,
    @Body() body: { closeReferrals?: boolean; reason?: string },
  ) {
    return this.affiliates.deactivate(ctxFromReq(req), sellerId, body ?? {})
  }

  @Post(':sellerId/suspend')
  @Roles('admin')
  suspend(@Req() req: any, @Param('sellerId') sellerId: string, @Body() body: { reason?: string }) {
    return this.affiliates.suspend(ctxFromReq(req), sellerId, body?.reason)
  }
}
