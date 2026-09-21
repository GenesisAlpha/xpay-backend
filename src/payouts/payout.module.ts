import { Module } from '@nestjs/common';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import {
  SellerPayoutAccountService,
  SellerPayoutRepository,
} from './seller-payout-account.service';
import { WhopPayoutClient } from './whop-payout.client';
import {
  PayoutExecutionRepository,
  PayoutOrchestratorService,
} from './payout-orchestrator.service';

@Module({
  imports: [OrchestratorModule],
  providers: [
    WhopPayoutClient,
    SellerPayoutRepository,
    SellerPayoutAccountService,
    PayoutExecutionRepository,
    PayoutOrchestratorService,
  ],
  exports: [
    WhopPayoutClient,
    SellerPayoutAccountService,
    PayoutOrchestratorService,
  ],
})
export class PayoutModule {}
