// controllers.ts — todos os controllers do dashboard

import {
  Controller, Get, Post, Patch, Param, Query, Body, Req, UseGuards,
  HttpCode,
  Delete,
  HttpStatus
} from '@nestjs/common'
import { JwtOnly } from '../../auth/guards/jtw.auth.guard'
import { DashboardService, Period } from '../services/reports.service'
import {
  TransactionsService, WalletService, DisputesService,
  TransfersService, PaymentMethodsService, SettingsService,
  ApiKeysService,
} from '../services/services'
import { supabase } from '../../lib/supabase.client'

// Helper: resolve sellerId do JWT → seller_profile
// (em produção, injetar um SellerContextService que cacheia a lookup)

async function getSellerId(userId: string): Promise<string> {
  const { data } = await supabase
    .from('seller_profiles')
    .select('id')
    .eq('user_id', userId)
    .single()
  if (!data) throw new Error('Seller profile not found')
  return data.id
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

@Controller('dashboard')
@JwtOnly()
export class DashboardController {
  constructor(private readonly svc: DashboardService) { }

  @Get()
  async get(
    @Req() req: any,
    @Query('period') period: Period = '30d',
  ) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.getData(sellerId, period)
  }
}


// ─── Transactions ─────────────────────────────────────────────────────────────

@Controller('transactions')
@JwtOnly()
export class TransactionsController {
  constructor(private readonly svc: TransactionsService) { }

  @Get()
  async list(@Req() req: any, @Query() q: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.list(sellerId, {
      page: parseInt(q.page ?? '1'),
      pageSize: parseInt(q.pageSize ?? '20'),
      status: q.status,
      method: q.method,
      search: q.search,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
    })
  }

  @Get(':id')
  async getById(@Req() req: any, @Param('id') id: string) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.getById(sellerId, id)
  }
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

@Controller('wallet')
@JwtOnly()
export class WalletController {
  constructor(private readonly svc: WalletService) { }

  @Get('balance')
  async balance(@Req() req: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.getBalance(sellerId)
  }

  @Get('entries')
  async entries(@Req() req: any, @Query() q: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.getEntries(sellerId, {
      page: parseInt(q.page ?? '1'),
      pageSize: parseInt(q.pageSize ?? '20'),
      type: q.type,
      search: q.search,
    })
  }

  @Get('payouts')
  async payouts(@Req() req: any, @Query() q: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.getPayouts(sellerId, {
      page: parseInt(q.page ?? '1'),
      pageSize: parseInt(q.pageSize ?? '20'),
    })
  }

  @Post('payout')
  async requestPayout(@Req() req: any, @Body() body: any) {
    const sellerId = await getSellerId(req.user.sub)
    body.sellerId = sellerId;
    return this.svc.requestPayout(body)
  }
}

// ─── Disputes ─────────────────────────────────────────────────────────────────

@Controller('disputes')
@JwtOnly()
export class DisputesController {
  constructor(private readonly svc: DisputesService) { }

  @Get('stats')
  async stats(@Req() req: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.getStats(sellerId)
  }

  @Get()
  async list(@Req() req: any, @Query() q: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.list(sellerId, {
      page: parseInt(q.page ?? '1'),
      pageSize: parseInt(q.pageSize ?? '20'),
      status: q.status,
      search: q.search,
    })
  }

  @Post(':id/respond')
  async respond(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.respond(sellerId, id, body)
  }
}

// ─── Transfers ────────────────────────────────────────────────────────────────

@Controller('transfers')
@JwtOnly()
export class TransfersController {
  constructor(private readonly svc: TransfersService) { }

  @Get('totals')
  async totals(@Req() req: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.getTotals(sellerId)
  }

  @Get()
  async list(@Req() req: any, @Query() q: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.list(sellerId, {
      page: parseInt(q.page ?? '1'),
      pageSize: parseInt(q.pageSize ?? '20'),
      status: q.status,
      search: q.search,
    })
  }

  @Post(':id/retry')
  async retry(@Req() req: any, @Param('id') id: string) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.retry(sellerId, id)
  }
}

// ─── Payment Methods ──────────────────────────────────────────────────────────

@Controller('payment-methods')
@JwtOnly()
export class PaymentMethodsController {
  constructor(private readonly svc: PaymentMethodsService) { }

  @Get()
  async list(@Req() req: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.list(sellerId)
  }

  @Patch(':id/toggle')
  async toggle(@Req() req: any, @Param('id') id: string, @Body() body: { enabled: boolean }) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.toggle(sellerId, id, body.enabled)
  }

  @Get(':id/performance')
  async performance(@Req() req: any, @Param('id') id: string) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.getPerformance(sellerId, id)
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

@Controller('settings')
@JwtOnly()
export class SettingsController {
  constructor(private readonly svc: SettingsService) { }

  @Get()
  async get(@Req() req: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.get(sellerId, req.user.sub)
  }

  @Patch()
  async update(@Req() req: any, @Body() body: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.svc.update(sellerId, req.user.sub, body)
  }


  @Get('offers')
  async getOffers(@Req() req: any) {
    return this.svc.getOffers(req.user.sub)
  }

  @Post('offers')
  async addOffer(@Req() req: any, @Body() body: any) {
    return this.svc.addOffer(req.user.sub, body)
  }

  @Post('password')
  @HttpCode(200)
  async changePassword(@Req() req: any, @Body() body: any) {
    return this.svc.changePassword(req.user.sub, body.currentPassword, body.newPassword)
  }

  @Get('webhook/secret')
  getWebhookSecret(@Req() req) {
    return this.svc.getWebhookSecret(req.user.sub)
  }
}

// api-keys/api-keys.controller.ts

@Controller('credentials')
export class ApiKeysController {
  constructor(private readonly service: ApiKeysService) { }

  // ─── Criar nova key ───────────────────────────────────────────────────────

  @Post()
  @JwtOnly()
  async create(@Req() req: any, @Body() body: { name?: string }) {
    const sellerId = await getSellerId(req.user.sub)
    return this.service.createKey(sellerId, body.name)
  }

  // ─── Listar keys ──────────────────────────────────────────────────────────

  @Get()
  @JwtOnly()
  async list(@Req() req: any) {
    const sellerId = await getSellerId(req.user.sub)
    return this.service.listKeys(sellerId)
  }

  // ─── Revogar key ──────────────────────────────────────────────────────────

  @Delete(':id')
  @JwtOnly()
  @HttpCode(HttpStatus.OK)
  async revoke(@Req() req: any, @Param('id') id: string) {
    const sellerId = await getSellerId(req.user.sub)
    return this.service.revokeKeyImmediate(sellerId, id)
  }

  // ─── Rotacionar key ───────────────────────────────────────────────────────

  @Post(':id/rotate')
  @JwtOnly()
  async rotate(@Req() req: any, @Param('id') id: string) {
    const sellerId = await getSellerId(req.user.sub)
    return this.service.rotateKey(sellerId, id)
  }

  // ─── Validar key (rota pública — usada por outros serviços) ───────────────

  @Post('validate')
  async validate(@Req() req: Request, @Body() body: any) {
    const authHeader = req.headers['authorization']
    if (!authHeader?.startsWith('Bearer ')) {
      throw new Error('Missing or invalid Authorization header')
    }
    const token = authHeader.split(' ')[1]
    return this.service.validateApiKey(token)
  }

  // ─── Rota de teste (remover em produção) ──────────────────────────────────

  @Post('create')
  async createTest(@Body() body: { name?: string; sellerId: string }) {
    return this.service.createKey(body.sellerId, body.name)
  }
}