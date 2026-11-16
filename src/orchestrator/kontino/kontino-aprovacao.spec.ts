// Banco em memória: só o que a abertura usa de seller_profiles.
const tabela: Record<string, any> = {}

jest.mock('../../lib/supabase.client', () => {
  const pega = (obj: any, caminho: string) => {
    // "config->cadastro_kontino->>etapa" | "config->>cadastro_chave"
    const partes = caminho.split(/->>?/)
    return partes.reduce((o, p) => (o == null ? undefined : o[p]), obj)
  }
  return {
    supabase: {
      from: jest.fn(() => {
        const filtros: Array<(r: any) => boolean> = []
        let patch: any = null
        const linhas = () => Object.values(tabela).filter((r) => filtros.every((f) => f(r)))
        const q: any = {
          select: () => q,
          update: (p: any) => {
            patch = p
            return q
          },
          eq: (c: string, v: any) => {
            filtros.push((r) => pega(r, c) === v)
            return q
          },
          neq: (c: string, v: any) => {
            filtros.push((r) => pega(r, c) !== v)
            return q
          },
          in: (c: string, vs: any[]) => {
            filtros.push((r) => vs.includes(pega(r, c)))
            return q
          },
          limit: () => q,
          maybeSingle: () => Promise.resolve({ data: linhas()[0] ? structuredClone(linhas()[0]) : null, error: null }),
          then: (ok: any, falha: any) => {
            if (patch) {
              for (const r of linhas()) Object.assign(tabela[r.id], structuredClone(patch))
              return Promise.resolve({ error: null }).then(ok, falha)
            }
            return Promise.resolve({ data: structuredClone(linhas()), error: null }).then(ok, falha)
          },
        }
        return q
      }),
    },
  }
})

import { abrirKontinoAposAprovacao, aberturasPendentes, repasseRetido } from './kontino-aprovacao'
import { validarEnvio } from '../../onboarding/cadastro-v2'

const envio = (userId: string, cnpj = '12.345.678/0001-90') =>
  validarEnvio(
    {
      type: 'business',
      country: 'BR',
      business: {
        legal_name: 'Loja Exemplo LTDA', formation_date: '2020-05-01', tax_id: cnpj, website: 'https://loja.exemplo',
        phone_number: '+5511999998888', address_line_1: 'Av. Paulista, 1000', city: 'São Paulo', state_province_region: 'SP',
        postal_code: '01310-100', business_type: 'llc', business_description: 'Venda de roupas fitness online.',
        incorporation_doc_file: `${userId}/cadastro-contrato.pdf`, proof_of_ownership_doc_file: `${userId}/cadastro-cartao.pdf`,
        proof_of_address_doc_type: 'UTILITY_BILL', proof_of_address_doc_file: `${userId}/cadastro-endereco.pdf`,
        owners: [{
          role: 'beneficial_controlling', first_name: 'Ana', last_name: 'Souza', date_of_birth: '1990-01-02', tax_id: '12345678909',
          address_line_1: 'Rua A, 10', city: 'São Paulo', state_province_region: 'SP', postal_code: '01000-000', country: 'BR',
          id_doc_country: 'BR', id_doc_type: 'PASSPORT', id_doc_front_file: `${userId}/cadastro-passaporte.pdf`,
          proof_of_address_doc_type: 'UTILITY_BILL', proof_of_address_doc_file: `${userId}/cadastro-luz.pdf`,
        }],
      },
      operation: { description: 'Roupas fitness femininas.', category: 'moda', channels: ['lynea'], offers: [{ name: 'L', url: 'https://loja.exemplo/l' }] },
      terms: { koopfy: true, kontino: true, aup: true },
    },
    userId,
  )

const sellerV2 = (id: string, o: Record<string, any> = {}, config: Record<string, any> = {}) => {
  tabela[id] = {
    id,
    user_id: `u-${id}`,
    email: `${id}@exemplo.com`,
    name: 'Loja',
    status: 'active',
    config: {
      cadastro: { version: 2, submitted_at: '2026-11-16T10:00:00.000Z', envio: envio(`u-${id}`), aceite: { accepted_at: '2026-11-16T10:00:00.000Z', ip_address: '200.1.2.3', user_agent: 'Mozilla' } },
      cadastro_chave: 'BR:12345678000190',
      ...config,
    },
    ...o,
  }
}

