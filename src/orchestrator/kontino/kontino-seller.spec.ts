const linhas: Record<string, { id: string; config: any }> = {}
const updates: Array<{ id: string; config: any }> = []

jest.mock('../../lib/supabase.client', () => ({
  supabase: {
    from: jest.fn(() => {
      let filtro: string | null = null
      let patch: any = null
      const q: any = {
        select: () => q,
        update: (p: any) => {
          patch = p
          return q
        },
        eq: (_c: string, v: string) => {
          filtro = v
          if (patch) {
            linhas[v] = { id: v, config: patch.config }
            updates.push({ id: v, config: patch.config })
            return Promise.resolve({ error: null })
          }
          return q
        },
        maybeSingle: () => Promise.resolve({ data: filtro && linhas[filtro] ? linhas[filtro] : null, error: null }),
      }
      return q
    }),
  },
}))

import { configComConta, contaKontinoMudou, estadoKontino, iniciarContaKontino, kontinoPelaContaDoSeller } from './kontino-seller'
import type { ContaKontino } from './kontino'

const conta = (o: Partial<ContaKontino> = {}): ContaKontino => ({
  id: 'acct_1',
  status: 'pending',
  type: 'business',
  country: 'MX',
  email: 'loja@exemplo.com',
  name: 'Loja',
  external_id: 'seller-1',
  connection_type: 'onboarding',
  capabilities: { collections: 'pending' },
  requirements: { currently_due: ['onboarding'], pending_verification: [], errors: [] },
  ...o,
})

type Resp = { status: number; body: any }
let respostas: Array<(url: string, init: any) => Resp>
const chamadas: Array<{ url: string; init: any }> = []

beforeEach(() => {
  for (const k of Object.keys(linhas)) delete linhas[k]
  updates.length = 0
  chamadas.length = 0
  respostas = []
  process.env.KONTINO_SECRET_KEY = 'sk_test_x'
  ;(global as any).fetch = jest.fn(async (url: string, init: any) => {
    chamadas.push({ url, init })
    const r = respostas.shift()?.(url, init) ?? { status: 500, body: { error: { code: 'x', message: 'sem resposta' } } }
    return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) }
  })
})

