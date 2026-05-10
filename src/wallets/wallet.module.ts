import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { SettlementCronService } from './settlement.cron';

@Module({
  providers: [WalletService, SettlementCronService],
  exports: [WalletService],
})
export class WalletModule {}