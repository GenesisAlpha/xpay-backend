// crm-backend/crm.controller.ts

import {
  Controller, Post, Get, Patch, Delete, Body, Param,
  Query, Req, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common'
import { CrmService } from './crm.service'
import { CrmAuthGuard } from './crm.module'
import { Roles } from './crm.module';

@Controller('crm')
export class CrmController {
  constructor(private readonly crm: CrmService) { }

  // ─── Auth ─────────────────────────────────────────────────────────────────
  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: { email: string; password: string }) {
    return this.crm.login(body.email, body.password)
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
      feeOverride?: any
      notes?: string
    },
  ) {
    return this.crm.approveSeller(id, req.manager.sub, body)
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
  @HttpCode(HttpStatus.OK)
  activate(@Param('id') id: string, @Req() req: any) {
    return this.crm.activateSeller(id, req.manager.sub)
  }

  // ─── Risco e Taxas ────────────────────────────────────────────────────────

  @Patch('sellers/:id/risk')
  @UseGuards(CrmAuthGuard)
  changeRisk(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { riskLevel: 'WHITE' | 'GRAY' | 'BLACK'; reason: string },
  ) {
    return this.crm.changeRiskLevel(id, req.manager.sub, body)
  }

  @Patch('sellers/:id/fees')
  @UseGuards(CrmAuthGuard)
  overrideFees(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: any,
  ) {
    return this.crm.overrideFees(id, req.manager.sub, body)
  }

  @Patch('sellers/:id/methods')
  @UseGuards(CrmAuthGuard)
  updateMethods(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { enabledMethods: string[]; notes?: string },
  ) {
    return this.crm.updateEnabledMethods(id, req.manager.sub, body)
  }

  // ─── Ofertas ──────────────────────────────────────────────────────────────

  @Post('sellers/:sellerId/offers/:offerId/approve')
  @UseGuards(CrmAuthGuard)
  @HttpCode(HttpStatus.OK)
  approveOffer(
    @Param('sellerId') sellerId: string,
    @Param('offerId') offerId: string,
    @Req() req: any,
    @Body() body: { notes?: string },
  ) {
    return this.crm.approveOffer(offerId, sellerId, req.manager.sub, body.notes)
  }

  @Post('sellers/:sellerId/offers/:offerId/reject')
  @UseGuards(CrmAuthGuard)
  @HttpCode(HttpStatus.OK)
  rejectOffer(
    @Param('sellerId') sellerId: string,
    @Param('offerId') offerId: string,
    @Req() req: any,
    @Body() body: { reason: string },
  ) {
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
  updateProvider(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: {
      provider: 'stripe' | 'viva' | 'sibs' | 'stripe_crypto' | 'onramp' | null
      notes?: string
    },
  ) {
    return this.crm.updateProviderDefault(id, req.manager.sub, body)
  }

}