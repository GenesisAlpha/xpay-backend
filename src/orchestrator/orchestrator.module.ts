import { Module } from '@nestjs/common';
import { AccountRouterService } from './router/account-router.service';
import { CryptoModule } from '../crypto/crypto.module';

@Module({
  imports: [CryptoModule], // 🔥 precisa pra decrypt
  providers: [
    AccountRouterService,
  ],
  exports: [AccountRouterService],
})
export class OrchestratorModule {}