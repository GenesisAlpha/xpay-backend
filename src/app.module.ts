import { Module } from '@nestjs/common';
import { PaymentModule } from './payments/payments.module';
import { WebhookModule } from './webhooks/webhook.module';
import { ProviderModule } from './providers/providers.module';
import { WalletModule } from './wallets/wallet.module';
import { ConfigModule } from '@nestjs/config';
import { SellersModule } from './sellers/sellers.module';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { CheckoutModule } from './checkout-session/  checkout-session.module';
import { ApiKeysModule, DashboardModule, DisputesModule, PaymentMethodsModule, SettingsModule, TransactionsModule, TransfersModule, WalletDashModule } from './dashboard/modules/dashboard.module';
import { CurrencyModule } from './currency/currency.module';
import { CryptoModule } from './crypto/crypto.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { CrmModule } from './crm/crm.module';
import { AffiliatesModule } from './affiliates/affiliates.module';
import { KoopfyIntegrationModule } from './integration/koopfy-integration.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PaymentModule,
    WebhookModule,
    ProviderModule,
    WalletModule,
    SellersModule,
    AuthModule,
    ApiKeysModule,
    CheckoutModule,
    OnboardingModule,
 
    // Dashboard
    DashboardModule,
    TransactionsModule,
    WalletDashModule,
    DisputesModule,
    TransfersModule,
    PaymentMethodsModule,
    SettingsModule,
 
    // Core de pagamentos
    CurrencyModule,
    CryptoModule,
    CrmModule,
    AffiliatesModule,

    // Integração com o serviço checkout (Koopfy Pay como gateway)
    KoopfyIntegrationModule
  ],
  controllers: [AppController]
})
export class AppModule {}