// src/crm/crm-checkout.controller.ts
//
// As telas do CRM que mostram o CHECKOUT: os sellers (as pessoas) e as lojas.
// Leitura, mais as ações de admin abaixo (conta da loja, provedor externo,
// reenvio à Shopify). Escrever no checkout continua sendo do checkout.
//
// Restrito a admin e supervisor: aqui aparece a operação inteira de cada loja
// (pedidos, equipe, domínios), não só os sellers que o gerente assumiu.

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { CrmCheckoutService } from './crm-checkout.service'
import { CrmAuthGuard, Roles } from './crm.module'

interface CheckoutActionContext {
  managerId: string
  role: string
  ip?: string
  userAgent?: string
}

/** O CrmAuthGuard popula req.manager — mesmo contexto do crm-admin.controller. */
function ctxFromReq(req: any): CheckoutActionContext {
  const manager = req.manager
  if (!manager) throw new Error('req.manager está vazio — CrmAuthGuard não foi aplicado?')

  return {
    managerId: manager.sub,
    role: manager.role,
    ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip,
    userAgent: req.headers['user-agent'],
  }
}

/**
 * Mesma trilha das outras ações do CRM (crm_action_log). `seller_id` fica com a
 * conta de pagamento envolvida, quando existe: é por ela que a ficha do seller
 * lê o histórico. Falha de log não desfaz a ação, mas aparece no console.
 */
async function logCheckoutAction(
  ctx: CheckoutActionContext,
  action: string,
  resourceId: string,
  payload: Record<string, any>,
) {
  const { error } = await supabase.from('crm_action_log').insert({
    seller_id: payload.seller_id ?? null,
    manager_id: ctx.managerId,
    action,
    resource_type: 'checkout',
    resource_id: resourceId,
    payload,
    ip_address: ctx.ip ?? null,
    user_agent: ctx.userAgent ?? null,
    created_at: new Date(),
  })
  if (error) console.error(`[CrmCheckoutController] log ${action}:`, error.message)
}

@Controller('crm/checkout')
@UseGuards(CrmAuthGuard)
@Roles('admin', 'supervisor')
export class CrmCheckoutController {
  constructor(private readonly checkout: CrmCheckoutService) { }

  @Get('overview')
  overview() {
    return this.checkout.overview()
  }

  @Get('sellers')
  sellers(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.checkout.listSellers({ search, page, pageSize })
  }

  /** `userId` é o usuário do CHECKOUT, não o seller do pay. */
  @Get('sellers/:userId')
  seller(@Param('userId') userId: string) {
    return this.checkout.seller(userId)
  }

  // "Loja" é o nome que o CRM usa; no checkout a entidade é o workspace.
  @Get('stores')
  stores(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.checkout.listStores({ search, status, page, pageSize })
  }

  @Get('stores/:workspaceId')
  store(@Param('workspaceId') workspaceId: string) {
    return this.checkout.store(workspaceId)
  }

  // ─── Ações ─────────────────────────────────────────────────────────────────
  //
  // Escrita é só do admin: supervisor enxerga a operação, mas não a muda.

  /**
   * Conta de pagamento que a loja usa. `sellerId: null` desfaz o vínculo e faz o
   * checkout voltar a resolver pela credencial gravada na ativação.
   */
  @Post('stores/:workspaceId/payment-account')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async setStoreAccount(
    @Param('workspaceId') workspaceId: string,
    @Req() req: any,
    @Body() body: { sellerId?: string | null },
  ) {
    const ctx = ctxFromReq(req)
    const sellerId = typeof body?.sellerId === 'string' && body.sellerId.trim() ? body.sellerId.trim() : null
    const result = await this.checkout.setStoreAccount(workspaceId, sellerId, ctx)

    await logCheckoutAction(ctx, sellerId ? 'checkout.store_account_linked' : 'checkout.store_account_unlinked', workspaceId, {
      seller_id: result.sellerId,
      previous_seller_id: result.previousSellerId,
      workspace_id: workspaceId,
      store_name: result.storeName,
      account_name: result.accountName,
    })

    return result
  }

  /**
   * Libera (ou corta) o provedor externo do seller: liberado, o painel dele em
   * Koopfy Payments mostra "Conecte seu provedor externo" e ele cola a chave da
   * conta Whop dele, sem passar pelo cadastro da Koopfy.
   */
  @Post('sellers/:userId/external-provider')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async setExternalProvider(
    @Param('userId') userId: string,
    @Req() req: any,
    @Body() body: { enabled?: boolean },
  ) {
    const ctx = ctxFromReq(req)
    const enabled = body?.enabled !== false
    const result = await this.checkout.setExternalProvider(userId, enabled, ctx)

    await logCheckoutAction(ctx, enabled ? 'checkout.external_provider_allowed' : 'checkout.external_provider_disabled', userId, {
      seller_id: result.sellerIds?.[0] ?? null,
      seller_ids: result.sellerIds ?? [],
      checkout_user_id: userId,
      provisioned: result.provisioned,
    })

    return result
  }

  /** Reenvia à Shopify um pedido pago que não chegou lá. */
  @Post('orders/:orderId/shopify')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async resendToShopify(
    @Param('orderId') orderId: string,
    @Req() req: any,
    @Body() body: { workspaceId?: string },
  ) {
    const ctx = ctxFromReq(req)
    const workspaceId = String(body?.workspaceId ?? '').trim()
    const result = await this.checkout.resendOrderToShopify(orderId, workspaceId)

    await logCheckoutAction(ctx, 'checkout.order_resent_to_shopify', orderId, {
      workspace_id: workspaceId,
      order_id: orderId,
    })

    return result
  }
}
