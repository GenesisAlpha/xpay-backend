import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common'
import { checkoutFeeOfOwner, parseCheckoutFeePct, writePlanCheckoutFee } from './checkout-fee'

/** Mesmo segredo do canal pay ↔ checkout (x-internal-key). */
function assertInternalKey(key: string) {
  const expected = process.env.INTERNAL_API_KEY || process.env.CHECKOUT_INTERNAL_KEY
  if (!expected) throw new UnauthorizedException('CHECKOUT_INTERNAL_KEY não configurada no pay.')
  if (!key || key !== expected) throw new UnauthorizedException('Chave interna inválida.')
}

function requiredEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!email || email.length > 320 || !email.includes('@')) throw new BadRequestException('email inválido.')
  return email
}

/**
 * Taxa de checkout do seller. O checkout é quem sabe o plano da conta: ele
 * grava o padrão do plano quando a troca vale, e lê a taxa para as vendas
 * que não passam pelo pay. A conta é a do dono do e-mail (o mesmo elo do
 * login unificado).
 */
@Controller('internal/sellers/checkout-fee')
export class CheckoutFeeInternalController {
  @Get()
  async get(@Headers('x-internal-key') key: string, @Query('email') email: string) {
    assertInternalKey(key)
    const fee = await checkoutFeeOfOwner(requiredEmail(email))
    if (!fee) throw new NotFoundException('Seller não encontrado.')
    return fee
  }

  @Put()
  put(@Headers('x-internal-key') key: string, @Body() body: any) {
    assertInternalKey(key)
    if (body?.source !== 'plan') throw new BadRequestException("source: só 'plan' (o CRM grava pela ficha do seller).")
    const effectiveAt = typeof body?.effectiveAt === 'string' && Number.isFinite(Date.parse(body.effectiveAt))
      ? new Date(body.effectiveAt).toISOString()
      : new Date().toISOString()
    return writePlanCheckoutFee({ email: requiredEmail(body?.email), pct: parseCheckoutFeePct(body?.pct), effectiveAt })
  }
}
