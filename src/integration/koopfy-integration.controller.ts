// integration/koopfy-integration.controller.ts
//
// Endpoints consumidos pelo serviço CHECKOUT (server-to-server, com o JWT do
// seller repassado). Rotas: /integration/koopfy/* (sob /pay/* via nginx em prod).

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { CrossServiceJwtGuard, CrossServiceTokenGuard } from './cross-service-jwt.guard';
import { KoopfyIntegrationService } from './koopfy-integration.service';
import { DocumentsDto, KycDto, OperationDto, RequirementsDto } from '../onboarding/onboarding.dto';
import { OnboardingService } from '../onboarding/onboarding.service';
import { ActivationRequestDto } from '../activation/activation-request.dto';

@Controller('integration/koopfy')
export class KoopfyIntegrationController {
  constructor(
    private readonly svc: KoopfyIntegrationService,
    private readonly onboarding: OnboardingService,
  ) {}

  // Estado do onboarding/conta do seller (não retorna segredos).
  // Usa o guard leve (só valida assinatura + email): a conta pode ainda NÃO
  // existir no pay — nesse caso retornamos `not_found` para o checkout oferecer
  // a criação, em vez de 401 (que viraria "indisponível" lá no checkout).
  @Get('status')
  @UseGuards(CrossServiceTokenGuard)
  status(@Req() req: any) {
    return this.svc.getStatus(req.tokenEmail, req.accountSellerId ?? null);
  }

  // Contas Koopfy Payments do usuário (a principal e as criadas a mais), para o
  // workspace escolher qual usar.
  @Get('accounts')
  @UseGuards(CrossServiceTokenGuard)
  accounts(@Req() req: any) {
    return this.svc.listAccounts(req.tokenEmail);
  }

  // Conta nova, do zero (cadastro, saldo e repasses próprios).
  @Post('accounts')
  @UseGuards(CrossServiceTokenGuard)
  createAccount(@Req() req: any, @Body() body: any) {
    return this.svc.createAccount(req.tokenEmail, { name: body?.name });
  }

  // Ativa a integração e emite a API key (texto puro retornado UMA vez)
  @Post('activate')
  @UseGuards(CrossServiceJwtGuard)
  activate(@Req() req: any) {
    return this.svc.activate(req.sellerCtx);
  }

  // Provisiona a conta do seller a partir da identidade compartilhada (não exige
  // que a conta já exista; guard só valida a assinatura do token).
  @Post('provision')
  @UseGuards(CrossServiceTokenGuard)
  provision(@Req() req: any, @Body() body: any) {
    return this.svc.provision(req.tokenEmail, body ?? {});
  }

  @Post('onboarding/kyc')
  @UseGuards(CrossServiceJwtGuard)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  saveKyc(@Req() req: any, @Body() body: KycDto) {
    return this.onboarding.saveKyc(req.sellerCtx.userId, body);
  }

  @Post('onboarding/operation')
  @UseGuards(CrossServiceJwtGuard)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  saveOperation(@Req() req: any, @Body() body: OperationDto) {
    return this.onboarding.saveOperation(req.sellerCtx.userId, body);
  }

  @Post('onboarding/documents')
  @UseGuards(CrossServiceJwtGuard)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  saveDocuments(@Req() req: any, @Body() body: DocumentsDto) {
    return this.onboarding.saveDocuments(req.sellerCtx.userId, body);
  }

  // Liberação de CNPJ e última solicitação (CNPJ / empresa americana).
  @Get('onboarding/activation-request')
  @UseGuards(CrossServiceJwtGuard)
  activationRequest(@Req() req: any) {
    return this.svc.getActivationRequest(req.sellerCtx);
  }

  @Post('onboarding/activation-request')
  @UseGuards(CrossServiceJwtGuard)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  requestActivation(@Req() req: any, @Body() body: ActivationRequestDto) {
    return this.svc.requestActivation(req.sellerCtx, body);
  }

  // Verificação embutida no painel (KycElement da Whop): token de identidade de
  // 1h da conta conectada do seller, gerado a cada abertura.
  @Post('onboarding/connected-verification')
  @UseGuards(CrossServiceJwtGuard)
  connectedVerificationSession(@Req() req: any) {
    return this.svc.connectedVerificationSession(req.sellerCtx);
  }

