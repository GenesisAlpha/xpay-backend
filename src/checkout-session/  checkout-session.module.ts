// checkout.module.ts

import { Module } from '@nestjs/common';
import { CheckoutSessionController } from './  checkout-session.controller';
import { CheckoutService } from './  checkout-session.service';
import { PaymentModule } from '../payments/payments.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';

@Module({
  controllers: [CheckoutSessionController],
  providers: [
    CheckoutService,
  ],
  imports: [OrchestratorModule, PaymentModule]
})
export class CheckoutModule {}