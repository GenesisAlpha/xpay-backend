import { Module } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";
import { StorageService } from "../lib/storage.service";
import { JwtStrategy } from "../auth/guards/jtw.strategy";

@Module({
  imports:     [],
  controllers: [OnboardingController],
  providers:   [OnboardingService, StorageService, JwtStrategy],
  exports:     [OnboardingService],
})
export class OnboardingModule {}
