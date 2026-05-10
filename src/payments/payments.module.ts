import { Module } from '@nestjs/common';
import { PaymentService } from './payments.service';
import { PaymentController } from './payments.controller';

import { WalletModule } from '../wallets/wallet.module';
import { CurrencyModule } from '../currency/currency.module';
import { AccountRouterService } from '../orchestrator/router/account-router.service';
import { CryptoModule } from '../crypto/crypto.module';

@Module({
  imports: [
    WalletModule,
    CurrencyModule,
    CryptoModule
  ],
  providers: [
    PaymentService,
    AccountRouterService
  ],
  exports: [PaymentService],
  controllers: [PaymentController],
})
export class PaymentModule {}