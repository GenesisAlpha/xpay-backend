import { Module } from '@nestjs/common'
import { OrchestratorModule } from '../orchestrator/orchestrator.module'
import { SellerBillingInternalController } from './seller-billing-internal.controller'
import { SellerBillingService } from './seller-billing.service'

@Module({
  imports: [OrchestratorModule],
  controllers: [SellerBillingInternalController],
  providers: [SellerBillingService],
  exports: [SellerBillingService],
})
export class SellerBillingModule {}
