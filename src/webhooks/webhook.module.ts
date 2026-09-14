import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WalletModule } from '../wallets/wallet.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { CurrencyModule } from '../currency/currency.module';

@Module({
  imports: [WalletModule, OrchestratorModule, CurrencyModule],
  controllers: [WebhookController],
  providers: [WebhookService],
  exports: [WebhookService],
})
export class WebhookModule {}