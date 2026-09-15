import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { CrmAuthGuard, Roles } from './crm.module'
import { ActivationRequestsService } from '../activation/activation-requests.service'

// ─── Solicitações de ativação (CNPJ ou empresa americana) ──────────────────
//
// Liberar CNPJ é decisão de risco — fica com supervisor e admin.

@Controller('crm/activation-requests')
@UseGuards(CrmAuthGuard)
export class ActivationRequestsController {
  constructor(private readonly requests: ActivationRequestsService) { }

  @Get()
  @Roles('admin', 'supervisor')
  list(@Query('status') status?: string) {
    return this.requests.list({ status: status ?? 'pending' })
  }

  @Post(':id/decide')
  @Roles('admin', 'supervisor')
  @HttpCode(HttpStatus.OK)
  decide(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { decision: 'approve_cnpj' | 'direct_to_llc' | 'reject'; notes?: string; message?: string },
  ) {
    return this.requests.decide(id, req.manager.sub, {
      decision: body?.decision,
      notes: body?.notes,
      message: body?.message,
    })
  }
}
