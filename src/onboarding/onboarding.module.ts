import { Module } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";
import { StorageService } from "../lib/storage.service";
import { JwtStrategy } from "../auth/guards/jtw.strategy";
import { ActivationModule } from "../activation/activation.module";
import { OrchestratorModule } from "../orchestrator/orchestrator.module";

@Module({
  // ActivationModule: solicitação de ativação por CNPJ / empresa americana e a
  // liberação que o cadastro com CNPJ consulta.
  // OrchestratorModule: WhopConnectService — pendência corrigida pelo seller
  // reenvia na hora os pedidos de informação da Whop ligados a ela.
  imports:     [ActivationModule, OrchestratorModule],
  controllers: [OnboardingController],
  providers:   [OnboardingService, StorageService, JwtStrategy],
  exports:     [OnboardingService],
})
export class OnboardingModule {}
