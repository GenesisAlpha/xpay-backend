import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { KycDto, OperationDto } from './onboarding.dto';
import { JwtOnly } from '../auth/guards/jtw.auth.guard';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

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
}