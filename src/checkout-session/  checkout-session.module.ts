// checkout.module.ts

import { Module } from '@nestjs/common';
import { CheckoutSessionController } from './  checkout-session.controller';
import { CheckoutService } from './  checkout-session.service';
import { AccountRouterService } from '../orchestrator/router/account-router.service';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';

@Module({
  controllers: [CheckoutSessionController],
  providers: [
    CheckoutService,
  ],
  imports: [OrchestratorModule]
})
export class CheckoutModule {}