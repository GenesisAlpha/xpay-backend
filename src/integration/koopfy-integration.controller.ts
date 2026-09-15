// integration/koopfy-integration.controller.ts
//
// Endpoints consumidos pelo serviço CHECKOUT (server-to-server, com o JWT do
// seller repassado). Rotas: /integration/koopfy/* (sob /pay/* via nginx em prod).

import {
  Body,
  Controller,
  Get,
  Post,
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

  // Pendências do cadastro e pedidos da Whop, enviadas pelo painel do seller.
  @Post('onboarding/requirements')
  @UseGuards(CrossServiceJwtGuard)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  submitRequirements(@Req() req: any, @Body() body: RequirementsDto) {
    return this.onboarding.submitRequirements(req.sellerCtx.userId, body);
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
