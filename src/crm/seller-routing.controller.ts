import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common'
import { CrmAuthGuard, Roles } from './crm.module'
import { SellerRoutingService } from '../orchestrator/routing/seller-routing.service'

// ─── Roteamento de contas do seller, visto pela equipe ─────────────────────
//
// Quem liga é o seller, no painel (é lá que ele aceita a taxa). A equipe vê as
// contas e as métricas, define a taxa de roteamento e o limite de disputa que
// pausa as contas daquele seller, e pode DESLIGAR o roteamento.
//
// Resposta (GET e PUT): a mesma visão do painel —
//   { enabled, enabledAt, feePct, routingFeePct, feeAcceptedAt, cardStrategy,
//     paypalStrategy, disputePausePct, disputePausePctEffective, accounts[] }
// com approvalRate/disputeRate em fração (0–1) e score 0–100.

@Controller('crm/admin/sellers/:sellerId/routing')
@UseGuards(CrmAuthGuard)
export class SellerRoutingCrmController {
  constructor(private readonly routing: SellerRoutingService) { }

  @Get()
  @Roles('admin', 'supervisor')
  view(@Param('sellerId') sellerId: string) {
    return this.routing.view(sellerId)
  }

  // Body: { routingFeePct?: number | null, disputePausePct?: number | null, enabled?: false }
  // null volta ao padrão (0,8% de taxa; 0,75% de disputa).
  @Put()
  @Roles('admin')
  update(@Param('sellerId') sellerId: string, @Req() req: any, @Body() body: any) {
    return this.routing.crmUpdate(sellerId, body ?? {}, req.manager?.sub ?? null)
  }
}
