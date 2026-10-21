// Contas por link pelo canal interno: o backend do checkout registra a loja
// Shopify / Digistore24 com o seller vinculado quando a loja ainda não tem a
// sk_live_. Mesmo segredo das outras rotas internas.

const sellers: Record<string, any> = { 'seller-1': { id: 'seller-1' } }
jest.mock('../lib/supabase.client', () => ({
  supabase: {
    from: () => {
      let id = ''
      const builder: any = {
        select: () => builder,
        eq: (_c: string, value: string) => { id = value; return builder },
        maybeSingle: async () => ({ data: sellers[id] ?? null, error: null }),
      }
      return builder
    },
  },
}))
jest.mock('../orchestrator/routing/seller-routing.service', () => ({ SellerRoutingService: class {} }))

import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { LinkAccountsInternalController } from './link-accounts-internal.controller'

describe('LinkAccountsInternalController', () => {
  let routing: any
  let controller: LinkAccountsInternalController
  beforeEach(() => {
    process.env.INTERNAL_API_KEY = 'internal-x'
    routing = {
      registerLinkAccount: jest.fn(async () => ({ id: 'shopifyp_1', created: true })),
      disableLinkAccount: jest.fn(async () => ({ ok: true })),
      selectExternalForLinkConnect: jest.fn(async () => ({ ok: true, mode: 'external', changed: true })),
      recordLinkSale: jest.fn(async () => ({ ok: true, accountId: 'shopifyp_1' })),
    }
    controller = new LinkAccountsInternalController(routing)
  })
  afterAll(() => { delete process.env.INTERNAL_API_KEY })

  it('registra a conta no seller do corpo, sem repassar o sellerId', async () => {
    const body = { sellerId: 'seller-1', provider: 'shopify', externalRef: 'shop-1', name: 'Loja' }
    expect(await controller.register('internal-x', body)).toEqual({ id: 'shopifyp_1', created: true })
    expect(routing.registerLinkAccount).toHaveBeenCalledWith('seller-1', { provider: 'shopify', externalRef: 'shop-1', name: 'Loja' })
  })

  it('desligar, conectar e venda vão para o mesmo seller', async () => {
    await controller.disable('internal-x', { sellerId: 'seller-1', provider: 'digistore24', externalRef: 'acc-1' })
    await controller.connected('internal-x', { sellerId: 'seller-1', provider: 'digistore24' })
    await controller.sale('internal-x', { sellerId: 'seller-1', provider: 'shopify', externalRef: 'shop-1', saleRef: 'o1' })
    expect(routing.disableLinkAccount).toHaveBeenCalledWith('seller-1', { provider: 'digistore24', externalRef: 'acc-1' })
    expect(routing.selectExternalForLinkConnect).toHaveBeenCalledWith('seller-1', { provider: 'digistore24' })
    expect(routing.recordLinkSale).toHaveBeenCalledWith('seller-1', { provider: 'shopify', externalRef: 'shop-1', saleRef: 'o1' })
  })

  it('recusa sem a chave interna, com chave errada ou sem chave configurada', async () => {
    await expect(controller.register('', { sellerId: 'seller-1' })).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(controller.register('outra', { sellerId: 'seller-1' })).rejects.toBeInstanceOf(UnauthorizedException)
    delete process.env.INTERNAL_API_KEY
    await expect(controller.register('internal-x', { sellerId: 'seller-1' })).rejects.toBeInstanceOf(UnauthorizedException)
    expect(routing.registerLinkAccount).not.toHaveBeenCalled()
  })

  it('seller ausente, inválido ou desconhecido não chega no roteamento', async () => {
    await expect(controller.register('internal-x', {})).rejects.toBeInstanceOf(BadRequestException)
    await expect(controller.register('internal-x', { sellerId: 'a b' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(controller.sale('internal-x', { sellerId: 'seller-404' })).rejects.toBeInstanceOf(NotFoundException)
    expect(routing.registerLinkAccount).not.toHaveBeenCalled()
    expect(routing.recordLinkSale).not.toHaveBeenCalled()
  })
})
