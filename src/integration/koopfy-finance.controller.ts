import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CrossServiceJwtGuard } from './cross-service-jwt.guard';
import { KoopfyFinanceService } from './koopfy-finance.service';

@Controller('integration/koopfy/finance')
@UseGuards(CrossServiceJwtGuard)
export class KoopfyFinanceController {
  constructor(private readonly finance: KoopfyFinanceService) {}

  @Get('overview')
  overview(@Req() req: any, @Query('period') period?: string) {
    return this.finance.getOverview(req.sellerCtx, period);
  }

  /** Taxas por transação ({ ids: string[] }), para o lucro do Analytics. */
  @Post('transaction-fees')
  transactionFees(@Req() req: any, @Body() body: { ids?: unknown }) {
    return this.finance.transactionFees(req.sellerCtx, body?.ids);
  }

  @Get('transactions')
  transactions(@Req() req: any, @Query() query: Record<string, unknown>) {
    return this.finance.listTransactions(req.sellerCtx, query);
  }

  @Get('transactions/:id')
  transaction(@Req() req: any, @Param('id') id: string) {
    return this.finance.getTransaction(req.sellerCtx, id);
  }

  @Get('wallet')
  wallet(@Req() req: any) {
    return this.finance.getWallet(req.sellerCtx);
  }

  // Antecipação do saldo a liquidar (habilitada por seller no CRM).
  @Get('anticipation')
  anticipationQuote(@Req() req: any) {
    return this.finance.getAnticipationQuote(req.sellerCtx);
  }

  @Post('anticipation')
  anticipate(@Req() req: any, @Body() body: Record<string, unknown>) {
    return this.finance.anticipate(req.sellerCtx, body ?? {});
  }

  @Get('wallet/entries')
  walletEntries(@Req() req: any, @Query() query: Record<string, unknown>) {
    return this.finance.listWalletEntries(req.sellerCtx, query);
  }

  @Get('wallet/payouts')
  payouts(@Req() req: any, @Query() query: Record<string, unknown>) {
    return this.finance.listPayouts(req.sellerCtx, query);
  }

  // Mínimo, taxas e líquido do saque para mostrar antes de confirmar.
  @Get('payouts/quote')
  payoutQuote(@Req() req: any, @Query() query: Record<string, unknown>) {
    return this.finance.getPayoutQuote(req.sellerCtx, query);
  }

  // Conta de recebimento: contas salvas na Whop (conta conectada) ou manual.
  @Get('payouts/destinations')
  payoutDestinations(@Req() req: any, @Query('country') country?: string) {
    return this.finance.getPayoutDestinations(req.sellerCtx, country);
  }

  @Get('payouts/destinations/fields')
  payoutDestinationFields(@Req() req: any, @Query() query: Record<string, unknown>) {
    return this.finance.getPayoutDestinationFields(req.sellerCtx, query);
  }

  @Get('payout-account')
  payoutAccount(@Req() req: any) {
    return this.finance.getPayoutAccount(req.sellerCtx);
  }

  @Post('payout-account/verification')
  startPayoutVerification(
    @Req() req: any,
    @Body() body: { returnUrl?: unknown },
  ) {
    return this.finance.startPayoutVerification(req.sellerCtx, {
      returnUrl: body?.returnUrl,
    });
  }

  @Post('payout-account/sync')
  syncPayoutAccount(@Req() req: any) {
    return this.finance.syncPayoutAccount(req.sellerCtx);
  }

  @Get('payout-methods/supported')
  supportedPayoutMethods(@Req() req: any) {
    return this.finance.listSupportedPayoutMethods(req.sellerCtx);
  }

  @Get('payout-methods')
  payoutMethods(@Req() req: any) {
    return this.finance.listSavedPayoutMethods(req.sellerCtx);
  }

  @Post('payout-methods')
  createPayoutMethod(
    @Req() req: any,
    @Body()
    body: {
      supportedMethodId?: unknown;
      destinationCurrency?: unknown;
      fields?: unknown;
      nickname?: unknown;
      isDefault?: unknown;
    },
  ) {
    return this.finance.createPayoutMethod(req.sellerCtx, {
      supportedMethodId: body?.supportedMethodId,
      destinationCurrency: body?.destinationCurrency,
      fields: body?.fields,
      nickname: body?.nickname,
      isDefault: body?.isDefault,
    });
  }

  @Delete('payout-methods/:id')
  removePayoutMethod(@Req() req: any, @Param('id') id: string) {
    return this.finance.removePayoutMethod(req.sellerCtx, id);
  }

