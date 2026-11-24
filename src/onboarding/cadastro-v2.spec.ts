import {
  ErroCadastro,
  chaveDaEmpresa,
  documentoMascarado,
  elegivel,
  estadoDoCadastro,
  etapaKontino,
  validarEnvio,
  type CadastroGuardado,
} from './cadastro-v2'

const U = 'user-1'
const arq = (n: string) => `${U}/cadastro-${n}.pdf`

const socio = (o: Record<string, unknown> = {}) => ({
  role: 'beneficial_controlling',
  first_name: 'Ana',
  last_name: 'Souza',
  date_of_birth: '1990-01-02',
  tax_id: '123.456.789-09',
  address_line_1: 'Rua A, 10',
  city: 'São Paulo',
  state_province_region: 'SP',
  postal_code: '01000-000',
  country: 'br',
  id_doc_country: 'BR',
  id_doc_type: 'ID_CARD',
  id_doc_front_file: arq('rg-frente'),
  id_doc_back_file: arq('rg-verso'),
  proof_of_address_doc_type: 'UTILITY_BILL',
  proof_of_address_doc_file: arq('conta-luz'),
  ...o,
})

const envioEmpresa = (o: Record<string, any> = {}) => ({
  type: 'business',
  country: 'BR',
  business: {
    legal_name: 'Loja Exemplo LTDA',
    formation_date: '2020-05-01',
    tax_id: '12.345.678/0001-90',
    website: 'https://loja.exemplo',
    phone_number: '+5511999998888',
    address_line_1: 'Av. Paulista, 1000',
    city: 'São Paulo',
    state_province_region: 'SP',
    postal_code: '01310-100',
    business_type: 'llc',
    business_description: 'Venda de roupas fitness online.',
    incorporation_doc_file: arq('contrato'),
    proof_of_ownership_doc_file: arq('cartao-cnpj'),
    proof_of_address_doc_type: 'UTILITY_BILL',
    proof_of_address_doc_file: arq('endereco-empresa'),
    owners: [socio()],
  },
  individual: { lixo: true },
  operation: {
    description: 'Roupas fitness femininas vendidas pela Lynea.',
    category: 'moda',
    channels: ['lynea'],
    offers: [{ name: 'Legging', url: 'https://loja.exemplo/legging' }],
  },
  terms: { koopfy: true, kontino: true, aup: true },
  ...o,
})

const erro = (fn: () => unknown): ErroCadastro => {
  try {
    fn()
  } catch (e) {
    if (e instanceof ErroCadastro) return e
    throw e
  }
  throw new Error('esperava ErroCadastro')
}

describe('validarEnvio', () => {
  it('aceita empresa completa, normaliza o país e descarta o bloco do outro tipo', () => {
    const e = validarEnvio(envioEmpresa(), U)
    expect(e.type).toBe('business')
    expect(e.business?.owners[0].country).toBe('BR')
    expect(e.individual).toBeUndefined()
  })

  it('aponta o campo do sócio sem verso do documento', () => {
    const b = envioEmpresa()
    b.business.owners = [socio({ id_doc_back_file: undefined })]
    expect(erro(() => validarEnvio(b, U)).field).toBe('business.owners.0.id_doc_back_file')
  })

  it('passaporte não exige verso', () => {
    const b = envioEmpresa()
    b.business.owners = [socio({ id_doc_type: 'PASSPORT', id_doc_back_file: undefined })]
    expect(() => validarEnvio(b, U)).not.toThrow()
  })

  it('recusa arquivo de outro usuário', () => {
    const b = envioEmpresa()
    b.business.incorporation_doc_file = 'user-2/cadastro-x.pdf'
    expect(erro(() => validarEnvio(b, U)).field).toBe('business.incorporation_doc_file')
  })

  it('exige os três aceites', () => {
    expect(erro(() => validarEnvio(envioEmpresa({ terms: { koopfy: true, kontino: false, aup: true } }), U)).field).toBe('terms.kontino')
  })

  it('exige oferta https', () => {
    const b = envioEmpresa()
    b.operation.offers = [{ name: 'X', url: 'http://loja.exemplo' }]
    expect(erro(() => validarEnvio(b, U)).field).toBe('operation.offers.0.url')
  })

  it('pessoa física exige selfie', () => {
    const p = {
      ...envioEmpresa(),
      type: 'individual',
      business: undefined,
      individual: {
        first_name: 'Ana', last_name: 'Souza', date_of_birth: '1990-01-02', tax_id: '12345678909', phone_number: '+5511999998888',
        address_line_1: 'Rua A, 10', city: 'SP', state_province_region: 'SP', postal_code: '01000-000',
        id_doc_country: 'BR', id_doc_type: 'PASSPORT', id_doc_front_file: arq('passaporte'),
      },
    }
    expect(erro(() => validarEnvio(p, U)).field).toBe('individual.selfie_file')
  })
})

