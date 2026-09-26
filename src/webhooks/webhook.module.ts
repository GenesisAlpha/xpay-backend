import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WhopConnectedWebhookService } from './whop-connected-webhook.service';
import { WalletModule } from '../wallets/wallet.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { CurrencyModule } from '../currency/currency.module';
import { PayoutModule } from '../payouts/payout.module';
import { SellerBillingModule } from '../seller-billing/seller-billing.module';

@Module({
  imports: [WalletModule, OrchestratorModule, CurrencyModule, PayoutModule, SellerBillingModule],
  controllers: [WebhookController],
  providers: [WebhookService, WhopConnectedWebhookService],
  exports: [WebhookService],
})
export class WebhookModule {}
