import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common'
import { WhopCardBackfillService } from './whop-card-backfill.service'

/** Mesmo segredo do canal pay ↔ checkout (x-internal-key). */
function assertInternalKey(key: string) {
  const expected = process.env.INTERNAL_API_KEY || process.env.CHECKOUT_INTERNAL_KEY
  if (!expected) throw new UnauthorizedException('CHECKOUT_INTERNAL_KEY não configurada no pay.')
  if (!key || key !== expected) throw new UnauthorizedException('Chave interna inválida.')
}

/**
 * Corrige a bandeira das compras Whop antigas. Roda em lotes: repita enquanto
 * `more` for true. Ex.:
 *   curl -X POST $PAY/internal/whop/backfill-card -H "x-internal-key: $KEY" \
 *        -H 'Content-Type: application/json' -d '{"limit":200}'
 */
@Controller('internal/whop')
export class WhopCardBackfillController {
  constructor(private readonly backfill: WhopCardBackfillService) {}

  @Post('backfill-card')
  @HttpCode(200)
  run(@Headers('x-internal-key') key: string, @Body() body: { limit?: number; sinceDays?: number }) {
    assertInternalKey(key)
    return this.backfill.run(body ?? {})
  }
}
