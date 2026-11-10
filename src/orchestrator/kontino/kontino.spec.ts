import { createHmac } from 'node:crypto'
import { assinaturaKontinoValida, criarCobranca, ehMetodoKontino, respostaAoCheckout, type CobrancaKontino } from './kontino'

const assinar = (segredo: string, corpo: string, t: number) => `t=${t},v1=${createHmac('sha256', segredo).update(`${t}.${corpo}`).digest('hex')}`

describe('Kontino Connect na Koopfy', () => {
  const corpo = JSON.stringify({ id: 'evt_1', type: 'collection.paid', data: { object: { id: 'col_1' } } })
  const agora = 1_794_300_000_000
  const t = Math.floor(agora / 1000)

  it('aceita só assinatura válida e recente', () => {
    expect(assinaturaKontinoValida('whsec_x', corpo, assinar('whsec_x', corpo, t), 300, agora)).toBe(true)
    expect(assinaturaKontinoValida('whsec_y', corpo, assinar('whsec_x', corpo, t), 300, agora)).toBe(false)
    expect(assinaturaKontinoValida('whsec_x', corpo + ' ', assinar('whsec_x', corpo, t), 300, agora)).toBe(false)
    expect(assinaturaKontinoValida('whsec_x', corpo, assinar('whsec_x', corpo, t - 600), 300, agora)).toBe(false)
    expect(assinaturaKontinoValida('whsec_x', corpo, undefined, 300, agora)).toBe(false)
  })

  it('só SPEI e Pix passam pelo Kontino', () => {
    expect(ehMetodoKontino('spei')).toBe(true)
    expect(ehMetodoKontino('pix')).toBe(true)
    expect(ehMetodoKontino('card')).toBe(false)
  })

  const base: CobrancaKontino = {
    id: 'col_9',
    status: 'pending',
    method: 'spei',
    amount: 186500,
    currency: 'MXN',
    reference: 'KT12345',
    instructions: { type: 'clabe', clabe: '646180157000000004', reference: 'KT12345' },
    expires_at: '2026-11-10T15:30:00.000Z',
  }

  it('SPEI volta no formato do checkout, automático e com a CLABE exclusiva', () => {
    const r: any = respostaAoCheckout('tx_1', base, 186500)
    expect(r).toMatchObject({ success: true, status: 'pending', transactionId: 'tx_1', provider: 'kontino' })
    expect(r.spei).toMatchObject({ reservationId: 'col_9', clabe: '646180157000000004', chargeMinor: 186500, automatico: true })
  })

  it('Pix volta com o copia e cola', () => {
    const r: any = respostaAoCheckout('tx_2', { ...base, method: 'pix', currency: 'BRL', instructions: { type: 'pix', copy_paste: '000201…6304ABCD' } }, 5000)
    expect(r.pix).toEqual({ copyPaste: '000201…6304ABCD', qrcode: null, expiration: base.expires_at })
  })

  it('cria a cobrança com idempotência pela transação e dados limpos', async () => {
    process.env.KONTINO_SECRET_KEY = 'sk_test_abc'
    process.env.KONTINO_API_URL = 'https://api.exemplo/v1/'
    const chamadas: any[] = []
    const original = global.fetch
    global.fetch = jest.fn(async (url: any, init: any) => {
      chamadas.push({ url, init })
      return new Response(JSON.stringify(base), { status: 201 })
    }) as any
    try {
      await criarCobranca({
        transactionId: 'tx_42',
        metodo: 'spei',
        valorMinor: 186500,
        moeda: 'mxn',
        referencia: '#PED 1001',
        comprador: { nome: 'Ana', email: 'nao-e-email', documento: 'N/A' },
      })
    } finally {
      global.fetch = original
    }
    expect(chamadas[0].url).toBe('https://api.exemplo/v1/collections')
    expect(chamadas[0].init.headers['idempotency-key']).toBe('koopfy-tx_42')
    expect(chamadas[0].init.headers.authorization).toBe('Bearer sk_test_abc')
    expect(JSON.parse(chamadas[0].init.body)).toEqual({
      amount: 186500,
      currency: 'MXN',
      method: 'spei',
      reference: 'PED1001',
      payer: { name: 'Ana' },
      metadata: { koopfy_transaction_id: 'tx_42' },
    })
  })
})
