// Falha de uma tentativa anterior da mesma transação não pode derrubar a
// tentativa nova (o comprador já está pagando com outro cartão).

let current: string | null = null
jest.mock('../lib/supabase.client', () => ({
  supabase: {
    from: () => {
      const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { provider_transaction_id: current } }) }
      return q
    },
  },
}))

import { WebhookService } from './webhook.service'

const stale = (paymentId: string) =>
  (Object.create(WebhookService.prototype) as any).isStaleWhopAttempt('tx-1', { id: paymentId })

describe('isStaleWhopAttempt', () => {
  it('ignores the failure of a payment the transaction no longer points to', async () => {
    current = 'pay_new'
    await expect(stale('pay_old')).resolves.toBe(true)
  })

  it('applies the failure of the current payment', async () => {
    current = 'pay_new'
    await expect(stale('pay_new')).resolves.toBe(false)
  })

  it('applies it when the transaction has no Whop payment yet', async () => {
    current = null
    await expect(stale('pay_old')).resolves.toBe(false)
  })
})