describe('chaveDaEmpresa', () => {
  it('país + documento só com letras e números', () => {
    expect(chaveDaEmpresa('br', '12.345.678/0001-90')).toBe('BR:12345678000190')
    expect(chaveDaEmpresa('MX', 'ab-12')).toBe(null)
    expect(chaveDaEmpresa('MX', 'abc-123')).toBe('MX:ABC123')
    expect(chaveDaEmpresa('XXX', '123456789')).toBe(null)
  })
  it('mascara o documento', () => {
    expect(documentoMascarado('12.345.678/0001-90')).toBe('••••••••0190')
  })
})

describe('etapaKontino', () => {
  const conta = (o: Record<string, unknown> = {}) => ({ status: 'pending', connectionType: 'onboarding', requirements: [] as string[], verifying: false, errors: [] as string[], ...o })
  const e = (c: any, andamento: any = null, aprovado = true, configurado = true) => etapaKontino({ aprovado, configurado, conta: c, andamento })

  it('nada antes da aprovação e sem chave', () => {
    expect(e(null, null, false)).toBe('waiting')
    expect(e(null, null, true, false)).toBe('unavailable')
  })
  it('abrindo até existir a conexão; equipe vira review', () => {
    expect(e(null)).toBe('opening')
    expect(e(null, { etapa: 'equipe' })).toBe('review')
  })
  it('empresa que já tinha Kontino: autorizar', () => {
    expect(e(conta({ connectionType: 'connect_existing' }))).toBe('authorize')
  })
  it('termos, pacote pendente, verificação e pendência', () => {
    expect(e(conta({ requirements: ['tos_acceptance'] }))).toBe('terms')
    expect(e(conta({ requirements: ['verification'] }))).toBe('opening')
    expect(e(conta({ verifying: true }))).toBe('verifying')
    expect(e(conta({ requirements: ['documents'] }))).toBe('action_required')
  })
  it('pedido por e-mail: aguardando o titular, depois conferência da Kontino (mesmo antes da aprovação)', () => {
    const pedido = conta({ connectionType: 'connect_existing', byEmail: true, requirements: ['verification'] })
    expect(e(pedido)).toBe('awaiting_holder')
    expect(e(pedido, null, false)).toBe('awaiting_holder')
    expect(e(conta({ connectionType: 'connect_existing', byEmail: true, verifying: true, inReview: true }))).toBe('kontino_review')
    expect(e(conta({ connectionType: 'connect_existing', byEmail: true, verifying: true }))).toBe('verifying')
    // Conexão da própria empresa aberta pela Koopfy (sem pedido por e-mail): o seller autoriza.
    expect(e(conta({ connectionType: 'connect_existing' }))).toBe('authorize')
    expect(e(conta({ verifying: true, inReview: true }))).toBe('kontino_review')
  })
  it('estados finais', () => {
    expect(e(conta({ status: 'active' }))).toBe('active')
    expect(e(conta({ status: 'rejected' }))).toBe('rejected')
    expect(e(conta({ status: 'disconnected' }))).toBe('review')
  })
})

describe('elegivel', () => {
  const base = { temCadastroV2: false, sellerStatus: 'pending_review', documentosAntigosEnviados: false, provedorExternoCobrando: false }
  it('conta nova ou sem nada enviado entra no fluxo novo', () => {
    expect(elegivel({ ...base, sellerStatus: null })).toBe(true)
    expect(elegivel(base)).toBe(true)
  })
  it('só quem vende pelo provedor externo fica no fluxo antigo', () => {
    // Aprovado no fluxo antigo também vê o fluxo novo (conta aprovada + conta de recebimento).
    expect(elegivel({ ...base, sellerStatus: 'active' })).toBe(true)
    expect(elegivel({ ...base, sellerStatus: 'suspended' })).toBe(true)
    // Cadastro antigo (LLC) em análise vai para o novo: o antigo não aceita CPF/CNPJ.
    expect(elegivel({ ...base, documentosAntigosEnviados: true })).toBe(true)
    expect(elegivel({ ...base, provedorExternoCobrando: true })).toBe(false)
  })
  it('cadastro v2 e recusado no antigo entram no novo', () => {
    expect(elegivel({ ...base, sellerStatus: 'active', temCadastroV2: true })).toBe(true)
    expect(elegivel({ ...base, sellerStatus: 'rejected', documentosAntigosEnviados: true })).toBe(true)
  })
})

