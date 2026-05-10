import { Module } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";
import { JwtStrategy } from "../auth/guards/jtw.strategy";

@Module({
  imports:     [],
  controllers: [OnboardingController],
  providers:   [OnboardingService, JwtStrategy],
})
export class OnboardingModule {}