const conta = (o: Record<string, any> = {}) => ({
  id: 'acct_1', status: 'pending', type: 'business', country: 'BR', email: 's1@exemplo.com', name: 'Loja',
  external_id: 's1', connection_type: 'onboarding', existing_company: null,
  requirements: { currently_due: ['verification'], pending_verification: [], errors: [] },
  ...o,
})

type Resp = { status: number; body: any }
let respostas: Array<(url: string, init: any) => Resp>
const chamadas: Array<{ url: string; metodo: string; corpo: any }> = []
const storage = { getSignedDocumentUrl: jest.fn(async (p: string) => `https://storage.exemplo/${p}?token=t`) }

beforeEach(() => {
  for (const k of Object.keys(tabela)) delete tabela[k]
  chamadas.length = 0
  respostas = []
  process.env.KONTINO_SECRET_KEY = 'sk_test_x'
  ;(global as any).fetch = jest.fn(async (url: string, init: any) => {
    chamadas.push({ url, metodo: init?.method, corpo: init?.body ? JSON.parse(init.body) : null })
    const r = respostas.shift()?.(url, init) ?? { status: 500, body: { error: { code: 'x', message: 'sem resposta' } } }
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) }
  })
})

const agora = new Date('2026-11-16T12:00:00.000Z')

