import { BadRequestException, Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { PaymentService } from './payments.service'

/**
 * Política de Uso Aceitável (Kaja Payments): produto removido por violação tem
 * as assinaturas canceladas, sem novas cobranças. O checkout chama com as
 * transações das vendas do produto; usa o mesmo cancelamento da área do cliente
 * (fim do período na Whop). Canal interno x-internal-key.
 */
function assertInternalKey(key: string) {
  const expected = process.env.INTERNAL_API_KEY || process.env.CHECKOUT_INTERNAL_KEY
  if (!expected) throw new UnauthorizedException('CHECKOUT_INTERNAL_KEY não configurada no pay.')
  if (!key || key !== expected) throw new UnauthorizedException('Chave interna inválida.')
}

@Controller('internal/compliance')
export class ComplianceSubscriptionsController {
  constructor(private readonly payments: PaymentService) {}

  @Post('subscriptions/cancel')
  @HttpCode(200)
  async cancel(@Headers('x-internal-key') key: string, @Body() body: { transactionIds?: string[] }) {
    assertInternalKey(key)
    const ids = [...new Set((body?.transactionIds ?? []).map(String).filter(Boolean))].slice(0, 500)
    if (!ids.length) throw new BadRequestException('transactionIds é obrigatório.')

    const { data: txs } = await supabase.from('transactions').select('id, seller_id').in('id', ids)
    const results: Array<{ transactionId: string; status: 'cancelled' | 'not_subscription' | 'manual'; message?: string }> = []
    for (const id of ids) {
      const tx = (txs ?? []).find((t: any) => t.id === id)
      if (!tx) { results.push({ transactionId: id, status: 'manual', message: 'Transação não encontrada.' }); continue }
      try {
        const r: any = await this.payments.cancelCustomerSubscription(tx.seller_id, id)
        results.push({ transactionId: id, status: r?.subscription ? 'cancelled' : 'not_subscription' })
      } catch (err: any) {
        const code = err?.response?.code ?? err?.getResponse?.()?.code
        results.push({
          transactionId: id,
          status: code === 'SUBSCRIPTION_NOT_FOUND' ? 'not_subscription' : 'manual',
          message: err?.response?.message ?? err?.message,
        })
      }
    }
    return { results }
  }
}
