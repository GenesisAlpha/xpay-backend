import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common'
import { CrmAuthGuard, Roles } from './crm.module'
import { WhopConnectService } from '../orchestrator/whop/whop-connect.service'

// ─── Conta conectada da Whop por seller (só LLC) ───────────────────────────
//
// Criar, sincronizar, responder pedidos da Whop, ligar/desligar o modo
// conectado, cortar o fallback na master, zerar o risco, cobrir negativo e
// liberar saldo. Escrita só para admin: cada ação aqui muda onde a venda é
// cobrada ou para onde o dinheiro vai.

@Controller('crm/admin/sellers/:sellerId/whop-connect')
@UseGuards(CrmAuthGuard)
export class WhopConnectController {
  constructor(private readonly connect: WhopConnectService) { }

  @Get()
  @Roles('admin', 'supervisor')
  status(@Param('sellerId') sellerId: string) {
    return this.connect.getStatus(sellerId)
  }

  @Post()
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  provision(@Param('sellerId') sellerId: string, @Req() req: any) {
    return this.connect.provision(sellerId, req.manager.sub)
  }

  @Post('sync')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  sync(@Param('sellerId') sellerId: string) {
    return this.connect.sync(sellerId)
  }

  @Post('rfi/answer')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  answerRfi(@Param('sellerId') sellerId: string) {
    return this.connect.answerRequestedInformation(sellerId)
  }

  @Post('charges')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  setCharges(
    @Param('sellerId') sellerId: string,
    @Req() req: any,
    @Body() body: { enabled: boolean; reason?: string },
  ) {
    return this.connect.setChargesEnabled(sellerId, req.manager.sub, { enabled: body?.enabled === true, reason: body?.reason })
  }

  @Post('fallback')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  setFallback(
    @Param('sellerId') sellerId: string,
    @Req() req: any,
    @Body() body: { enabled: boolean; reason: string },
  ) {
    return this.connect.setFallbackEnabled(sellerId, req.manager.sub, { enabled: body?.enabled === true, reason: body?.reason })
  }

  @Post('risk/reset')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  resetRisk(@Param('sellerId') sellerId: string, @Req() req: any, @Body() body: { notes: string }) {
    return this.connect.resetRisk(sellerId, req.manager.sub, body?.notes)
  }

  @Post('cover')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  cover(@Param('sellerId') sellerId: string, @Req() req: any) {
    return this.connect.coverNegativeBalance(sellerId, `manual_${req.manager.sub}_${Date.now()}`)
  }

  @Post('release')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  release(@Param('sellerId') sellerId: string, @Req() req: any) {
    return this.connect.releaseToSeller(sellerId, req.manager.sub)
  }
}
