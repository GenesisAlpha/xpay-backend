// integration/koopfy-integration.module.ts
import { Module } from '@nestjs/common';
import { KoopfyIntegrationController } from './koopfy-integration.controller';
import { KoopfyIntegrationService } from './koopfy-integration.service';
import { KoopfyFinanceController } from './koopfy-finance.controller';
import { KoopfyFinanceService } from './koopfy-finance.service';
import { StorageService } from '../lib/storage.service';
import {
  ApiKeysModule,
  DashboardModule,
  DisputesModule,
  PaymentMethodsModule,
  SettingsModule,
  TransactionsModule,
  TransfersModule,
  WalletDashModule,
} from '../dashboard/modules/dashboard.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { ActivationModule } from '../activation/activation.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';

@Module({
  // WalletDashModule exporta o WalletService — o saldo do card da home do
  // checkout sai da MESMA fonte que o dash-pay, sem duplicar a lógica.
  // ActivationModule + OrchestratorModule: o status leva as pendências do
  // cadastro (liberação de CNPJ, pedidos da Whop) para o painel do checkout.
  imports: [
    DashboardModule,
    TransactionsModule,
    WalletDashModule,
    DisputesModule,
    TransfersModule,
    PaymentMethodsModule,
    SettingsModule,
    ApiKeysModule,
    OnboardingModule,
    ActivationModule,
    OrchestratorModule,
  ],
  controllers: [KoopfyIntegrationController, KoopfyFinanceController],
  providers: [KoopfyIntegrationService, KoopfyFinanceService, StorageService],
})
export class KoopfyIntegrationModule {}
