import { Body, Controller, Get, Post, Query, Req, UseGuards, Headers, Param, HttpCode, HttpStatus, Optional, ServiceUnavailableException } from '@nestjs/common';
import { SellerRoutingService } from '../orchestrator/routing/seller-routing.service';
import { PaymentService } from './payments.service';
import { CreatePaymentDto } from './create-payment.dto';
import { CreateMbwayDto } from './create-mbway.dto';
import { ApiKeyGuard } from '../middleware/api-key.guard';
import { AccountRouterService } from '../orchestrator/router/account-router.service';
import { Request } from 'express';
import * as crypto from 'crypto';


@Controller('payments')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly accountRouter: AccountRouterService,
    @Optional() private readonly sellerRouting?: SellerRoutingService,
  ) { }

  @Post('create')
  @UseGuards(ApiKeyGuard)
  async create(
    @Req() req: Request,
    @Body() dto: CreatePaymentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.paymentService.createPayment({
      ...dto,
      sellerId: req.sellerId,
      // Idempotency-Key do header tem prioridade (dedup obrigatório)
      idempotencyKey: idempotencyKey ?? dto.idempotencyKey,
    });
  }

  // ─── MB Way por API (seller) ──────────────────────────────────────────────
  //
  // Rota dedicada e enxuta pro seller gerar um pagamento MB Way e receber a URL
  // de redirecionamento (página hosted da Sentinel). Autenticada com a sk_live_
  // do seller (ApiKeyGuard). Reusa todo o fluxo de createPayment (FX, fees,
  // routing por provider, webhook). O status final chega no webhook do seller.
  @Post('mbway')
  @UseGuards(ApiKeyGuard)
  async createMbway(
    @Req() req: Request,
    @Body() dto: CreateMbwayDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.paymentService.createPayment({
      amount: dto.amount,
      currency: dto.currency ?? 'EUR',
      method: 'mbway',
      customer: dto.customer,
      postback_url: dto.postback_url,
      metadata: {
        ...(dto.metadata ?? {}),
        // reference vira order_number → exibido na Sentinel + external_reference
        ...(dto.reference ? { order_number: dto.reference } : {}),
        // return_url do seller (a página hosted volta pra cá após o pagamento)
        ...(dto.return_url ? { return_url: dto.return_url } : {}),
      },
      sellerId: req.sellerId,
      idempotencyKey: idempotencyKey ?? dto.idempotencyKey,
    });

    const redirectUrl = result?.redirectUrl ?? result?.checkout_url ?? null;
    return {
      success: !!redirectUrl,
      transactionId: result?.transactionId ?? null,
      status: result?.status ?? null,        // 'requires_action' (cliente precisa pagar)
      redirectUrl,                            // URL pra onde redirecionar o cliente
      reference: dto.reference ?? null,
    };
  }

  // Config de pagamento do seller p/ o checkout do comprador (fluxo unificado).
  // Autenticado com a sk_live_ do seller (o checkout guarda essa key na ativação).
  //
  // Roteamento de contas: `?routingKey=<id da checkout session>` escolhe (ou
  // reaproveita) a conta desta sessão e devolve a credencial pública dela +
  // `routing`. `country`/`currency` opcionais aplicam os filtros das contas.
  @Get('config')
  @UseGuards(ApiKeyGuard)
  async getConfig(
    @Req() req: Request,
    @Query('routingKey') routingKey?: string,
    @Query('country') country?: string,
    @Query('currency') currency?: string,
    @Query('link') link?: string,
    // CSV de shopify,digistore24: contas por link que podem concorrer ao cartão (padrão: shopify).
    @Query('linkProviders') linkProviders?: string,
  ) {
    return this.paymentService.getPaymentConfig(req.sellerId as string, { routingKey, country, currency, link, linkProviders });
  }

  // ─── Contas por link no roteamento (lojas Shopify, Digistore24) ────────
  // O backend do checkout guarda a credencial da conta e chama estas rotas com a
  // sk_live_ do seller (`provider`: 'shopify' | 'digistore24'): registrar/
  // desligar a conta e informar cada venda.

  @Post('routing/link-accounts')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  registerLinkAccount(@Req() req: Request, @Body() body: any) {
    return this.requireRouting().registerLinkAccount(req.sellerId as string, body ?? {});
  }

  @Post('routing/link-accounts/disable')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  disableLinkAccount(@Req() req: Request, @Body() body: any) {
    return this.requireRouting().disableLinkAccount(req.sellerId as string, body ?? {});
  }

  // Conta conectada no backend do checkout fora do pool (Digistore24 sem o
  // produto padrão): conectar escolhe o provedor externo.
  @Post('routing/link-accounts/connected')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  linkAccountConnected(@Req() req: Request, @Body() body: any) {
    return this.requireRouting().selectExternalForLinkConnect(req.sellerId as string, body ?? {});
  }

  @Post('routing/link-sales')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  recordLinkSale(@Req() req: Request, @Body() body: any) {
    return this.requireRouting().recordLinkSale(req.sellerId as string, body ?? {});
  }

  private requireRouting(): SellerRoutingService {
    if (!this.sellerRouting) throw new ServiceUnavailableException('Roteamento indisponível.');
    return this.sellerRouting;
  }

  // Reserva a conta Clip ANTES de o formulário de cartão ser montado.
  // Autenticado com a sk_live_ do seller, igual ao /config — o browser fala com
  // o checkout, o checkout fala com o pay.
  //
  // Resposta { available: false } NÃO é erro: é o teto do dia cheio. O front
  // tem que tratar como "método indisponível agora", nunca dar retry.
  @Post('clip/route')
  @UseGuards(ApiKeyGuard)
  async clipRoute(
    @Req() req: Request,
    @Body() body: { method?: string; amount?: number; external_reference?: string },
  ) {
    return this.paymentService.clipRoute(req.sellerId as string, body);
  }

  @Post('spei/:transactionId/proof')
  @UseGuards(ApiKeyGuard)
  uploadSpeiProof(@Req() req: Request, @Param('transactionId') transactionId: string, @Body() body: any) {
    return this.paymentService.uploadSpeiProof(req.sellerId as string, transactionId, body);
  }

  @Get('spei/:transactionId/status')
  @UseGuards(ApiKeyGuard)
  speiProofStatus(@Req() req: Request, @Param('transactionId') transactionId: string) {
    return this.paymentService.getSpeiProofStatus(req.sellerId as string, transactionId);
  }

  @Get(':transactionId/status')
  @UseGuards(ApiKeyGuard)
  transactionStatus(@Req() req: Request, @Param('transactionId') transactionId: string) {
    return this.paymentService.getTransactionStatus(req.sellerId as string, transactionId);
  }

  // PayPal na conta do seller: os botões aprovaram a order no navegador; a
  // captura é no servidor. Mesma chave (sk_live_ do seller) do /status.
  // Resposta: status approved | pending; recusa/estado inválido → 4xx com código.
  @Post(':transactionId/paypal/capture')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  capturePaypal(@Req() req: Request, @Param('transactionId') transactionId: string) {
    return this.paymentService.capturePaypalOrder(req.sellerId as string, transactionId);
  }

  // Upsell de um clique (Whop): a compra pode ser cobrada de novo sem o comprador
  // digitar o cartão? O checkout consulta antes de mostrar a oferta — uma oferta
  // que falha no clique é pior do que nenhuma. A cobrança em si vai pelo
  // /payments/create com `upsell.parentTransactionId`.
  @Get(':transactionId/upsell-eligibility')
  @UseGuards(ApiKeyGuard)
  upsellEligibility(@Req() req: Request, @Param('transactionId') transactionId: string) {
    return this.paymentService.checkUpsellEligibility(req.sellerId as string, transactionId);
  }

  // Assinatura do comprador (área do cliente). O checkout chama com a sk_live_
  // do vendedor, depois de conferir que o pedido é do comprador logado.
  // Cancelar vale no fim do período pago; reativar desfaz até lá.
  @Get(':transactionId/subscription')
  @UseGuards(ApiKeyGuard)
  customerSubscription(@Req() req: Request, @Param('transactionId') transactionId: string) {
    return this.paymentService.getCustomerSubscription(req.sellerId as string, transactionId);
  }

  @Post(':transactionId/subscription/cancel')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  cancelCustomerSubscription(@Req() req: Request, @Param('transactionId') transactionId: string) {
    return this.paymentService.cancelCustomerSubscription(req.sellerId as string, transactionId);
  }

  @Post(':transactionId/subscription/reactivate')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  reactivateCustomerSubscription(@Req() req: Request, @Param('transactionId') transactionId: string) {
    return this.paymentService.reactivateCustomerSubscription(req.sellerId as string, transactionId);
  }

  // Comprovante de transferência SPEI. Autenticado com a sk_live_ do seller.
  //
  // Devolve só o ESTADO (paid | in_review | rejected). O detalhe da avaliação
  // fica em gw_spei_receipts — devolvê-lo ao comprador seria entregar o gabarito
  // de qual campo ajustar na próxima tentativa.
  @Post('spei/receipt')
  @UseGuards(ApiKeyGuard)
  async speiReceipt(
    @Req() req: Request,
    @Body() body: { reservation_id?: string; file_ref?: string; file_url?: string; file_type?: string },
  ) {
    return this.paymentService.speiReceipt(req.sellerId as string, body);
  }

  // Devolve o espaço de uma reserva que não vai virar cobrança. Chamada pelo
  // checkout ao trocar de valor/método ou ao sair da tela.
  @Post('clip/release')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  async clipRelease(@Req() req: Request, @Body() body: { reservation_id?: string }) {
    return this.paymentService.clipRelease(req.sellerId as string, body?.reservation_id);
  }

  // Session key da Coinflow p/ o cliente montar os botões Apple/Google Pay.
  // Autenticado com a sk_live_ do seller (o checkout faz o proxy).
  @Post('coinflow/session')
  @UseGuards(ApiKeyGuard)
  async coinflowSession(@Req() req: Request, @Body() body: { userId?: string }) {
    const sellerId = req.sellerId as string;
    return this.paymentService.mintCoinflowSession(sellerId, body?.userId ?? sellerId);
  }

  @Post('tracking')
  async syncTracking(@Body() body: any) {
    return this.paymentService.uploadToNexor(body);
  }

  // =========================================================================
  // 🧪 ROTA DE TESTE — charge de cartão direto no provider (sem PaymentService)
  // Bypassa FX, fees, transação, settlement. Só monta o ctx e chama o provider.
  // ⚠️ Remover/proteger antes de produção (sem guard).
  //
  // Body (CARTÃO):
  // {
  //   "accountId": "setinel_gate_main",   // opcional (default abaixo)
  //   "method": "card",                    // opcional (default "card")
  //   "amount": 5000,                       // centavos
  //   "currency": "USD",
  //   "email": "buyer@example.com",
  //   "name": "John Doe",
  //   "card": { "number": "4111111111111111", "cvv": "123", "expMonth": "12", "expYear": "26" }
  // }
  //
  // Body (APPLE/GOOGLE PAY):
  // {
  //   "method": "apple_pay",               // ou "google_pay"
  //   "amount": 5000,
  //   "currency": "USD",
  //   "email": "buyer@example.com",
  //   "walletToken": { ...token do SDK da carteira... }
  // }
  // =========================================================================
  @Post('test/charge')
  async testCharge(@Body() body: any) {
    const dto = {
      amount: Number(body.amount),          // centavos
      currency: body.currency ?? 'USD',
      method: body.method ?? 'card',
      customer: {
        email: body.email,
        name: body.name,
        phone: body.phone,
        document: body.document,
      },
      payment_data: {
        cardNumber: body.card?.number,
        cvv: body.card?.cvv,
        expMonth: body.card?.expMonth,
        expYear: body.card?.expYear,
        walletToken: body.walletToken,
      },
    };

    const transactionId = `test_${crypto.randomUUID()}`;

    const result = await this.accountRouter.executeWithProvider({
      providerAccountId: body.accountId ?? 'setinel_gate_main',
      dto,
      transactionId,
    });

    return { transactionId, result };
  }

}
