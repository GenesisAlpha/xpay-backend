import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { KycDto, OperationDto, DocumentsDto } from './onboarding.dto';
import { JwtOnly } from '../auth/guards/jtw.auth.guard';
import { ActivationRequestsService } from '../activation/activation-requests.service';
import { ActivationRequestDto } from '../activation/activation-request.dto';

@Controller('onboarding')
export class OnboardingController {
  constructor(
    private readonly onboardingService: OnboardingService,
    private readonly activationRequests: ActivationRequestsService,
  ) {}

  // POST /onboarding/kyc
  @Post('kyc')
  @JwtOnly()
  async saveKyc(@Req() req: any, @Body() dto: KycDto) {
    return this.onboardingService.saveKyc(req.user.sub, dto);
  }

  // POST /onboarding/operation
  @Post('operation')
  @JwtOnly()
  async saveOperation(@Req() req: any, @Body() dto: OperationDto) {
    return this.onboardingService.saveOperation(req.user.sub, dto);
  }

  // POST /onboarding/documents
  @Post('documents')
  @JwtOnly()
  async saveDocuments(@Req() req: any, @Body() dto: DocumentsDto) {
    return this.onboardingService.saveDocuments(req.user.sub, dto);
  }

  // GET /onboarding/activation-request — CNPJ liberado? + última solicitação
  @Get('activation-request')
  @JwtOnly()
  async getActivationRequest(@Req() req: any) {
    return this.activationRequests.getForUser(req.user.sub);
  }

  // POST /onboarding/activation-request — pede ativação por CNPJ ou
  // orientação para abrir uma empresa americana
  @Post('activation-request')
  @JwtOnly()
  async requestActivation(@Req() req: any, @Body() dto: ActivationRequestDto) {
    return this.activationRequests.request(req.user.sub, dto);
  }
}