  // Link para concluir a verificação da empresa no formulário da Whop. Gerado a
  // cada clique: vale ~1h e dá acesso a saque, então não pode ser guardado.
  @Post('onboarding/connected-link')
  @UseGuards(CrossServiceJwtGuard)
  connectedOnboardingLink(@Req() req: any) {
    return this.svc.connectedOnboardingLink(req.sellerCtx);
  }

  // Pendências do cadastro e pedidos da Whop, enviadas pelo painel do seller.
  @Post('onboarding/requirements')
  @UseGuards(CrossServiceJwtGuard)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  submitRequirements(@Req() req: any, @Body() body: RequirementsDto) {
    return this.onboarding.submitRequirements(req.sellerCtx.userId, body);
  }

  // ─── Kontino (Pix, SPEI e banco) ───────────────────────────────────────────
  // A conta Kontino é do seller: abrir, retomar o cadastro e ler o status.
  // Guard leve: quem ainda não tem conta no pay também pode começar por aqui.

  @Get('kontino')
  @UseGuards(CrossServiceTokenGuard)
  kontinoStatus(@Req() req: any) {
    return this.svc.kontinoStatus(req.tokenEmail, req.accountSellerId ?? null);
  }

  @Post('kontino')
  @UseGuards(CrossServiceTokenGuard)
  kontinoStart(@Req() req: any, @Body() body: any) {
    return this.svc.kontinoStart(req.tokenEmail, req.accountSellerId ?? null, body ?? {});
  }

  // ─── Provedor externo (conta Whop do próprio seller) ───────────────────────
  // Liberado para todos; o CRM só corta.

  // Guard leve: quem ainda não tem conta no pay também conecta (a conta nasce aqui).
  @Post('external-provider/connect')
  @UseGuards(CrossServiceTokenGuard)
  connectExternalProvider(
    @Req() req: any,
    @Body() body: { apiKey?: string; label?: string; multiAccount?: boolean; acceptFee?: boolean; replace?: boolean },
  ) {
    // multiAccount/acceptFee/replace: o que fazer com a conta que já recebe —
    // ver KoopfyIntegrationService.prepareConnection.
    return this.svc.connectExternalProvider(
      req.tokenEmail,
      req.accountSellerId ?? null,
      String(body?.apiKey ?? ''),
      body?.label ?? null,
      { multiAccount: body?.multiAccount, acceptFee: body?.acceptFee, replace: body?.replace },
    );
  }

  // Stripe e PayPal do próprio seller (mesmo guard leve e mesma criação de conta
  // da Whop). Whop e Stripe são exclusivas; PayPal combina com qualquer uma.
  // Resposta: a mesma visão de status.externalProvider (com `providers`).
  @Post('external-provider/stripe/connect')
  @UseGuards(CrossServiceTokenGuard)
  connectStripe(
    @Req() req: any,
    @Body() body: { secretKey?: string; publishableKey?: string; label?: string; multiAccount?: boolean; acceptFee?: boolean; replace?: boolean },
  ) {
    return this.svc.connectOwnProvider(req.tokenEmail, req.accountSellerId ?? null, 'stripe', body ?? {});
  }

  @Post('external-provider/stripe/disconnect')
  @UseGuards(CrossServiceJwtGuard)
  disconnectStripe(@Req() req: any) {
    return this.svc.disconnectOwnProvider(req.sellerCtx, 'stripe');
  }

  @Post('external-provider/paypal/connect')
  @UseGuards(CrossServiceTokenGuard)
  connectPaypal(
    @Req() req: any,
    @Body() body: { clientId?: string; clientSecret?: string; mode?: 'live' | 'test'; label?: string; multiAccount?: boolean; acceptFee?: boolean; replace?: boolean },
  ) {
    return this.svc.connectOwnProvider(req.tokenEmail, req.accountSellerId ?? null, 'paypal', body ?? {});
  }

  @Post('external-provider/paypal/disconnect')
  @UseGuards(CrossServiceJwtGuard)
  disconnectPaypal(@Req() req: any) {
    return this.svc.disconnectOwnProvider(req.sellerCtx, 'paypal');
  }

  // Desconecta UMA conta própria (whopl_/whopa_/stripel_/paypall_): com o
  // roteamento o seller tem várias do mesmo provedor. Resposta: a visão de
  // status.externalProvider.
  @Post('external-provider/accounts/:accountId/disconnect')
  @UseGuards(CrossServiceJwtGuard)
  @HttpCode(HttpStatus.OK)
  disconnectOwnAccount(@Req() req: any, @Param('accountId') accountId: string) {
    return this.svc.disconnectOwnAccount(req.sellerCtx, accountId);
  }

