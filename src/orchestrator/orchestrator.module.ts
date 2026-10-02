import { Module } from '@nestjs/common';
import { AccountRouterService } from './router/account-router.service';
import { WhopAccountsService } from './whop/whop-accounts.service';
import { WhopConnectService } from './whop/whop-connect.service';
import { WhopPlatformClient } from './whop/whop-platform.client';
import { WhopConnectedPayoutService } from './whop/whop-connected-payout.service';
import { WhopPayoutDestinationsService } from './whop/whop-payout-destinations.service';
import { WhopLinkedAccountsService } from './whop/whop-linked.service';
import { StripeAccountsService } from './stripe/stripe-accounts.service';
import { ClipAccountsService } from './clip/clip-accounts.service';
import { SpeiReceiptService } from './clip/spei-receipt.service';
import { StorageService } from '../lib/storage.service';
import { StripeRiskService } from './stripe/stripe-risk.service';
import { StripeEfwService } from './stripe/stripe-efw.service';
import { AffiliateRiskService } from './stripe/affiliate-risk.service';
import { CryptoModule } from '../crypto/crypto.module';
import { SellerProviderAccountsService } from './seller-provider/seller-provider-accounts.service';
import { SellerRoutingService } from './routing/seller-routing.service';
import { OwnAccountFinanceService } from './own-finance/own-account-finance.service';
import { OwnPaymentDomainsService } from './own-finance/own-payment-domains.service';
import { OwnAccountPermissionsService } from './own-finance/own-account-permissions.service';

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
    // Saque aprovado de seller conectado: master → conta conectada → banco.
    WhopConnectedPayoutService,
    // Conta bancária do saque (salva ou informada no pedido).
    WhopPayoutDestinationsService,
    // Conta Whop própria do seller (modo conexão): a cobrança sai na conta dele.
    WhopLinkedAccountsService,
    // Stripe e PayPal próprios do seller (provedor externo).
    SellerProviderAccountsService,
    // Roteamento de contas próprias (várias Whop/Stripe/PayPal por seller).
    SellerRoutingService,
    // Financeiro das contas próprias: saldo, saque e histórico por conta.
    OwnAccountFinanceService,
    OwnPaymentDomainsService,
    OwnAccountPermissionsService,
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
    // WhopConnectedPayoutService: aprovar saque no CRM enfileira a execução.
    WhopConnectedPayoutService,
    // WhopPayoutDestinationsService: o painel e o dash-checkout pedem saque
    // informando a conta bancária da Whop.
    WhopPayoutDestinationsService,
    // WhopLinkedAccountsService: o CRM e o painel conectam/desligam a conta
    // própria do seller, e o webhook precisa resolver os ids 'whopl_…'.
    WhopLinkedAccountsService,
    // WhopPlatformClient: domínios de pagamento (Apple Pay) das contas da loja.
    WhopPlatformClient,
    // SellerProviderAccountsService: o painel conecta/desliga Stripe e PayPal
    // próprios, e o webhook resolve os ids 'stripel_…'/'paypall_…'.
    SellerProviderAccountsService,
    // SellerRoutingService: o pagamento escolhe a conta da sessão, o painel e
    // o CRM configuram o roteamento.
    SellerRoutingService,
    // OwnAccountFinanceService: o painel lê saldo e pede saque de cada conta.
    OwnAccountFinanceService,
    // OwnPaymentDomainsService: domínio do checkout na conta dele (Apple Pay / Google Pay).
    OwnPaymentDomainsService,
    // OwnAccountPermissionsService: o que a chave dele consegue fazer além de vender.
    OwnAccountPermissionsService,
    StripeAccountsService,
    StripeRiskService,
    StripeEfwService,
    AffiliateRiskService,
  ],
})
export class OrchestratorModule {}
