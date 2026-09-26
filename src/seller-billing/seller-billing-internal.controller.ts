import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common'
import { SellerBillingService } from './seller-billing.service'

/** Mesmo segredo do canal pay ↔ checkout (x-internal-key). */
function assertInternalKey(key: string) {
  const expected = process.env.INTERNAL_API_KEY || process.env.CHECKOUT_INTERNAL_KEY
  if (!expected) throw new UnauthorizedException('CHECKOUT_INTERNAL_KEY não configurada no pay.')
  if (!key || key !== expected) throw new UnauthorizedException('Chave interna inválida.')
}

function requiredText(value: unknown, field: string, max = 200): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new BadRequestException(`${field} inválido.`)
  return text
}

/**
 * Cobrança das comissões da Koopfy no cartão do seller. Só o checkout chama:
 * ele é o dono do débito e do painel onde o seller cadastra o cartão.
 */
@Controller('internal/seller-billing')
export class SellerBillingInternalController {
  constructor(private readonly billing: SellerBillingService) {}

  @Post('setup')
  @HttpCode(HttpStatus.OK)
  setup(@Headers('x-internal-key') key: string, @Body() body: any) {
    assertInternalKey(key)
    const returnUrl = requiredText(body?.returnUrl, 'returnUrl', 2000)
    if (!/^https?:\/\//i.test(returnUrl)) throw new BadRequestException('returnUrl inválido.')
    return this.billing.startSetup({
      workspaceId: requiredText(body?.workspaceId, 'workspaceId'),
      email: typeof body?.email === 'string' ? body.email.trim().slice(0, 320) : null,
      returnUrl,
    })
  }

  @Get('method/:workspaceId')
  method(@Headers('x-internal-key') key: string, @Param('workspaceId') workspaceId: string) {
    assertInternalKey(key)
    return this.billing.getMethod(requiredText(workspaceId, 'workspaceId'))
  }

  @Post('charges')
  @HttpCode(HttpStatus.OK)
  charge(@Headers('x-internal-key') key: string, @Body() body: any) {
    assertInternalKey(key)
    const amountMinor = Number(body?.amountMinor)
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new BadRequestException('amountMinor inválido.')
    const currency = requiredText(body?.currency, 'currency', 3)
    if (!/^[a-z]{3}$/i.test(currency)) throw new BadRequestException('currency inválida.')
    return this.billing.charge({
      workspaceId: requiredText(body?.workspaceId, 'workspaceId'),
      chargeRef: requiredText(body?.chargeRef, 'chargeRef', 120),
      amountMinor,
      currency,
    })
  }

  @Get('charges/:chargeRef')
  async getCharge(@Headers('x-internal-key') key: string, @Param('chargeRef') chargeRef: string) {
    assertInternalKey(key)
    const charge = await this.billing.getCharge(requiredText(chargeRef, 'chargeRef', 120))
    if (!charge) throw new NotFoundException('Cobrança não encontrada.')
    return charge
  }
}