  // ─── Conta de pagamento ─────────────────────────────────────────────────
  // Koopfy Payments (o provedor que a Koopfy configurou) ou provedor externo
  // (as contas próprias do seller). Resposta: { mode, chosen, koopfy, external }.

  @Get('payment-account')
  @UseGuards(CrossServiceJwtGuard)
  paymentAccount(@Req() req: any) {
    return this.svc.paymentAccountView(req.sellerCtx);
  }

  // Body: { mode: 'koopfy' | 'external' }
  @Put('payment-account')
  @UseGuards(CrossServiceJwtGuard)
  updatePaymentAccount(@Req() req: any, @Body() body: any) {
    return this.svc.updatePaymentAccount(req.sellerCtx, body ?? {});
  }

  // ─── Roteamento de contas ──────────────────────────────────────────────
  // Ligado pelo seller (com aceite da taxa); várias Whop/Stripe/PayPal e a
  // estratégia de cada grupo. Resposta de todas: a visão completa do GET.

  @Get('routing')
  @UseGuards(CrossServiceJwtGuard)
  routing(@Req() req: any) {
    return this.svc.routingView(req.sellerCtx);
  }

  // Body: { enabled?, acceptFee?, strategies?: { [slot]: estratégia | null }, cardStrategy?, paypalStrategy? }
  // (cardStrategy/paypalStrategy = apelidos de strategies.card/strategies.paypal)
  @Put('routing')
  @UseGuards(CrossServiceJwtGuard)
  updateRouting(@Req() req: any, @Body() body: any) {
    return this.svc.updateRouting(req.sellerCtx, body ?? {});
  }

  // Body: { label?, weight?, priority?, dailyCapUsdCents?, dailyCapOrders?,
  // minTicketUsdCents?, maxTicketUsdCents?, countries?, currencies?, paused? }
  @Put('routing/accounts/:accountId')
  @UseGuards(CrossServiceJwtGuard)
  updateRoutingAccount(@Req() req: any, @Param('accountId') accountId: string, @Body() body: any) {
    return this.svc.updateRoutingAccount(req.sellerCtx, accountId, body ?? {});
  }

  // Roteamento desligado: a conta que recebe as vendas (as que dividem slot
  // com ela ficam guardadas). Com o roteamento ligado, 400 ROUTING_ENABLED.
  @Post('routing/accounts/:accountId/default')
  @UseGuards(CrossServiceJwtGuard)
  setDefaultRoutingAccount(@Req() req: any, @Param('accountId') accountId: string) {
    return this.svc.setDefaultRoutingAccount(req.sellerCtx, accountId);
  }

  // "Para qual conta iria esta venda?": mesmas regras da escolha real, sem gravar nada.
  // Body: { method?, country?, currency?, amountUsdCents?, link? }
  @Post('routing/simulate')
  @UseGuards(CrossServiceJwtGuard)
  routingSimulate(@Req() req: any, @Body() body: any) {
    return this.svc.routingSimulate(req.sellerCtx, body ?? {});
  }

  // Pedidos, aprovadas, faturamento e disputas por conta e por dia (até 90 dias).
  @Get('routing/series')
  @UseGuards(CrossServiceJwtGuard)
  routingSeries(@Req() req: any, @Query('days') days?: string) {
    return this.svc.routingSeries(req.sellerCtx, days);
  }

  // O que mudou nas contas e no roteamento (conexões, ajustes, pausas, saques).
  @Get('routing/history')
  @UseGuards(CrossServiceJwtGuard)
  routingHistory(@Req() req: any, @Query('limit') limit?: string) {
    return this.svc.routingHistory(req.sellerCtx, limit);
  }

  // Financeiro de TODAS as contas próprias (Whop principal e extras, Stripe e
  // PayPal): cada conta com o saldo dela e o total por moeda.
  @Get('external-provider/finance')
  @UseGuards(CrossServiceJwtGuard)
  externalFinance(@Req() req: any) {
    return this.svc.externalFinanceOverview(req.sellerCtx);
  }

  // Carteira de UMA conta: saldo, destinos do saque, histórico e agenda.
  @Get('external-provider/accounts/:accountId/wallet')
  @UseGuards(CrossServiceJwtGuard)
  externalAccountWallet(@Req() req: any, @Param('accountId') accountId: string) {
    return this.svc.externalAccountWallet(req.sellerCtx, accountId);
  }

