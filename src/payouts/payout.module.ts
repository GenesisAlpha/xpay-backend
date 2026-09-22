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
import { WhopPayoutWebhookService } from './whop-payout-webhook.service';
import { PayoutReconcilerService } from './payout-reconciler.service';

@Module({
  imports: [OrchestratorModule],
  providers: [
    WhopPayoutClient,
    SellerPayoutRepository,
    SellerPayoutAccountService,
    PayoutExecutionRepository,
    PayoutOrchestratorService,
    WhopPayoutWebhookService,
    PayoutReconcilerService,
  ],
  exports: [
    WhopPayoutClient,
    SellerPayoutAccountService,
    PayoutOrchestratorService,
    WhopPayoutWebhookService,
  ],
})
export class PayoutModule {}
