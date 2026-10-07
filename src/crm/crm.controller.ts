// crm-backend/crm.controller.ts

import {
  Controller, Post, Get, Patch, Delete, Body, Param,
  Query, Req, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common'
import { CrmService } from './crm.service'
import { CrmAuthGuard } from './crm.module'
import { Roles } from './crm.module';
import { requestMetaFrom } from './crm-request-context'

// Permissões:
// - leitura de sellers e fila de risco: qualquer gerente logado;
// - ações sobre um seller: admin/supervisor, ou o gerente que assumiu o seller
//   (assertCanManage);
// - suspender/ativar: supervisor ou admin;
// - SPEI, contas Whop e MIDs: admin.
@Controller('crm')
export class CrmController {
  constructor(private readonly crm: CrmService) { }

  // ─── Auth ─────────────────────────────────────────────────────────────────
  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  login(@Req() req: any, @Body() body: { email: string; password: string }) {
    return this.crm.login(body?.email, body?.password, requestMetaFrom(req).ip)
  }

  @Get('auth/me')
  @UseGuards(CrmAuthGuard)
  getMe(@Req() req: any) {
    return this.crm.getMe(req.manager.sub)
  }

  // ─── Dashboard ────────────────────────────────────────────────────────────
  @Get('dashboard')
  @UseGuards(CrmAuthGuard)
  getDashboard(@Req() req: any) {
    return this.crm.getDashboardStats(req.manager.sub, req.manager.role)
  }

  // ─── Sellers ──────────────────────────────────────────────────────────────
  @Get('sellers')
  @UseGuards(CrmAuthGuard)
  listSellers(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('assignedToMe') assignedToMe?: string,
    @Query('unassigned') unassigned?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
  ) {
    return this.crm.listSellers({
      managerId: req.manager.sub,
      role: req.manager.role,
      status,
      assignedToMe: assignedToMe === 'true',
      unassigned: unassigned === 'true',
      search,
      page: page ? Number(page) : 1,
    })
  }

  @Get('sellers/:id')
  @UseGuards(CrmAuthGuard)
  getSellerDetail(@Param('id') id: string) {
    return this.crm.getSellerDetail(id)
  }

  // Abre o painel com a sessão do seller (15 min). O saque fica bloqueado nesse
  // acesso e a abertura entra no log do seller.
  //
  // `workspaceId` vem da tela quando o gestor está olhando uma loja específica —
  // a conta de pagamento pode servir várias.
  @Post('sellers/:id/panel-access')
  @UseGuards(CrmAuthGuard)
  @HttpCode(HttpStatus.OK)
  sellerPanelAccess(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { workspaceId?: string },
  ) {
    return this.crm.sellerPanelAccess(id, req.manager, body?.workspaceId)
  }

  // ─── Assignment ───────────────────────────────────────────────────────────

  @Post('sellers/:id/assign')
  @UseGuards(CrmAuthGuard)
  @HttpCode(HttpStatus.OK)
  assign(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { notes?: string },
  ) {
    return this.crm.assignSeller(id, req.manager.sub, body.notes)
  }

  @Post('sellers/:id/release')
  @UseGuards(CrmAuthGuard)
  @HttpCode(HttpStatus.OK)
  release(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { notes?: string },
  ) {
    return this.crm.releaseSeller(id, req.manager.sub, body.notes)
  }

  @Post('sellers/:id/transfer')
  @UseGuards(CrmAuthGuard)
  @Roles('supervisor', 'admin')
  @HttpCode(HttpStatus.OK)
  transfer(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { toManagerId: string; notes?: string },
  ) {
    return this.crm.transferSeller(id, req.manager.sub, body.toManagerId, body.notes)
  }

  // ─── Decisões ─────────────────────────────────────────────────────────────

  @Post('sellers/:id/approve')
  @UseGuards(CrmAuthGuard)
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: {
      riskLevel: 'WHITE' | 'GRAY' | 'BLACK'
      enabledMethods: string[]
      /** Provedor padrão; sem valor, Whop. */
      provider?: 'whop' | 'stripe' | 'slash' | 'clip'
      feeOverride?: any
      fees?: any
      notes?: string
      /** Grupo de WhatsApp da operação logística — o grupo já existe na aprovação. */
      logisticsGroupUrl?: string | null
    },
  ) {
    return this.crm.approveSeller(id, req.manager.sub, body)
  }

  /**
   * Adiciona / edita / remove o grupo logístico depois da aprovação.
   * Body vazio (`url: null`) desvincula o grupo.
   */
  @Patch('sellers/:id/logistics-group')
  @UseGuards(CrmAuthGuard)
  updateLogisticsGroup(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { url?: string | null; notes?: string; partner?: string | null },
  ) {
    return this.crm.updateLogisticsGroup(id, req.manager.sub, body)
  }

  // ─── Radar de risco de chargeback ─────────────────────────────────────────

  // ─── SPEI: contas e saque ──────────────────────────────────────────────────
  //
  // O teto do SPEI é de ESTOQUE: só volta quando alguém saca. Conta cheia = o
  // roteador para de oferecer SPEI, e sem esta rota a única saída seria UPDATE
  // na mão no banco.
  @Get('spei/accounts')
  @UseGuards(CrmAuthGuard)
  @Roles('admin')
  speiAccounts() {
    return this.crm.listSpeiAccounts()
  }

  /**
   * Registra o saque e libera o teto.
   *
   * ⚠️ Exige `saldo_observado_minor` ALÉM do valor sacado. O observado é o que
   * a pessoa vê no app da Clip naquele instante — é ele que zera a deriva
   * acumulada e revela pagamento fantasma ou comprovante falso aprovado.
   * Aceitar só o valor sacado deixaria o contador ser uma crença que erra um
   * pouco todo mês.
   */
  @Post('spei/accounts/:accountId/withdraw')
  @UseGuards(CrmAuthGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  speiWithdraw(
    @Param('accountId') accountId: string,
    @Req() req: any,
    @Body() body: { saldo_observado_minor?: number; valor_sacado_minor?: number; nota?: string },
  ) {
    return this.crm.withdrawSpei(accountId, req.manager.sub, body)
  }

  // ─── SPEI: fila de comprovantes para revisão humana ───────────────────────
  //
  // Tudo que a análise automática não liberou sozinha: fora da janela de 24h,
  // agendada, centavos que não batem, leitura ruim.
  @Get('spei/proofs')
  @UseGuards(CrmAuthGuard)
  @Roles('admin')
  speiProofs(@Query('page') page?: string, @Query('status') status?: string) {
    return this.crm.listSpeiProofs({ page: page ? Number(page) : 1, status })
  }

  /**
   * Decide um comprovante.
   *
   * ⚠️ `conferido_no_extrato` NÃO é detalhe de formulário. Ele separa "li o
   * comprovante e achei convincente" de "abri o extrato da Clip e o dinheiro
   * está lá". Só o segundo conta como confirmado nos relatórios de saldo —
   * quem olha um print tem a mesma limitação do modelo.
   */
  @Post('spei/proofs/:transactionId/decide')
  @UseGuards(CrmAuthGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  decideSpeiProof(
    @Param('transactionId') transactionId: string,
    @Req() req: any,
    @Body() body: { decision: 'approve' | 'reject'; conferido_no_extrato?: boolean; nota?: string },
  ) {
    return this.crm.decideSpeiProof(transactionId, req.manager.sub, body)
  }

  @Get('orders/risk')
  @UseGuards(CrmAuthGuard)
  orderRisk(
    @Query('page') page?: string,
    @Query('level') level?: string,
    @Query('workspaceId') workspaceId?: string,
    @Query('search') search?: string,
    @Query('since') since?: string,
  ) {
    return this.crm.listOrderRisk({
      page: page ? Number(page) : 1,
      level, workspaceId, search, since,
    })
  }

  @Get('orders/risk/:orderId')
  @UseGuards(CrmAuthGuard)
  orderRiskDetail(@Param('orderId') orderId: string) {
    return this.crm.getOrderRisk(orderId)
  }

  /** Envia a notificação que faltou (idempotente no checkout). */
  @Post('orders/risk/:orderId/notify')
  @UseGuards(CrmAuthGuard)
  @HttpCode(HttpStatus.OK)
  notifyOrder(
    @Param('orderId') orderId: string,
    @Req() req: any,
    @Body() body: { type: 'confirmation' | 'tracking' },
  ) {
    return this.crm.notifyOrder(orderId, req.manager.sub, body?.type ?? 'confirmation')
  }

  /** Catálogo de parceiros logísticos (vem do checkout) — seletor do CRM. */
  @Get('logistics-partners')
  @UseGuards(CrmAuthGuard)
  logisticsPartners() {
    return this.crm.listLogisticsPartners()
  }

  @Post('sellers/:id/reject')
  @UseGuards(CrmAuthGuard)
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { reason: string; notes?: string },
  ) {
    return this.crm.rejectSeller(id, req.manager.sub, body)
  }

  @Post('sellers/:id/suspend')
  @UseGuards(CrmAuthGuard)
  @Roles('supervisor', 'admin')
  @HttpCode(HttpStatus.OK)
  suspend(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { reason: string },
  ) {
    return this.crm.suspendSeller(id, req.manager.sub, body.reason)
  }

  @Post('sellers/:id/activate')
  @UseGuards(CrmAuthGuard)
  @Roles('supervisor', 'admin')
  @HttpCode(HttpStatus.OK)
  activate(@Param('id') id: string, @Req() req: any) {
    return this.crm.activateSeller(id, req.manager.sub)
  }

  // ─── Risco e Taxas ────────────────────────────────────────────────────────

  @Patch('sellers/:id/risk')
  @UseGuards(CrmAuthGuard)
  async changeRisk(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { riskLevel: 'WHITE' | 'GRAY' | 'BLACK'; reason: string },
  ) {
    await this.crm.assertCanManage(id, req.manager)
    return this.crm.changeRiskLevel(id, req.manager.sub, body)
  }

  @Get('fee-defaults')
  @UseGuards(CrmAuthGuard)
  feeDefaults() {
    return this.crm.getFeeDefaults()
  }

  @Patch('sellers/:id/fees')
  @UseGuards(CrmAuthGuard)
  async overrideFees(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: any,
  ) {
    await this.crm.assertCanManage(id, req.manager)
    return this.crm.overrideFees(id, req.manager.sub, body)
  }

  @Patch('sellers/:id/methods')
  @UseGuards(CrmAuthGuard)
  async updateMethods(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { enabledMethods: string[]; notes?: string },
  ) {
    await this.crm.assertCanManage(id, req.manager)
    return this.crm.updateEnabledMethods(id, req.manager.sub, body)
  }

  // ─── Ofertas ──────────────────────────────────────────────────────────────

  @Post('sellers/:sellerId/offers/:offerId/approve')
  @UseGuards(CrmAuthGuard)
  @HttpCode(HttpStatus.OK)
  async approveOffer(
    @Param('sellerId') sellerId: string,
    @Param('offerId') offerId: string,
    @Req() req: any,
    @Body() body: { notes?: string },
  ) {
    await this.crm.assertCanManage(sellerId, req.manager)
    return this.crm.approveOffer(offerId, sellerId, req.manager.sub, body.notes)
  }

  @Post('sellers/:sellerId/offers/:offerId/reject')
  @UseGuards(CrmAuthGuard)
  @HttpCode(HttpStatus.OK)
  async rejectOffer(
    @Param('sellerId') sellerId: string,
    @Param('offerId') offerId: string,
    @Req() req: any,
    @Body() body: { reason: string },
  ) {
    await this.crm.assertCanManage(sellerId, req.manager)
    return this.crm.rejectOffer(offerId, sellerId, req.manager.sub, body.reason)
  }

  // ─── Notas ────────────────────────────────────────────────────────────────

  @Post('sellers/:id/notes')
  @UseGuards(CrmAuthGuard)
  addNote(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { content: string; isPinned?: boolean },
  ) {
    return this.crm.addNote(id, req.manager.sub, body.content, body.isPinned)
  }

  @Delete('notes/:noteId')
  @UseGuards(CrmAuthGuard)
  deleteNote(@Param('noteId') noteId: string, @Req() req: any) {
    return this.crm.deleteNote(noteId, req.manager.sub)
  }

  // ─── Contato ──────────────────────────────────────────────────────────────

  @Post('sellers/:id/contact')
  @UseGuards(CrmAuthGuard)
  logContact(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { type: string; notes: string; outcome?: string },
  ) {
    return this.crm.logContact(id, req.manager.sub, body as any)
  }

  // ─── Gerentes (admin/supervisor) ──────────────────────────────────────────

  @Get('managers')
  @UseGuards(CrmAuthGuard)
  @Roles('supervisor', 'admin')
  listManagers() {
    return this.crm.listManagers()
  }

  @Post('managers')
  @UseGuards(CrmAuthGuard)
  @Roles('admin')
  createManager(@Body() body: { name: string; email: string; password: string; role: string }) {
    return this.crm.createManager(body)
  }

  @Patch('sellers/:id/provider')
  @UseGuards(CrmAuthGuard)
  async updateProvider(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: {
      provider: 'whop' | 'stripe' | 'slash' | 'clip' | null
      notes?: string
    },
  ) {
    await this.crm.assertCanManage(id, req.manager)
    return this.crm.updateProviderDefault(id, req.manager.sub, body)
  }

  // ─── Whop — pool de contas ──────────────────────────────────────────────────
  //
  // Não há rota "conta do seller": o seller só aponta pra `whop` e o router
  // escolhe a company por pedido. O que se administra aqui é o POOL.

  @Get('whop-accounts')
  @UseGuards(CrmAuthGuard)
  @Roles('supervisor', 'admin')
  listWhopAccounts() {
    return this.crm.listWhopAccounts()
  }

  // Provisionamento por CHAVE: descobre a company, registra o webhook e grava
  // tudo. É o caminho normal pra adicionar um titular novo — o POST abaixo fica
  // pra edição e pros casos em que a company já tem webhook próprio.
  @Post('whop-accounts/provision')
  @UseGuards(CrmAuthGuard)
  @Roles('admin')
  provisionWhopAccount(
    @Req() req: any,
    @Body() body: {
      id: string
      apiKey: string
      label?: string
      weight?: number
      dailyCapAmount?: number | null
      legalName?: string
    },
  ) {
    return this.crm.provisionWhopAccount(req.manager.sub, body)
  }

  // Cadastro/edição da conta, incluindo credenciais (só admin).
  @Post('whop-accounts')
  @UseGuards(CrmAuthGuard)
  @Roles('admin')
  upsertWhopAccount(
    @Req() req: any,
    @Body() body: {
      id: string
      label?: string
      companyId: string
      productId?: string
      apiKey?: string
      webhookSecret?: string
      webhookId?: string
      apiUrl?: string
      status?: 'active' | 'inactive'
      weight?: number
      currency?: string
      countries?: string[]
      country?: string
      dailyCapAmount?: number | null
      minTicket?: number | null
      maxTicket?: number | null
      legalName?: string
      descriptor?: string
    },
  ) {
    return this.crm.upsertWhopAccount(req.manager.sub, body)
  }

  // Controles de roteamento (pausar, peso, tetos, cooldown). Sem credencial,
  // mas mexe no volume de todos os sellers: só admin.
  @Patch('whop-accounts/:id')
  @UseGuards(CrmAuthGuard)
  @Roles('admin')
  updateWhopAccountRouting(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: {
      status?: 'active' | 'inactive'
      weight?: number
      dailyCapAmount?: number | null
      minTicket?: number | null
      maxTicket?: number | null
      cooldownUntil?: string | null
      notes?: string
    },
  ) {
    return this.crm.updateWhopAccountRouting(id, req.manager.sub, body)
  }

  // ─── Sentinel MIDs ──────────────────────────────────────────────────────────

  // Lista os MIDs do Sentinel disponíveis (sem segredos) p/ atribuir ao seller.
  @Get('sentinel-mids')
  @UseGuards(CrmAuthGuard)
  @Roles('admin')
  listSentinelMids() {
    return this.crm.listSentinelMids()
  }

  // Registra/atualiza um MID + credenciais (admin).
  @Post('sentinel-mids')
  @UseGuards(CrmAuthGuard)
  @Roles('admin')
  upsertSentinelMid(
    @Req() req: any,
    @Body() body: {
      mid: string
      label?: string
      apiKey: string
      apiSecret: string
      mbwayApiKey?: string
      apiUrl?: string
      status?: 'active' | 'inactive'
    },
  ) {
    return this.crm.upsertSentinelMid(req.manager.sub, body)
  }

  // Atribui (ou limpa) o MID do Sentinel de um seller.
  @Patch('sellers/:id/mid')
  @UseGuards(CrmAuthGuard)
  async updateSellerMid(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { mid: string | null; notes?: string },
  ) {
    await this.crm.assertCanManage(id, req.manager)
    return this.crm.updateSellerMid(id, req.manager.sub, body)
  }

}