  @Post('payout-preview')
  previewPayout(
    @Req() req: any,
    @Body()
    body: { methodId?: unknown; speed?: unknown; grossMinor?: unknown },
  ) {
    return this.finance.previewPayout(req.sellerCtx, {
      methodId: body?.methodId,
      speed: body?.speed,
      grossMinor: body?.grossMinor,
    });
  }

  // O seller vem do token verificado; um sellerId no corpo é descartado.
  @Post('payouts')
  requestPayout(
    @Req() req: any,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.finance.requestPayout(req.sellerCtx, body ?? {}, idempotencyKey);
  }

  @Post('payouts/:id/reconfirm')
  reconfirmPayout(
    @Req() req: any,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: { confirmedMinimumNetMinor?: unknown },
  ) {
    return this.finance.reconfirmPayout(
      req.sellerCtx,
      id,
      body?.confirmedMinimumNetMinor,
      idempotencyKey,
    );
  }

  @Get('transfers/totals')
  transferTotals(@Req() req: any) {
    return this.finance.getTransferTotals(req.sellerCtx);
  }

  @Get('transfers')
  transfers(@Req() req: any, @Query() query: Record<string, unknown>) {
    return this.finance.listTransfers(req.sellerCtx, query);
  }

  @Post('transfers/:id/retry')
  retryTransfer(@Req() req: any, @Param('id') id: string) {
    return this.finance.retryTransfer(req.sellerCtx, id);
  }

  @Get('disputes/stats')
  disputeStats(@Req() req: any) {
    return this.finance.getDisputeStats(req.sellerCtx);
  }

  @Get('disputes')
  disputes(@Req() req: any, @Query() query: Record<string, unknown>) {
    return this.finance.listDisputes(req.sellerCtx, query);
  }

  @Post('disputes/:id/respond')
  respondToDispute(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { message?: unknown; evidenceUrls?: unknown },
  ) {
    return this.finance.respondToDispute(req.sellerCtx, id, {
      message: body?.message,
      evidenceUrls: body?.evidenceUrls,
    });
  }

  @Get('payment-methods')
  paymentMethods(@Req() req: any) {
    return this.finance.listPaymentMethods(req.sellerCtx);
  }

  // Configuração de um método pelo seller. Hoje só o SPEI tem: o nome do
  // beneficiário que o comprador vê nos dados da transferência.
  // Body: { beneficiaryName } — vazio volta ao nome da loja.
  @Patch('payment-methods/:id/config')
  updatePaymentMethodConfig(@Req() req: any, @Param('id') id: string, @Body() body: { beneficiaryName?: unknown }) {
    return this.finance.updatePaymentMethodConfig(req.sellerCtx, id, { beneficiaryName: body?.beneficiaryName });
  }

  @Get('payment-methods/:id/performance')
  paymentMethodPerformance(@Req() req: any, @Param('id') id: string) {
    return this.finance.getPaymentMethodPerformance(req.sellerCtx, id);
  }

  @Get('settings')
  settings(@Req() req: any) {
    return this.finance.getIntegrationSettings(req.sellerCtx);
  }

  @Patch('settings')
  updateSettings(
    @Req() req: any,
    @Body() body: { url?: unknown; events?: unknown },
  ) {
    return this.finance.updateIntegrationSettings(req.sellerCtx, {
      url: body?.url,
      events: body?.events,
    });
  }

  @Get('settings/webhook-secret')
  webhookSecret(@Req() req: any) {
    return this.finance.revealWebhookSecret(req.sellerCtx);
  }

  @Get('offers')
  offers(@Req() req: any) {
    return this.finance.listOffers(req.sellerCtx);
  }

  @Post('offers')
  addOffer(
    @Req() req: any,
    @Body()
    body: { name?: unknown; salesPageUrl?: unknown; riskLevel?: unknown },
  ) {
    return this.finance.addOffer(req.sellerCtx, {
      name: body?.name,
      salesPageUrl: body?.salesPageUrl,
      riskLevel: body?.riskLevel,
    });
  }

  @Get('api-keys')
  apiKeys(@Req() req: any) {
    return this.finance.listApiKeys(req.sellerCtx);
  }

  @Post('api-keys')
  createApiKey(@Req() req: any, @Body() body: { name?: unknown }) {
    return this.finance.createApiKey(req.sellerCtx, body?.name);
  }

  @Delete('api-keys/:id')
  revokeApiKey(@Req() req: any, @Param('id') id: string) {
    return this.finance.revokeApiKey(req.sellerCtx, id);
  }

  @Post('api-keys/:id/rotate')
  rotateApiKey(@Req() req: any, @Param('id') id: string) {
    return this.finance.rotateApiKey(req.sellerCtx, id);
  }
}