describe('abrirKontinoAposAprovacao', () => {
  it('conta nova: cria com o documento e envia o cadastro com URLs temporárias e o aceite', async () => {
    sellerV2('s1')
    respostas.push(() => ({ status: 200, body: conta() }))
    respostas.push(() => ({ status: 200, body: conta({ requirements: { currently_due: [], pending_verification: ['business'], errors: [] } }) }))

    const r = await abrirKontinoAposAprovacao('s1', { storage, agora })

    expect(r.andamento?.etapa).toBe('pronto')
    expect(chamadas[0].url).toMatch(/\/accounts$/)
    expect(chamadas[0].corpo).toMatchObject({ type: 'business', country: 'BR', tax_id: '12.345.678/0001-90', external_id: 's1' })
    expect(chamadas[1].url).toMatch(/\/accounts\/acct_1\/verification$/)
    const v = chamadas[1].corpo
    expect(v.tos).toEqual({ accepted_at: '2026-11-16T10:00:00.000Z', ip_address: '200.1.2.3', user_agent: 'Mozilla' })
    expect(v.business.country).toBe('BR')
    expect(v.business.incorporation_doc_file).toBe('https://storage.exemplo/u-s1/cadastro-contrato.pdf?token=t')
    expect(v.business.owners[0].id_doc_front_file).toBe('https://storage.exemplo/u-s1/cadastro-passaporte.pdf?token=t')
    expect(tabela.s1.config.kontino.connection_id).toBe('acct_1')
    expect(tabela.s1.config.kontino_account_id).toBeUndefined()
  })

  it('empresa que já tem Kontino: só conecta, sem enviar cadastro', async () => {
    sellerV2('s1')
    respostas.push(() => ({ status: 200, body: conta({ connection_type: 'connect_existing', existing_company: { status: 'active' }, requirements: { currently_due: ['connection'], pending_verification: [], errors: [] } }) }))
    const r = await abrirKontinoAposAprovacao('s1', { storage, agora })
    expect(r.andamento?.etapa).toBe('pronto')
    expect(chamadas).toHaveLength(1)
  })

  it('empresa recusada na Kontino: caso com a equipe', async () => {
    sellerV2('s1')
    respostas.push(() => ({ status: 200, body: conta({ connection_type: 'connect_existing', existing_company: { status: 'rejected' } }) }))
    const r = await abrirKontinoAposAprovacao('s1', { storage, agora })
    expect(r.andamento).toMatchObject({ etapa: 'equipe', motivo: 'empresa_rejected_na_kontino' })
  })

  it('empresa já conectada à Koopfy (409): reaproveita a conexão', async () => {
    sellerV2('s1')
    respostas.push(() => ({ status: 409, body: { error: { code: 'company_already_connected', message: 'já conectada', existing_account: 'acct_9' } } }))
    respostas.push(() => ({ status: 200, body: conta({ id: 'acct_9', status: 'active', external_id: 's0', requirements: { currently_due: [] } }) }))
    const r = await abrirKontinoAposAprovacao('s1', { storage, agora })
    expect(r.andamento?.etapa).toBe('pronto')
    expect(chamadas[1].url).toMatch(/\/accounts\/acct_9$/)
    expect(tabela.s1.config.kontino_account_id).toBe('acct_9')
  })

  it('outro seller da mesma empresa já tem conexão: não cria outra', async () => {
    sellerV2('s0', {}, { kontino: { connection_id: 'acct_9', status: 'active' } })
    sellerV2('s1')
    respostas.push(() => ({ status: 200, body: conta({ id: 'acct_9', status: 'active', external_id: 's0', requirements: { currently_due: [] } }) }))
    const r = await abrirKontinoAposAprovacao('s1', { storage, agora })
    expect(r.andamento?.etapa).toBe('pronto')
    expect(chamadas.map((c) => c.metodo)).toEqual(['GET'])
    expect(tabela.s1.config.kontino_account_id).toBe('acct_9')
  })

  it('Kontino fora do ar: agenda nova tentativa', async () => {
    sellerV2('s1')
    respostas.push(() => ({ status: 503, body: { error: { code: 'unavailable', message: 'fora' } } }))
    const r = await abrirKontinoAposAprovacao('s1', { storage, agora })
    expect(r.andamento).toMatchObject({ etapa: 'erro', tentativas: 1, proxima_tentativa: '2026-11-16T12:05:00.000Z' })
    expect(await aberturasPendentes(agora)).toEqual([])
    expect(await aberturasPendentes(new Date('2026-11-16T12:06:00.000Z'))).toEqual(['s1'])
  })

  it('dado recusado (4xx): caso com a equipe, sem nova tentativa', async () => {
    sellerV2('s1')
    respostas.push(() => ({ status: 200, body: conta() }))
    respostas.push(() => ({ status: 400, body: { error: { code: 'invalid_file', message: 'arquivo ilegível', param: 'owners.0.id_doc_front_file' } } }))
    const r = await abrirKontinoAposAprovacao('s1', { storage, agora })
    expect(r.andamento?.etapa).toBe('equipe')
    expect(r.andamento?.motivo).toContain('invalid_file')
  })

  it('verificação já enviada antes: segue sem erro', async () => {
    sellerV2('s1', {}, { kontino: { connection_id: 'acct_1', status: 'pending' } })
    respostas.push(() => ({ status: 200, body: conta() }))
    respostas.push(() => ({ status: 409, body: { error: { code: 'verification_already_submitted', message: 'já enviada' } } }))
    const r = await abrirKontinoAposAprovacao('s1', { storage, agora })
    expect(r.andamento?.etapa).toBe('pronto')
    expect(chamadas[0].metodo).toBe('GET')
  })

  it('seller não aprovado ou sem cadastro v2: nada acontece', async () => {
    sellerV2('s1', { status: 'pending_review' })
    expect((await abrirKontinoAposAprovacao('s1', { storage, agora })).andamento).toBeNull()
    tabela.s2 = { id: 's2', status: 'active', config: {} }
    expect((await abrirKontinoAposAprovacao('s2', { storage, agora })).andamento).toBeNull()
    expect(chamadas).toHaveLength(0)
  })

  it('sem a chave da Kontino: fica na fila sem chamar a API', async () => {
    delete process.env.KONTINO_SECRET_KEY
    sellerV2('s1')
    const r = await abrirKontinoAposAprovacao('s1', { storage, agora })
    expect(r.andamento).toMatchObject({ etapa: 'abrindo', motivo: 'kontino_nao_configurada' })
    expect(chamadas).toHaveLength(0)
  })
})

describe('repasseRetido', () => {
  it('retém só cadastro v2 sem conta Kontino ativa', async () => {
    sellerV2('s1')
    expect(await repasseRetido('s1')).toBe(true)
    tabela.s1.config.kontino_account_id = 'acct_1'
    expect(await repasseRetido('s1')).toBe(false)
    tabela.s2 = { id: 's2', status: 'active', config: {} }
    expect(await repasseRetido('s2')).toBe(false)
  })
})
