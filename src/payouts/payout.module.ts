import { Module } from '@nestjs/common';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import {
  SellerPayoutAccountService,
  SellerPayoutRepository,
} from './seller-payout-account.service';
import { WhopPayoutClient } from './whop-payout.client';

@Module({
  imports: [OrchestratorModule],
  providers: [
    WhopPayoutClient,
    SellerPayoutRepository,
    SellerPayoutAccountService,
  ],
  exports: [WhopPayoutClient, SellerPayoutAccountService],
})
export class PayoutModule {}
