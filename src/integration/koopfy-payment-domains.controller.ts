import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CrossServiceJwtGuard } from './cross-service-jwt.guard';
import { KoopfyPaymentDomainsService } from './koopfy-payment-domains.service';

// Domínio do site do seller na Whop (Apple Pay no checkout incorporado).
// O seller vem do token verificado.
@Controller('integration/koopfy/finance/payment-domains')
@UseGuards(CrossServiceJwtGuard)
export class KoopfyPaymentDomainsController {
  constructor(private readonly domains: KoopfyPaymentDomainsService) {}

  @Get()
  status(@Req() req: any, @Query('hostname') hostname?: string) {
    return this.domains.status(req.sellerCtx, hostname);
  }

  @Post()
  @HttpCode(200)
  register(@Req() req: any, @Body() body: { hostname?: unknown }) {
    return this.domains.register(req.sellerCtx, body?.hostname);
  }
}
