import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common'
import { CrossServiceJwtGuard, type SellerCtx } from '../integration/cross-service-jwt.guard'
import { AffiliateEarningsService } from './affiliate-earnings.service'

/**
 * Ganhos de quem indica, lidos pelo painel de afiliado no dash-checkout.
 *
 * Mesmo guard do financeiro: o checkout chama em nome do seller logado, e o
 * seller só enxerga as comissões da própria conta.
 */
@Controller('integration/koopfy/affiliate')
@UseGuards(CrossServiceJwtGuard)
export class AffiliateEarningsController {
  constructor(private readonly earnings: AffiliateEarningsService) {}

  @Get('summary')
  summary(@Req() req: any) {
    return this.earnings.summary(this.sellerId(req.sellerCtx))
  }

  @Get('commissions')
  commissions(@Req() req: any, @Query('limit') limit?: string) {
    return this.earnings.list(this.sellerId(req.sellerCtx), limit ? Number(limit) : undefined)
  }

  private sellerId(ctx: SellerCtx): string {
    const id = ctx?.seller?.id
    if (!id) throw new ForbiddenException('Conta Koopfy Payments não encontrada.')
    return id
  }
}
