// src/crm/crm-checkout.controller.ts
//
// As telas do CRM que mostram o CHECKOUT: os sellers (as pessoas) e as lojas.
// Tudo só leitura — escrever no checkout continua sendo do checkout.
//
// Restrito a admin e supervisor: aqui aparece a operação inteira de cada loja
// (pedidos, equipe, domínios), não só os sellers que o gerente assumiu.

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { CrmCheckoutService } from './crm-checkout.service'
import { CrmAuthGuard, Roles } from './crm.module'

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
}
