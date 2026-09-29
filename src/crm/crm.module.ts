// crm-backend/crm-auth.guard.ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Reflector } from '@nestjs/core'

@Injectable()
export class CrmAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req    = ctx.switchToHttp().getRequest()
    const header = req.headers['authorization'] ?? ''
    const token  = header.replace(/^Bearer\s+/i, '').trim()

    if (!token) throw new UnauthorizedException('Token ausente')

    try {
      const payload = this.jwtService.verify(token)
      req.manager   = payload

      // @Roles() na rota vale; sem ele, vale o @Roles() do controller.
      const roles = this.reflector.getAllAndOverride<string[]>('roles', [ctx.getHandler(), ctx.getClass()])
      if (roles?.length && !roles.includes(payload.role)) {
        throw new ForbiddenException('Permissão insuficiente')
      }

      return true
    } catch (e: any) {
      if (e instanceof ForbiddenException) throw e
      throw new UnauthorizedException('Token inválido ou expirado')
    }
  }
}

// crm-backend/crm-roles.decorator.ts
import { SetMetadata } from '@nestjs/common'
export const Roles = (...roles: string[]) => SetMetadata('roles', roles)

// crm-backend/crm.module.ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { CrmController } from './crm.controller'
import { CrmService }    from './crm.service'
import { CrmAdminController } from './crm-admin.controller'
import { CrmAdminService } from './crm-admin.service'
import { CrmCheckoutController } from './crm-checkout.controller'
import { CrmCheckoutService } from './crm-checkout.service'
import { CrmTicketsController } from './crm-tickets.controller'
import { StorageService } from '../lib/storage.service'
import { CryptoModule } from '../crypto/crypto.module'
import { OrchestratorModule } from '../orchestrator/orchestrator.module'
import { WebhookModule } from '../webhooks/webhook.module'
import { WhopConnectController, WhopRfiReviewsController } from './whop-connect.controller'
import { WhopLinkedController } from './whop-linked.controller'
import { SellerRoutingCrmController } from './seller-routing.controller'
import { ActivationRequestsController } from './activation-requests.controller'
import { ActivationModule } from '../activation/activation.module'
import { AffiliatesModule } from '../affiliates/affiliates.module'
import { AffiliateCrmController } from '../affiliates/affiliate-crm.controller'
import { crmRequestContext } from './crm-request-context'
import { PayoutModule } from '../payouts/payout.module'
import { KoopfyIntegrationModule } from '../integration/koopfy-integration.module'

@Module({
  imports: [
    // Sem segredo padrão: sem CRM_JWT_SECRET o login do CRM recusa e nenhum
    // token é aceito (antes caía numa senha fixa conhecida).
    JwtModule.registerAsync({
      useFactory: () => {
        if (!process.env.CRM_JWT_SECRET) {
          console.error('[CrmModule] CRM_JWT_SECRET não definido: login do CRM desativado.')
        }
        return { secret: process.env.CRM_JWT_SECRET, signOptions: { expiresIn: '8h' } }
      },
    }),
    // CryptoModule: cifra api_key/webhook_secret das contas Whop em repouso.
    // OrchestratorModule: WhopAccountsService, pra invalidar o cache do pool na
    // hora que uma conta é pausada (senão o TTL de 30s manda pagamento pra uma
    // conta que o gestor acabou de tirar do ar).
    CryptoModule,
    OrchestratorModule,
    // WebhookModule: aprovar um comprovante à mão precisa rodar o MESMO pipeline
    // de PAID que um pagamento normal (carteira, KPI, postback). Marcar o status
    // direto deixaria o pedido pago no CRM e pendente em todo o resto.
    WebhookModule,
    // ActivationModule: fila de solicitações de ativação (CNPJ / LLC).
    ActivationModule,
    // AffiliatesModule: o AffiliateCrmService vem de lá; o controller fica aqui
    // porque o CrmAuthGuard precisa do JwtModule registrado neste módulo.
    AffiliatesModule,
    PayoutModule,
    // KoopfyIntegrationModule: provedor externo liberado para quem ainda não
    // tem conta de pagamento cria a conta principal (provision).
    KoopfyIntegrationModule,
  ],
  // WhopConnectController: conta conectada da Whop por seller (serviço vem do
  // OrchestratorModule).
  // CrmCheckoutController: sellers e lojas do checkout (só leitura, via canal
  // interno).
  controllers: [CrmController, CrmAdminController, CrmCheckoutController, CrmTicketsController, WhopConnectController, WhopRfiReviewsController, WhopLinkedController, SellerRoutingCrmController, ActivationRequestsController, AffiliateCrmController],
  providers:   [CrmService, CrmAdminService, CrmCheckoutService, CrmAuthGuard, StorageService],
  exports:     [CrmService, CrmAdminService, CrmCheckoutService],
})
export class CrmModule implements NestModule {
  // IP e navegador de cada requisição do CRM, para o log de ações.
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(crmRequestContext).forRoutes(CrmController, CrmAdminController, CrmCheckoutController)
  }
}
