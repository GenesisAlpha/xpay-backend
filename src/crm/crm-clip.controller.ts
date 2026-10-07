import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { CrmAuthGuard, Roles } from './crm.module'
import { CrmClipService, type ClipAccountInput, type ClipStatus } from './crm-clip.service'

// ─── Contas Clip (MX): roteamento de cartão e SPEI ─────────────────────────
//
// Pool da plataforma, não do seller: o seller só aponta para `clip`
// (PATCH /crm/sellers/:id/provider) e a conta é escolhida por venda, pelo
// risco do seller. Aqui se define, por conta, o modo (só cartão, cartão + SPEI,
// só SPEI), o status, os tetos de volume e o peso na divisão.
//
// Saque do SPEI e fila de comprovantes continuam em /crm/spei/*.

@Controller('crm/clip')
@UseGuards(CrmAuthGuard)
@Roles('admin', 'supervisor')
export class CrmClipController {
  constructor(private readonly clip: CrmClipService) { }

  @Get('accounts')
  overview() {
    return this.clip.overview()
  }

  @Get('accounts/:id/history')
  history(@Param('id') id: string) {
    return this.clip.history(id)
  }

  @Get('accounts/:id/reservations')
  reservations(@Param('id') id: string) {
    return this.clip.recentReservations(id)
  }

  // Credenciais e tetos mexem no volume de todos os sellers Clip: só admin.
  @Post('accounts')
  @Roles('admin')
  create(@Req() req: any, @Body() body: ClipAccountInput) {
    return this.clip.create(req.manager.sub, body ?? {})
  }

  @Patch('accounts/:id')
  @Roles('admin')
  update(@Param('id') id: string, @Req() req: any, @Body() body: ClipAccountInput) {
    return this.clip.update(id, req.manager.sub, body ?? {})
  }

  @Post('accounts/:id/status')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { status: ClipStatus; reason?: string },
  ) {
    return this.clip.setStatus(id, req.manager.sub, body?.status, body?.reason)
  }

  @Post('accounts/:id/attach')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  attach(@Param('id') id: string, @Req() req: any, @Body() body: { cardId?: string; speiId?: string }) {
    return this.clip.attach(id, req.manager.sub, body ?? {})
  }
}
