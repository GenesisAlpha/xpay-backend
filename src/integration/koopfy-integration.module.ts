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
import { AnticipationService } from '../wallets/anticipation.service';
import { PayoutModule } from '../payouts/payout.module';
import { KoopfyPaymentDomainsController } from './koopfy-payment-domains.controller';
import { KoopfyPaymentDomainsService } from './koopfy-payment-domains.service';

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
    PayoutModule,
  ],
  controllers: [KoopfyIntegrationController, KoopfyFinanceController, KoopfyPaymentDomainsController],
  providers: [KoopfyIntegrationService, KoopfyFinanceService, StorageService, AnticipationService, KoopfyPaymentDomainsService],
  // O CRM cria a conta de pagamento de quem recebe o provedor externo sem ter
  // passado pelo Koopfy Payments (CrmCheckoutService.setExternalProvider).
  exports: [KoopfyIntegrationService],
})
export class KoopfyIntegrationModule {}
