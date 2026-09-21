// src/crm/crm-admin.controller.ts
// ═══════════════════════════════════════════════════════════════════════════
// FIX: Usa CrmAuthGuard (do crm.module) — mesmo guard do crm.controller.ts.
// O guard popula req.manager (não req.user), então o ctxFromReq foi ajustado.
// ═══════════════════════════════════════════════════════════════════════════

import {
  Controller, Get, Post, Patch, Body, Param, Query, Req, UseGuards,
} from '@nestjs/common'
import { CrmAdminService } from './crm-admin.service'
import { CrmAuthGuard, Roles } from './crm.module'

// ─── Helper: extrai contexto do request ────────────────────────────────────
// O CrmAuthGuard popula req.manager com { sub, email, role, name }
function ctxFromReq(req: any) {
  const m = req.manager
  if (!m) {
    // Defesa: se o guard não rodou, isso vai estourar e ajudar a debugar
    throw new Error('req.manager está vazio — CrmAuthGuard não foi aplicado?')
  }
  return {
    managerId: m.sub,
    role: m.role,
    ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip,
    userAgent: req.headers['user-agent'],
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTROLLER
// ═══════════════════════════════════════════════════════════════════════════

@Controller('crm/admin')
@UseGuards(CrmAuthGuard)
@Roles('admin', 'supervisor')  // supervisor read-only, admin tudo
export class CrmAdminController {
  constructor(private readonly admin: CrmAdminService) { }

  // ── Overview ─────────────────────────────────────────────────────────
  @Get('overview')
  getOverview(@Req() req: any, @Query('range') range: string) {
    return this.admin.getOverview(ctxFromReq(req), range ?? '30d')
  }

  @Get('payout-fees')
  listPayoutFees(@Req() req: any) {
    return this.admin.listPayoutFees(ctxFromReq(req))
  }

  @Patch('payout-fees/:methodKey')
  @Roles('admin')
  updatePayoutFee(
    @Req() req: any,
    @Param('methodKey') methodKey: string,
    @Body() body: {
      percentage_bps: number
      fixed_fee_usd_cents: number
      enabled: boolean
      effective_at: string
    },
  ) {
    return this.admin.updatePayoutFee(ctxFromReq(req), methodKey, body)
  }

  // ── Withdrawals ──────────────────────────────────────────────────────
  @Get('withdrawals')
  listWithdrawals(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
  ) {
    return this.admin.listWithdrawals(ctxFromReq(req), {
      status,
      search,
      page: page ? parseInt(page) : 1,
    })
  }

  @Get('withdrawals/:id')
  getWithdrawal(@Req() req: any, @Param('id') id: string) {
    return this.admin.getWithdrawal(ctxFromReq(req), id)
  }

  @Post('withdrawals/:id/approve')
  @Roles('admin')
  approveWithdrawal(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { notes?: string },
  ) {
    return this.admin.approveWithdrawal(ctxFromReq(req), id, body)
  }

  @Post('withdrawals/:id/reject')
  @Roles('admin')
  rejectWithdrawal(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.admin.rejectWithdrawal(ctxFromReq(req), id, body)
  }

  @Post('withdrawals/:id/retry')
  @Roles('admin')
  retryWithdrawal(@Req() req: any, @Param('id') id: string) {
    return this.admin.retryWithdrawal(ctxFromReq(req), id)
  }

  @Post('withdrawals/:id/reconcile')
  @Roles('admin')
  reconcileWithdrawal(@Req() req: any, @Param('id') id: string) {
    return this.admin.reconcileWithdrawal(ctxFromReq(req), id)
  }

  @Post('withdrawals/:id/manual-override')
  @Roles('admin')
  manualOverrideWithdrawal(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { action: string; reason: string },
  ) {
    return this.admin.manualOverrideWithdrawal(ctxFromReq(req), id, body)
  }

  @Post('withdrawals/:id/attach-provider-payout')
  @Roles('admin')
  attachProviderPayout(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { provider_payout_id: string; reason: string },
  ) {
    return this.admin.attachProviderPayout(ctxFromReq(req), id, body)
  }

  @Post('withdrawals/:id/mark-completed')
  @Roles('admin')
  markWithdrawalCompleted(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { provider_tx_id: string; notes?: string },
  ) {
    return this.admin.markWithdrawalCompleted(ctxFromReq(req), id, body)
  }

  @Get('withdrawals/:id/payout-methods')
  listConnectedPayoutMethods(@Req() req: any, @Param('id') id: string) {
    return this.admin.listConnectedPayoutMethods(ctxFromReq(req), id)
  }

  // Seller com conta conectada: o banco recusou o saque e o dinheiro está na
  // conta dele. Reenvia, opcionalmente para outra conta bancária cadastrada.
  @Post('withdrawals/:id/retry-payout')
  @Roles('admin')
  retryConnectedPayout(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { payout_method_id?: string },
  ) {
    return this.admin.retryConnectedPayout(ctxFromReq(req), id, body ?? {})
  }

  @Post('withdrawals/:id/mark-failed')
  @Roles('admin')
  markWithdrawalFailed(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.admin.markWithdrawalFailed(ctxFromReq(req), id, body)
  }

  // ── Balances ─────────────────────────────────────────────────────────
  @Get('balances')
  listBalances(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
  ) {
    // Sem `page` (tela antiga do CRM) volta a lista simples.
    return this.admin.listBalances(ctxFromReq(req), { search, sort, page: page ? parseInt(page) : undefined })
  }

  // ── Transactions ─────────────────────────────────────────────────────
  @Get('transactions')
  listTransactions(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('provider') provider?: string,
    @Query('search') search?: string,
    @Query('seller') sellerId?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
    @Query('page') page?: string,
  ) {
    return this.admin.listTransactions(ctxFromReq(req), {
      status, provider, search, sellerId, dateFrom, dateTo,
      page: page ? parseInt(page) : 1,
    })
  }

  @Post('transactions/:id/refund')
  @Roles('admin')
  refundTransaction(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { amount_usd?: number; reason: string },
  ) {
    return this.admin.refundTransaction(ctxFromReq(req), id, body)
  }

  // ── Chargebacks ──────────────────────────────────────────────────────
  @Get('chargebacks')
  listChargebacks(
    @Req() req: any,
    @Query('status') status?: string,
  ) {
    return this.admin.listChargebacks(ctxFromReq(req), { status })
  }

  @Post('chargebacks/:id/accept')
  @Roles('admin')
  acceptChargeback(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { notes?: string },
  ) {
    return this.admin.acceptChargeback(ctxFromReq(req), id, body)
  }

  @Post('chargebacks/:id/contest')
  @Roles('admin')
  contestChargeback(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { evidence_urls: string[]; notes: string },
  ) {
    return this.admin.contestChargeback(ctxFromReq(req), id, body)
  }

  // ── Audit ────────────────────────────────────────────────────────────
  @Get('audit')
  listAudit(
    @Req() req: any,
    @Query('action') action?: string,
    @Query('resource_type') resourceType?: string,
    @Query('search') search?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
    @Query('limit') limit?: string,
  ) {
    return this.admin.listAudit(ctxFromReq(req), {
      action, resourceType, search, dateFrom, dateTo,
      limit: limit ? parseInt(limit) : 100,
    })
  }
}
