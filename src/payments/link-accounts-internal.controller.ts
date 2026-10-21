import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Optional,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SellerRoutingService } from '../orchestrator/routing/seller-routing.service';
import { supabase } from '../lib/supabase.client';

// ─── Contas por link pelo canal interno (x-internal-key) ─────────────────────
//
// Mesmas rotas de /payments/routing/link-* (payments.controller), mas com a
// conta do seller no corpo (`sellerId`) em vez da sk_live_. O backend do
// checkout usa estas quando a loja ainda não tem a chave do pay: quem conecta
// só a loja Shopify (ou a Digistore24) e não tem outra conta própria nunca
// conseguia ativar a loja — a ativação exige conta própria cobrando, e a loja
// só entrava no roteamento com a chave da ativação. O backend manda o seller
// vinculado ao workspace (workspace_koopfy_accounts).

const SELLER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Mesmo segredo do canal pay ↔ checkout (checkout-fee-internal.controller). */
function assertInternalKey(key: string) {
  const expected = process.env.INTERNAL_API_KEY || process.env.CHECKOUT_INTERNAL_KEY;
  if (!expected) throw new UnauthorizedException('CHECKOUT_INTERNAL_KEY não configurada no pay.');
  if (!key || key !== expected) throw new UnauthorizedException('Chave interna inválida.');
}

export async function requireSellerId(value: unknown): Promise<string> {
  const sellerId = typeof value === 'string' ? value.trim() : '';
  if (!SELLER_ID_RE.test(sellerId)) throw new BadRequestException('sellerId inválido.');
  const { data, error } = await supabase.from('seller_profiles').select('id').eq('id', sellerId).maybeSingle();
  if (error) throw new ServiceUnavailableException('Não foi possível consultar o seller.');
  if (!data) throw new NotFoundException('Seller não encontrado.');
  return sellerId;
}

function withoutSellerId(body: any): Record<string, any> {
  const { sellerId: _ignored, ...rest } = body ?? {};
  return rest;
}

@Controller('internal/routing')
export class LinkAccountsInternalController {
  constructor(@Optional() private readonly sellerRouting?: SellerRoutingService) {}

  @Post('link-accounts')
  @HttpCode(HttpStatus.OK)
  async register(@Headers('x-internal-key') key: string, @Body() body: any) {
    assertInternalKey(key);
    const sellerId = await requireSellerId(body?.sellerId);
    return this.routing().registerLinkAccount(sellerId, withoutSellerId(body));
  }

  @Post('link-accounts/disable')
  @HttpCode(HttpStatus.OK)
  async disable(@Headers('x-internal-key') key: string, @Body() body: any) {
    assertInternalKey(key);
    const sellerId = await requireSellerId(body?.sellerId);
    return this.routing().disableLinkAccount(sellerId, withoutSellerId(body));
  }

  @Post('link-accounts/connected')
  @HttpCode(HttpStatus.OK)
  async connected(@Headers('x-internal-key') key: string, @Body() body: any) {
    assertInternalKey(key);
    const sellerId = await requireSellerId(body?.sellerId);
    return this.routing().selectExternalForLinkConnect(sellerId, withoutSellerId(body));
  }

  @Post('link-sales')
  @HttpCode(HttpStatus.OK)
  async sale(@Headers('x-internal-key') key: string, @Body() body: any) {
    assertInternalKey(key);
    const sellerId = await requireSellerId(body?.sellerId);
    return this.routing().recordLinkSale(sellerId, withoutSellerId(body));
  }

  private routing(): SellerRoutingService {
    if (!this.sellerRouting) throw new ServiceUnavailableException('Roteamento indisponível.');
    return this.sellerRouting;
  }
}
