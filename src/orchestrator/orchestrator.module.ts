import { Module } from '@nestjs/common';
import { AccountRouterService } from './router/account-router.service';
import { WhopAccountsService } from './whop/whop-accounts.service';
import { WhopConnectService } from './whop/whop-connect.service';
import { WhopPlatformClient } from './whop/whop-platform.client';
import { WhopLinkedAccountsService } from './whop/whop-linked.service';
import { StripeAccountsService } from './stripe/stripe-accounts.service';
import { ClipAccountsService } from './clip/clip-accounts.service';
import { SpeiReceiptService } from './clip/spei-receipt.service';
import { StorageService } from '../lib/storage.service';
import { StripeRiskService } from './stripe/stripe-risk.service';
import { StripeEfwService } from './stripe/stripe-efw.service';
import { AffiliateRiskService } from './stripe/affiliate-risk.service';
import { CryptoModule } from '../crypto/crypto.module';

@Module({
  imports: [CryptoModule], // 🔥 precisa pra decrypt
  providers: [
    AccountRouterService,
    ClipAccountsService,
    SpeiReceiptService,
    // StorageService: o caminho fal manda a imagem por URL, e o bucket é
    // privado — precisa assinar uma URL curta antes de chamar.
    StorageService,
    WhopAccountsService,
    // Contas conectadas da Whop: o router cobra na conta do seller e o
    // WhopAccountsService resolve os ids 'whopc_…' por aqui.
    WhopPlatformClient,
    WhopConnectService,
    // Conta Whop própria do seller (modo conexão): a cobrança sai na conta dele.
    WhopLinkedAccountsService,
    StripeAccountsService,
    StripeRiskService,
    StripeEfwService,
    AffiliateRiskService,
  ],
  // WhopAccountsService e StripeAccountsService são exportados porque o
  // WebhookService precisa resolver a conta (e o segredo dela) pelo accountId
  // que vem no path do webhook.
  //
  // StripeRiskService é exportado porque o webhook alimenta o numerador das
  // taxas (recordRiskEvent) — sem isso, disputa que chega por webhook não conta
  // em lugar nenhum e a quarentena automática nunca dispara.
  exports: [
    // ClipAccountsService é exportado porque o fluxo de reserva (hold/capture/
    // release) vive fora do router: quem segura o teto é o checkout, ANTES de o
    // formulário de cartão existir, e quem captura é o webhook.
    ClipAccountsService,
    SpeiReceiptService,
    AccountRouterService,
    WhopAccountsService,
    // WhopConnectService: o CRM cria/suspende a conta conectada e o webhook das
    // contas conectadas sincroniza status e risco.
    WhopConnectService,
    // WhopLinkedAccountsService: o CRM e o painel conectam/desligam a conta
    // própria do seller, e o webhook precisa resolver os ids 'whopl_…'.
    WhopLinkedAccountsService,
    StripeAccountsService,
    StripeRiskService,
    StripeEfwService,
    AffiliateRiskService,
  ],
})
export class OrchestratorModule {}