describe('conta Kontino do seller', () => {
  it('só a conta aprovada vira kontino_account_id (é o que libera a cobrança)', () => {
    const pendente = configComConta({ outra: 1 }, conta())
    expect(pendente.kontino).toMatchObject({ connection_id: 'acct_1', status: 'pending' })
    expect(pendente.kontino_account_id).toBeUndefined()
    expect(pendente.outra).toBe(1)

    const ativa = configComConta(pendente, conta({ status: 'active' }))
    expect(ativa.kontino_account_id).toBe('acct_1')

    const desligada = configComConta(ativa, conta({ status: 'disconnected' }))
    expect(desligada.kontino_account_id).toBeUndefined()
  })

  it('não apaga uma conta Kontino diferente posta pelo CRM', () => {
    const c = configComConta({ kontino_account_id: 'acct_crm' }, conta({ status: 'rejected' }))
    expect(c.kontino_account_id).toBe('acct_crm')
  })

  it('abre a conta, guarda a conexão e devolve o link', async () => {
    linhas['seller-1'] = { id: 'seller-1', config: {} }
    respostas.push(() => ({ status: 200, body: conta() }))
    respostas.push(() => ({ status: 200, body: { url: 'https://kontino.co/abrir-conta/link?t=x', expires_at: '2026-11-15T00:00:00Z', type: 'onboarding', account: 'acct_1' } }))

    const r = await iniciarContaKontino({ sellerId: 'seller-1', email: 'Loja@Exemplo.com', nome: 'Loja', tipo: 'business', pais: 'mx', retorno: 'https://app.koopfy.com/painel/pagamentos' })

    expect(r.url).toContain('kontino.co')
    expect(r.state.account).toMatchObject({ id: 'acct_1', status: 'pending', requirements: ['onboarding'] })
    expect(linhas['seller-1'].config.kontino.connection_id).toBe('acct_1')
    expect(linhas['seller-1'].config.kontino_account_id).toBeUndefined()

    const corpo = JSON.parse(chamadas[0].init.body)
    expect(chamadas[0].url).toMatch(/\/accounts$/)
    expect(corpo).toMatchObject({ email: 'loja@exemplo.com', country: 'MX', type: 'business', external_id: 'seller-1', dashboard: 'kontino' })
    expect(chamadas[0].init.headers['idempotency-key']).toBe('koopfy-seller-seller-1-MX-business')
  })

  it('retoma a conta que já existe no Kontino (409 com o id)', async () => {
    linhas['seller-1'] = { id: 'seller-1', config: {} }
    respostas.push(() => ({ status: 409, body: { error: { code: 'resource_already_exists', message: 'Já existe a conta acct_9 com external_id "seller-1".' } } }))
    respostas.push((url) => {
      expect(url).toMatch(/\/accounts\/acct_9$/)
      return { status: 200, body: conta({ id: 'acct_9', status: 'active' }) }
    })

    const r = await iniciarContaKontino({ sellerId: 'seller-1', email: 'loja@exemplo.com', tipo: 'business', pais: 'MX' })

    expect(r.url).toBeNull()
    expect(linhas['seller-1'].config.kontino_account_id).toBe('acct_9')
  })

  it('conta recusada não gera link e explica', async () => {
    linhas['seller-1'] = { id: 'seller-1', config: { kontino: { connection_id: 'acct_1' } } }
    respostas.push(() => ({ status: 200, body: conta({ status: 'rejected' }) }))
    await expect(iniciarContaKontino({ sellerId: 'seller-1', email: 'loja@exemplo.com', tipo: 'business', pais: 'MX' })).rejects.toMatchObject({ code: 'closed' })
  })

  it('erro de dado do Kontino chega ao seller; queda vira "tente de novo"', async () => {
    linhas['seller-1'] = { id: 'seller-1', config: {} }
    respostas.push(() => ({ status: 400, body: { error: { code: 'parameter_invalid', message: 'País não atendido.' } } }))
    await expect(iniciarContaKontino({ sellerId: 'seller-1', email: 'loja@exemplo.com', tipo: 'business', pais: 'KP' })).rejects.toMatchObject({ code: 'invalid', message: 'País não atendido.' })

    respostas.push(() => ({ status: 503, body: { error: { code: 'down', message: 'x' } } }))
    await expect(iniciarContaKontino({ sellerId: 'seller-1', email: 'loja@exemplo.com', tipo: 'business', pais: 'MX' })).rejects.toMatchObject({ code: 'provider' })
  })

  it('valida país, tipo e e-mail antes de chamar o Kontino', async () => {
    linhas['seller-1'] = { id: 'seller-1', config: {} }
    await expect(iniciarContaKontino({ sellerId: 'seller-1', email: 'x', tipo: 'business', pais: 'MX' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(iniciarContaKontino({ sellerId: 'seller-1', email: 'a@b.co', tipo: 'business', pais: 'Mexico' })).rejects.toMatchObject({ code: 'invalid' })
    expect(chamadas).toHaveLength(0)
  })

  it('sem chave da Kontino o painel mostra "indisponível"', async () => {
    delete process.env.KONTINO_SECRET_KEY
    expect((await estadoKontino('seller-1')).available).toBe(false)
  })

  it('o painel lê o status fresco e grava a aprovação', async () => {
    linhas['seller-1'] = { id: 'seller-1', config: { kontino: { connection_id: 'acct_1', status: 'pending' } } }
    respostas.push(() => ({ status: 200, body: conta({ status: 'active', requirements: { currently_due: [], pending_verification: [], errors: [] } }) }))
    const v = await estadoKontino('seller-1')
    expect(v.account).toMatchObject({ status: 'active', requirements: [] })
    expect(linhas['seller-1'].config.kontino_account_id).toBe('acct_1')
  })

  it('se o Kontino cair, o painel mostra o último status guardado', async () => {
    linhas['seller-1'] = { id: 'seller-1', config: { kontino: { connection_id: 'acct_1', status: 'pending', connection_type: 'onboarding', country: 'MX', type: 'business' } } }
    respostas.push(() => ({ status: 503, body: {} }))
    const v = await estadoKontino('seller-1')
    expect(v.account).toMatchObject({ id: 'acct_1', status: 'pending' })
    expect(updates).toHaveLength(0)
  })

  it('webhook grava só no seller dono da conta', async () => {
    linhas['seller-1'] = { id: 'seller-1', config: { kontino: { connection_id: 'acct_1' } } }
    respostas.push(() => ({ status: 200, body: conta({ status: 'active' }) }))
    expect(await contaKontinoMudou('acct_1')).toEqual({ ok: true })
    expect(linhas['seller-1'].config.kontino_account_id).toBe('acct_1')

    linhas['seller-1'].config = { kontino: { connection_id: 'acct_outra' } }
    respostas.push(() => ({ status: 200, body: conta({ status: 'active' }) }))
    expect(await contaKontinoMudou('acct_1')).toMatchObject({ ok: false })
  })
})

describe('Pix e SPEI pela conta Kontino do seller', () => {
  const base = {
    routedByMethod: false,
    upsell: false,
    contaKontino: 'acct_1',
    configurado: true,
    metodo: 'pix',
    moeda: 'BRL',
    metodosDoSeller: ['card', 'pix', 'spei'],
    provedorAtual: 'asaas',
  }

  it('conta ativa liga a Kontino e guarda o provedor de antes como reserva', () => {
    expect(kontinoPelaContaDoSeller(base)).toEqual({ reserva: 'asaas' })
    expect(kontinoPelaContaDoSeller({ ...base, metodo: 'spei', moeda: 'mxn', provedorAtual: 'clip' })).toEqual({ reserva: 'clip' })
    expect(kontinoPelaContaDoSeller({ ...base, provedorAtual: null })).toEqual({ reserva: null })
  })

  it('não entra quando não deve', () => {
    expect(kontinoPelaContaDoSeller({ ...base, contaKontino: undefined })).toBeNull()
    expect(kontinoPelaContaDoSeller({ ...base, routedByMethod: true })).toBeNull()
    expect(kontinoPelaContaDoSeller({ ...base, upsell: true })).toBeNull()
    expect(kontinoPelaContaDoSeller({ ...base, configurado: false })).toBeNull()
    expect(kontinoPelaContaDoSeller({ ...base, metodo: 'card' })).toBeNull()
    expect(kontinoPelaContaDoSeller({ ...base, moeda: 'USD' })).toBeNull()
    expect(kontinoPelaContaDoSeller({ ...base, metodosDoSeller: ['card'] })).toBeNull()
  })
})
