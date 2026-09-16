import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common'
import { CrmAuthGuard, Roles } from './crm.module'
import { WhopLinkedAccountsService } from '../orchestrator/whop/whop-linked.service'

// ─── Conta Whop PRÓPRIA do seller (modo conexão) ───────────────────────────
//
// O seller já vende na Whop e autoriza a Koopfy a cobrar na conta dele. A
// conexão é feita AQUI, pelo time: a chave de API dá acesso à conta inteira
// dele e não passa por tela de autoatendimento.
//
// Diferente da conta conectada: o dinheiro fica com ele (sem taxa de
// aplicação, sem reserva, sem repasse pela Koopfy) e a nossa remuneração é a
// comissão de afiliado combinada.

@Controller('crm/admin/sellers/:sellerId/whop-linked')
@UseGuards(CrmAuthGuard)
export class WhopLinkedController {
  constructor(private readonly linked: WhopLinkedAccountsService) { }

  @Get()
  @Roles('admin', 'supervisor')
  status(@Param('sellerId') sellerId: string) {
    return this.linked.status(sellerId)
  }

  // Libera (ou corta) o modo conta externa. Liberado, o painel do seller mostra
  // "Conecte seu provedor externo" e quem conecta é ele.
  @Post('allow')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  allow(@Param('sellerId') sellerId: string, @Req() req: any, @Body() body: { enabled?: boolean }) {
    return this.linked.allow(sellerId, body?.enabled !== false, req.manager.sub)
  }

  // Conectar pelo CRM (suporte): o caminho normal é o seller conectar sozinho.
  @Post()
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  connect(@Param('sellerId') sellerId: string, @Req() req: any, @Body() body: { apiKey?: string }) {
    return this.linked.connect(sellerId, body?.apiKey ?? '', req.manager.sub)
  }

  @Post('disconnect')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  disconnect(@Param('sellerId') sellerId: string, @Req() req: any, @Body() body: { reason?: string }) {
    return this.linked.disconnect(sellerId, body?.reason ?? '', req.manager.sub)
  }

  @Post('commission')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  commission(@Param('sellerId') sellerId: string, @Req() req: any, @Body() body: { commissionPct?: number }) {
    return this.linked.setCommission(sellerId, Number(body?.commissionPct), req.manager.sub)
  }
}
