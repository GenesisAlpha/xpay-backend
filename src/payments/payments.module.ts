import { Module } from '@nestjs/common';
import { PaymentService } from './payments.service';
import { PaymentController } from './payments.controller';
import { LinkAccountsInternalController } from './link-accounts-internal.controller';
import { WhopCardBackfillController } from './whop-card-backfill.controller';
import { WhopCardBackfillService } from './whop-card-backfill.service';
import { ClipReconcilerService } from './clip-reconciler.service';

import { WalletModule } from '../wallets/wallet.module';
import { CurrencyModule } from '../currency/currency.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { CryptoModule } from '../crypto/crypto.module';
import { WebhookModule } from '../webhooks/webhook.module';
import { StorageService } from '../lib/storage.service';
import { AffiliatesModule } from '../affiliates/affiliates.module';

@Module({
  imports: [
    WalletModule,
    CurrencyModule,
    CryptoModule,
    WebhookModule,
    // AccountRouterService vem daqui, NÃO como provider local.
    //
    // Declarar como provider local cria uma INSTÂNCIA PRÓPRIA por módulo — e o
    // router guarda estado em memória: o circuit breaker (falhas consecutivas
    // por conta) e o cache de métricas diárias. Com instâncias separadas, uma
    // conta derrubada no fluxo de pagamento continuava saudável no fluxo de
    // sessão, e o balanceamento por déficit lia caches divergentes.
    OrchestratorModule,
    AffiliatesModule,
  ],
  providers: [
    PaymentService,
    StorageService,
    WhopCardBackfillService,
    ClipReconcilerService,
  ],
  exports: [PaymentService],
  controllers: [PaymentController, WhopCardBackfillController, LinkAccountsInternalController],
})
export class PaymentModule {}