  // Body: { amountCents, currency, payoutMethodId? }. Resposta: a carteira atualizada.
  @Post('external-provider/accounts/:accountId/withdrawals')
  @UseGuards(CrossServiceJwtGuard)
  @HttpCode(HttpStatus.OK)
  externalAccountWithdraw(@Req() req: any, @Param('accountId') accountId: string, @Body() body: any) {
    return this.svc.externalAccountWithdraw(req.sellerCtx, accountId, body ?? {});
  }

  // Permissões da chave: o que falta ativar para saldo/saque e para as carteiras.
  @Get('external-provider/accounts/:accountId/permissions')
  @UseGuards(CrossServiceJwtGuard)
  externalAccountPermissions(@Req() req: any, @Param('accountId') accountId: string) {
    return this.svc.externalAccountPermissions(req.sellerCtx, accountId);
  }

  // Apple Pay / Google Pay: domínios registrados na conta Whop ou Stripe dele.
  @Get('external-provider/accounts/:accountId/payment-domains')
  @UseGuards(CrossServiceJwtGuard)
  externalAccountDomains(@Req() req: any, @Param('accountId') accountId: string) {
    return this.svc.externalAccountDomains(req.sellerCtx, accountId);
  }

  // Body: { hostname }. Registra e pede a verificação; devolve a lista atualizada.
  @Post('external-provider/accounts/:accountId/payment-domains')
  @UseGuards(CrossServiceJwtGuard)
  @HttpCode(HttpStatus.OK)
  externalAccountRegisterDomain(@Req() req: any, @Param('accountId') accountId: string, @Body() body: any) {
    return this.svc.externalAccountRegisterDomain(req.sellerCtx, accountId, body?.hostname);
  }

  // Financeiro da conta externa: saldo, contas bancárias e saques, lidos da
  // conta Whop do seller com a chave que ele conectou.
  @Get('external-provider/wallet')
  @UseGuards(CrossServiceJwtGuard)
  externalProviderWallet(@Req() req: any) {
    return this.svc.externalProviderWallet(req.sellerCtx);
  }

  @Post('external-provider/withdrawals')
  @UseGuards(CrossServiceJwtGuard)
  externalProviderWithdraw(@Req() req: any, @Body() body: any) {
    return this.svc.externalProviderWithdraw(req.sellerCtx, body ?? {});
  }

  @Post('external-provider/disconnect')
  @UseGuards(CrossServiceJwtGuard)
  disconnectExternalProvider(@Req() req: any) {
    return this.svc.disconnectExternalProvider(req.sellerCtx);
  }

  // Emite um token curto p/ SSO no dash-pay (seller já deve existir — provision antes).
  @Post('sso')
  @UseGuards(CrossServiceJwtGuard)
  sso(@Req() req: any) {
    return this.svc.sso(req.sellerCtx);
  }

  // Saldo da carteira do seller — consumido pelo card "Seu saldo" da home do
  // checkout. Só leitura: nenhuma operação de saque acontece por aqui (o saque
  // continua exclusivo do dash-pay, com o JWT próprio do pay).
  //
  // Usa o guard leve pelo mesmo motivo do /status: a conta pode ainda NÃO
  // existir no pay, e aí a resposta certa é `not_found` (o checkout mostra o
  // CTA de ativação) e não 401 — que viraria "indisponível" lá na home.
  @Get('balance')
  @UseGuards(CrossServiceTokenGuard)
  balance(@Req() req: any) {
    return this.svc.getBalance(req.tokenEmail, req.accountSellerId ?? null);
  }

  // Carteira recorrente do seller para a central de assinaturas do checkout.
  // A consulta é somente leitura e o service resolve o seller pelo email do JWT;
  // nenhuma tabela privada do Pay fica exposta ao navegador.
  @Get('subscriptions')
  @UseGuards(CrossServiceTokenGuard)
  subscriptions(@Req() req: any, @Query() query: any) {
    return this.svc.getSubscriptions(req.tokenEmail, query, req.accountSellerId ?? null);
  }

  // Grupo de WhatsApp da operação logística deste merchant — definido pelo CRM
  // na aprovação. Guard leve pelo mesmo motivo do /status e do /balance.
  @Get('logistics-channel')
  @UseGuards(CrossServiceTokenGuard)
  logisticsChannel(@Req() req: any) {
    return this.svc.getLogisticsChannel(req.tokenEmail, req.accountSellerId ?? null);
  }
}
