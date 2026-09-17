import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common'
import { AffiliateCommissionService } from './affiliate-commission.service'
import { AffiliateCrmService } from './affiliate-crm.service'

/**
 * Mesmo segredo do canal pay → checkout (CHECKOUT_INTERNAL_KEY aqui,
 * INTERNAL_API_KEY lá), já configurado nos dois lados. INTERNAL_API_KEY
 * continua aceito para quem preferir um segredo só deste sentido.
 */
function assertInternalKey(key: string) {
  const expected = process.env.INTERNAL_API_KEY || process.env.CHECKOUT_INTERNAL_KEY
  if (!expected) throw new UnauthorizedException('CHECKOUT_INTERNAL_KEY não configurada no pay.')
  if (!key || key !== expected) throw new UnauthorizedException('Chave interna inválida.')
}

interface ReferralInput {
  sellerId?: string
  affiliateSellerId?: string
  affiliateId?: string
  affiliateCode?: string
  commissionRatePct?: number
  expiresAt?: string
}

/**
 * Canal interno que o checkout chama para dizer de quem é o seller.
 *
 * Os dois serviços têm bancos separados, então a identidade do afiliado não é
 * legível daqui. O checkout resolve e empurra o vínculo já pronto, uma vez, na
 * ativação do pagamento — nada disso está no caminho da transação.
 */
@Controller('internal/affiliates')
export class AffiliatesInternalController {
  constructor(
    private readonly commissions: AffiliateCommissionService,
    private readonly accounts: AffiliateCrmService,
  ) {}

  @Post('referral')
  @HttpCode(HttpStatus.OK)
  async referral(@Headers('x-internal-key') key: string, @Body() body: ReferralInput) {
    assertInternalKey(key)

    const sellerId = body?.sellerId?.trim()
    const affiliateSellerId = body?.affiliateSellerId?.trim()
    const expiresAt = body?.expiresAt

    if (!sellerId || !affiliateSellerId || !expiresAt) {
      throw new BadRequestException('sellerId, affiliateSellerId e expiresAt são obrigatórios.')
    }

    const rate = Number(body?.commissionRatePct ?? 20)
    if (!Number.isFinite(rate) || rate <= 0 || rate >= 100) {
      throw new BadRequestException('commissionRatePct deve estar entre 0 e 100.')
    }

    return this.commissions.upsertReferral({
      sellerId,
      affiliateSellerId,
      affiliateId: body?.affiliateId ?? null,
      affiliateCode: body?.affiliateCode ?? null,
      commissionRatePct: rate,
      expiresAt,
    })
  }

  /**
   * O afiliado ativado pelo CRM antes de ter Koopfy Payments acabou de ativar.
   * O checkout avisa para a conta entrar na lista do CRM — a partir daqui ela é
   * administrada como qualquer outra.
   */
  @Post('account')
  @HttpCode(HttpStatus.OK)
  async account(@Headers('x-internal-key') key: string, @Body() body: any) {
    assertInternalKey(key)

    const sellerId = String(body?.sellerId ?? '').trim()
    if (!sellerId) throw new BadRequestException('sellerId é obrigatório.')

    return this.accounts.upsertFromCheckout({
      sellerId,
      affiliateId: body?.affiliateId ?? null,
      code: body?.code ?? null,
      link: body?.link ?? null,
      status: body?.status === 'inactive' ? 'inactive' : 'active',
      commissionRatePct: Number(body?.commissionRatePct ?? 20),
    })
  }
}