describe('estadoDoCadastro', () => {
  const cad: CadastroGuardado = {
    version: 2,
    submitted_at: '2026-11-16T10:00:00.000Z',
    envio: validarEnvio(envioEmpresa(), U),
    aceite: { accepted_at: '2026-11-16T10:00:00.000Z', ip_address: '1.2.3.4', user_agent: 'UA' },
  }
  const base = {
    email: 'a@b.co', nome: 'Ana', sellerStatus: 'pending_review', reviewedAt: null, rejectionReason: 'x', cadastro: cad,
    andamento: null, conta: null, contaAtiva: false, configurado: true, eligible: true, bankUrl: 'https://kontino.co/entrar',
  }
  it('em análise: nada liberado, Kontino aguardando', () => {
    const s = estadoDoCadastro(base)
    expect(s.stage).toBe('review')
    expect(s.kontino.stage).toBe('waiting')
    expect(s.capabilities).toEqual({ card: false, local: false, payouts: 'locked' })
    expect(s.rejectionReason).toBeNull()
    expect(s.summary).toEqual({ type: 'business', country: 'BR', name: 'Loja Exemplo LTDA', taxId: '••••••••0190' })
  })
  it('aprovado com Kontino verificando: cartão sim, repasse retido', () => {
    const s = estadoDoCadastro({ ...base, sellerStatus: 'active', conta: { status: 'pending', connectionType: 'onboarding', requirements: [], verifying: true, errors: [] } })
    expect(s.stage).toBe('approved')
    expect(s.kontino.stage).toBe('verifying')
    expect(s.capabilities).toEqual({ card: true, local: false, payouts: 'held' })
  })
  it('Kontino ativa: tudo liberado e link do banco', () => {
    const s = estadoDoCadastro({ ...base, sellerStatus: 'active', contaAtiva: true, conta: { status: 'active', connectionType: 'onboarding', requirements: [], verifying: false, errors: [] } })
    expect(s.capabilities).toEqual({ card: true, local: true, payouts: 'enabled' })
    expect(s.kontino.bankUrl).toBe('https://kontino.co/entrar')
  })
  it('recusado mostra o motivo; reenviado depois volta para análise', () => {
    expect(estadoDoCadastro({ ...base, sellerStatus: 'rejected', reviewedAt: '2026-11-15T00:00:00.000Z' }).stage).toBe('review')
    const r = estadoDoCadastro({ ...base, sellerStatus: 'rejected', reviewedAt: '2026-11-17T00:00:00.000Z' })
    expect(r.stage).toBe('rejected')
    expect(r.rejectionReason).toBe('x')
  })
  it('sem cadastro: começar', () => {
    expect(estadoDoCadastro({ ...base, cadastro: null, sellerStatus: null }).stage).toBe('start')
  })
})

describe('aprovado no fluxo antigo (sem cadastro único)', () => {
  const base = {
    email: 'a@b.co', nome: 'Ana', sellerStatus: 'active', reviewedAt: '2026-10-01T00:00:00.000Z', rejectionReason: null, cadastro: null,
    andamento: null, conta: null, contaAtiva: false, configurado: true, eligible: true, bankUrl: 'https://kontino.co/entrar',
  }
  it('sem conta Kontino: aprovado, abre a conta de recebimento e saca como sempre', () => {
    const s = estadoDoCadastro(base)
    expect(s.stage).toBe('approved')
    expect(s.kontino.stage).toBe('setup')
    expect(s.capabilities).toEqual({ card: true, local: false, payouts: 'enabled' })
  })
  it('conta Kontino aberta por ele e ainda sem dados: conclui na Kontino', () => {
    const s = estadoDoCadastro({ ...base, conta: { status: 'pending', connectionType: 'onboarding', requirements: ['verification'], verifying: false, errors: [] } })
    expect(s.kontino.stage).toBe('action_required')
    expect(s.kontino.message).toBe('Conclua a abertura da sua conta na Kontino.')
  })
  it('conta Kontino ativa: tudo liberado', () => {
    const s = estadoDoCadastro({ ...base, contaAtiva: true, conta: { status: 'active', connectionType: 'onboarding', requirements: [], verifying: false, errors: [] } })
    expect(s.kontino.stage).toBe('active')
    expect(s.capabilities).toEqual({ card: true, local: true, payouts: 'enabled' })
  })
})
