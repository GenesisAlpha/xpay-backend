// ============================================================
// MODULES — todos os módulos do dashboard em um arquivo
// Copiar cada @Module para seu respectivo *.module.ts
// ============================================================

import { Module } from '@nestjs/common'

// ─── Dashboard ────────────────────────────────────────────────────────────────
import { ApiKeysController, DashboardController } from '../controllers/controllers'
import { DashboardService } from '../services/reports.service'

// ─── Transactions ─────────────────────────────────────────────────────────────
import { TransactionsController } from '../controllers/controllers'
import { ApiKeysService, TransactionsService } from '../services/services'

// ─── Wallet ───────────────────────────────────────────────────────────────────
import { WalletController } from '../controllers/controllers'
import { WalletService } from '../services/services'

// ─── Disputes ─────────────────────────────────────────────────────────────────
import { DisputesController } from '../controllers/controllers'
import { DisputesService } from '../services/services'

// ─── Transfers ────────────────────────────────────────────────────────────────
import { TransfersController } from '../controllers/controllers'
import { TransfersService } from '../services/services'

// ─── Payment Methods ──────────────────────────────────────────────────────────
import { PaymentMethodsController } from '../controllers/controllers'
import { PaymentMethodsService } from '../services/services'

// ─── Settings ─────────────────────────────────────────────────────────────────
import { SettingsController } from '../controllers/controllers'
import { SettingsService } from '../services/services'

// ─── Payments (já existia) ────────────────────────────────────────────────────
import { PaymentController } from '../../payments/payments.controller'
import { PaymentService } from '../../payments/payments.service'
import { OrchestratorModule } from '../../orchestrator/orchestrator.module'
import { CurrencyModule } from '../../currency/currency.module'
import { CryptoModule } from '../../crypto/crypto.module'
import { StorageService } from '../../lib/storage.service'

// ============================================================
// DASHBOARD MODULE
// ============================================================

@Module({
  controllers: [DashboardController],
  providers:   [DashboardService],
  exports:     [DashboardService],
})
export class DashboardModule {}

// ============================================================
// TRANSACTIONS MODULE
// ============================================================

@Module({
  controllers: [TransactionsController],
  providers:   [TransactionsService, StorageService],
  exports:     [TransactionsService],
})
export class TransactionsModule {}

// ============================================================
// WALLET MODULE
// ============================================================

@Module({
  controllers: [WalletController],
  providers:   [WalletService],
  exports:     [WalletService],   // exportado para PaymentModule usar creditPending()
})
export class WalletDashModule {}

// ============================================================
// DISPUTES MODULE
// ============================================================

@Module({
  controllers: [DisputesController],
  providers:   [DisputesService],
  exports:     [DisputesService],
})
export class DisputesModule {}

// ============================================================
// TRANSFERS MODULE
// ============================================================

@Module({
  controllers: [TransfersController],
  providers:   [TransfersService],
  exports:     [TransfersService],
})
export class TransfersModule {}

// ============================================================
// PAYMENT METHODS MODULE
// ============================================================

@Module({
  controllers: [PaymentMethodsController],
  providers:   [PaymentMethodsService],
  exports:     [PaymentMethodsService],
})
export class PaymentMethodsModule {}

// ============================================================
// SETTINGS MODULE
// ============================================================

@Module({
  controllers: [SettingsController],
  providers:   [SettingsService],
  exports:     [SettingsService],
})
export class SettingsModule {}

// ============================================================
// PAYMENTS MODULE (já existia — atualizado com WalletModule)
// ============================================================

@Module({
  imports: [
    WalletDashModule,
    CurrencyModule,
    CryptoModule,
    // Instância ÚNICA do router — ver comentário em payments/payments.module.ts.
    OrchestratorModule,
  ],
  controllers: [PaymentController],
  providers:   [PaymentService],
  exports:     [PaymentService],
})
export class PaymentModule {}

// api-keys/api-keys.module.ts

@Module({
  providers: [ApiKeysService],
  controllers: [ApiKeysController],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
