import { z } from 'zod'

/**
 * CADASTRO ÚNICO (ativação v2): um cadastro só, feito na Koopfy, que vale para
 * a Koopfy (vendedora de registro) e para a Kontino (onde o dinheiro cai).
 *
 * Os campos seguem o formato que a Kontino/BlindPay pede (KYC/KYB "standard"),
 * para a Koopfy repassar o mesmo pacote depois da aprovação sem o seller
 * redigitar nada. Arquivos são caminhos no storage privado da Koopfy, enviados
 * um a um antes (POST cadastro/arquivo); só viram URL temporária na hora de
 * mandar para a Kontino.
 *
 * Fica em `seller_profiles.config.cadastro`; `config.cadastro_chave` (país +
 * documento) acha a mesma empresa em outro seller; `config.cadastro_kontino`
 * guarda o andamento da abertura da conta Kontino depois da aprovação.
 *
 * Contrato: koopfy/specs/koopfy-ativacao-v2-contrato.md.
 */

export const CADASTRO_VERSAO = 2

export class ErroCadastro extends Error {
  constructor(
    message: string,
    readonly field: string | null = null,
  ) {
    super(message)
  }
}

const pais = z.string().trim().length(2).transform((s) => s.toUpperCase()).refine((s) => /^[A-Z]{2}$/.test(s), 'País inválido')
const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a data no formato AAAA-MM-DD')
const telefone = z.string().trim().regex(/^\+\d{8,15}$/, 'Use o formato internacional, ex.: +5511999998888')
const arquivo = z.string().trim().min(3).max(300)
const tipoDoc = z.enum(['PASSPORT', 'ID_CARD', 'DRIVERS'])
const tipoComprovante = z.enum(['UTILITY_BILL', 'BANK_STATEMENT', 'RENTAL_AGREEMENT', 'TAX_DOCUMENT', 'GOVERNMENT_CORRESPONDENCE'])
const documento = z.string().trim().min(3, 'Informe o documento').max(40)

const endereco = {
  address_line_1: z.string().trim().min(3, 'Informe o endereço').max(200),
  address_line_2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1, 'Informe a cidade').max(100),
  state_province_region: z.string().trim().min(1, 'Informe o estado').max(100),
  postal_code: z.string().trim().min(2, 'Informe o CEP / código postal').max(20),
}

const socio = z.object({
  role: z.enum(['beneficial_controlling', 'beneficial_owner', 'controlling_person']),
  first_name: z.string().trim().min(1, 'Informe o nome').max(100),
  last_name: z.string().trim().min(1, 'Informe o sobrenome').max(100),
  date_of_birth: data,
  tax_id: documento,
  ...endereco,
  country: pais,
  id_doc_country: pais,
  id_doc_type: tipoDoc,
  id_doc_front_file: arquivo,
  id_doc_back_file: arquivo.optional(),
  ownership_percentage: z.number().int().min(0).max(100).optional(),
  title: z.string().trim().max(100).optional(),
  proof_of_address_doc_type: tipoComprovante,
  proof_of_address_doc_file: arquivo,
})

const empresa = z.object({
  legal_name: z.string().trim().min(2, 'Informe a razão social').max(200),
  alternate_name: z.string().trim().max(200).optional(),
  formation_date: data,
  tax_id: documento,
  website: z.string().trim().min(4, 'Informe o site').max(300),
  phone_number: telefone,
  ...endereco,
  business_type: z.enum(['corporation', 'llc', 'partnership', 'sole_proprietorship', 'trust', 'non_profit']),
  business_description: z.string().trim().min(10, 'Descreva a empresa em pelo menos 10 caracteres').max(1000),
  estimated_annual_revenue: z
    .enum(['0_99999', '100000_999999', '1000000_9999999', '10000000_49999999', '50000000_249999999', '250000000_plus'])
    .optional(),
  incorporation_doc_file: arquivo,
  proof_of_ownership_doc_file: arquivo,
  proof_of_address_doc_type: tipoComprovante,
  proof_of_address_doc_file: arquivo,
  owners: z.array(socio).min(1, 'Informe ao menos um sócio').max(10),
})

const pessoa = z.object({
  first_name: z.string().trim().min(1, 'Informe o nome').max(100),
  last_name: z.string().trim().min(1, 'Informe o sobrenome').max(100),
  date_of_birth: data,
  tax_id: documento,
  phone_number: telefone,
  ...endereco,
  id_doc_country: pais,
  id_doc_type: tipoDoc,
  id_doc_front_file: arquivo,
  id_doc_back_file: arquivo.optional(),
  selfie_file: arquivo,
  proof_of_address_doc_type: tipoComprovante.optional(),
  proof_of_address_doc_file: arquivo.optional(),
  occupation: z.string().trim().max(120).optional(),
})

const operacao = z.object({
  description: z.string().trim().min(10, 'Conte o que você vende em pelo menos 10 caracteres').max(1000),
  category: z.string().trim().min(2, 'Escolha a categoria').max(80),
  channels: z.array(z.enum(['lynea', 'site', 'marketplace', 'social'])).min(1, 'Escolha onde você vende').max(4),
  offers: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'Informe o nome da oferta').max(160),
        url: z.string().trim().url('URL inválida').refine((u) => u.startsWith('https://'), 'Use um endereço https://').pipe(z.string().max(500)),
      }),
    )
    .min(1, 'Adicione ao menos uma oferta')
    .max(20),
})

const verdadeiro = (msg: string) => z.literal(true, { message: msg })

export const envioSchema = z
  .object({
    type: z.enum(['business', 'individual']),
    country: pais,
    business: empresa.optional(),
    individual: pessoa.optional(),
    operation: operacao,
    terms: z.object({
      koopfy: verdadeiro('Aceite os Termos da Koopfy'),
      kontino: verdadeiro('Aceite os Termos da Kontino'),
      aup: verdadeiro('Aceite a Política de Uso Aceitável'),
    }),
    has_kontino: z.enum(['yes', 'no', 'unknown']).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'business' && !v.business) ctx.addIssue({ code: 'custom', path: ['business'], message: 'Preencha os dados da empresa' })
    if (v.type === 'individual' && !v.individual) ctx.addIssue({ code: 'custom', path: ['individual'], message: 'Preencha os seus dados' })
    // Documento de identidade que não é passaporte tem verso.
    const semVerso = (d: { id_doc_type: string; id_doc_back_file?: string }) => d.id_doc_type !== 'PASSPORT' && !d.id_doc_back_file
    if (v.type === 'individual' && v.individual && semVerso(v.individual)) {
      ctx.addIssue({ code: 'custom', path: ['individual', 'id_doc_back_file'], message: 'Envie o verso do documento' })
    }
    if (v.type === 'business') {
      v.business?.owners.forEach((o, i) => {
        if (semVerso(o)) ctx.addIssue({ code: 'custom', path: ['business', 'owners', i, 'id_doc_back_file'], message: 'Envie o verso do documento' })
      })
    }
  })

export type EnvioCadastro = z.infer<typeof envioSchema>

/** Campos de arquivo do envio, com o caminho de cada um (para conferir dono e montar as URLs). */
export function arquivosDoEnvio(e: EnvioCadastro): Array<{ campo: string; id: string }> {
  const lista: Array<{ campo: string; id: string }> = []
  const add = (campo: string, id: string | undefined) => {
    if (id) lista.push({ campo, id })
  }
  if (e.type === 'business' && e.business) {
    const b = e.business
    add('business.incorporation_doc_file', b.incorporation_doc_file)
    add('business.proof_of_ownership_doc_file', b.proof_of_ownership_doc_file)
    add('business.proof_of_address_doc_file', b.proof_of_address_doc_file)
    b.owners.forEach((o, i) => {
      add(`business.owners.${i}.id_doc_front_file`, o.id_doc_front_file)
      add(`business.owners.${i}.id_doc_back_file`, o.id_doc_back_file)
      add(`business.owners.${i}.proof_of_address_doc_file`, o.proof_of_address_doc_file)
    })
  }
  if (e.type === 'individual' && e.individual) {
    const p = e.individual
    add('individual.id_doc_front_file', p.id_doc_front_file)
    add('individual.id_doc_back_file', p.id_doc_back_file)
    add('individual.selfie_file', p.selfie_file)
    add('individual.proof_of_address_doc_file', p.proof_of_address_doc_file)
  }
  return lista
}

/** Prefixo dos arquivos do cadastro de um usuário no storage. */
export const prefixoArquivo = (userId: string) => `${userId}/cadastro-`

/**
 * Valida o envio do painel. Erro → ErroCadastro com o caminho do campo
 * (ex.: `business.owners.0.tax_id`) para o painel levar ao passo certo.
 */
export function validarEnvio(corpo: unknown, userId: string): EnvioCadastro {
  // Só o bloco do tipo escolhido conta (o painel pode mandar o outro com sobras do rascunho).
  const bruto = corpo && typeof corpo === 'object' ? { ...(corpo as Record<string, unknown>) } : corpo
  if (bruto && typeof bruto === 'object') {
    const b = bruto as Record<string, unknown>
    if (b.type === 'business') delete b.individual
    if (b.type === 'individual') delete b.business
  }
  const r = envioSchema.safeParse(bruto)
  if (!r.success) {
    const i = r.error.issues[0]
    throw new ErroCadastro(mensagemDoProblema(i), i?.path?.length ? i.path.join('.') : null)
  }
  const e = r.data
  const prefixo = prefixoArquivo(userId)
  for (const a of arquivosDoEnvio(e)) {
    if (!a.id.startsWith(prefixo) || a.id.includes('..')) throw new ErroCadastro('Envie o arquivo de novo.', a.campo)
  }
  if (chaveDaEmpresa(e.country, documentoDoEnvio(e)) === null) {
    throw new ErroCadastro('Documento fiscal inválido.', e.type === 'business' ? 'business.tax_id' : 'individual.tax_id')
  }
  return e
}

/** Mensagens próprias ficam; as padrão do zod (em inglês) viram texto para o seller. */
function mensagemDoProblema(i: z.core.$ZodIssue | undefined): string {
  if (!i) return 'Confira os dados do cadastro.'
  if (i.code === 'invalid_type') return 'Preencha este campo.'
  if (i.code === 'invalid_value') return 'Escolha uma opção válida.'
  if (/^(Invalid|Too (small|big))/i.test(i.message)) return 'Confira este campo.'
  return i.message
}

export const documentoDoEnvio = (e: Pick<EnvioCadastro, 'type' | 'business' | 'individual'>) =>
  (e.type === 'business' ? e.business?.tax_id : e.individual?.tax_id) ?? ''

export const nomeDoEnvio = (e: Pick<EnvioCadastro, 'type' | 'business' | 'individual'>) =>
  e.type === 'business'
    ? e.business?.legal_name ?? ''
    : `${e.individual?.first_name ?? ''} ${e.individual?.last_name ?? ''}`.trim()

/** País + documento fiscal só com letras e números (mesma regra da Kontino). */
export function chaveDaEmpresa(pais: string | null | undefined, documento: string | null | undefined): string | null {
  const doc = String(documento ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const p = String(pais ?? '').toUpperCase().trim()
  return doc.length >= 5 && /^[A-Z]{2}$/.test(p) ? `${p}:${doc}` : null
}

/** Documento mascarado para a tela (só os 4 últimos). */
export function documentoMascarado(doc: string): string {
  const limpo = String(doc ?? '').replace(/[^A-Za-z0-9]/g, '')
  return limpo.length <= 4 ? limpo : `${'•'.repeat(Math.min(limpo.length - 4, 8))}${limpo.slice(-4)}`
}

// ─── Como fica guardado ──────────────────────────────────────────────────────

export type AceiteDosTermos = { accepted_at: string; ip_address: string; user_agent: string }

export type CadastroGuardado = {
  version: typeof CADASTRO_VERSAO
  submitted_at: string
  envio: EnvioCadastro
  aceite: AceiteDosTermos
}

/** Andamento da abertura da conta Kontino depois da aprovação. */
export type AndamentoKontino = {
  /** aguardando (não aprovado) | abrindo | erro (nova tentativa agendada) | equipe (caso com a equipe) | pronto */
  etapa: 'abrindo' | 'erro' | 'equipe' | 'pronto'
  tentativas: number
  proxima_tentativa: string | null
  motivo: string | null
  atualizado_em: string
}

/** Espera entre tentativas: 5 min, 15 min, 1 h, 3 h e depois a cada 6 h. */
export function proximaTentativa(tentativas: number, agora = new Date()): Date {
  const minutos = [5, 15, 60, 180][tentativas - 1] ?? 360
  return new Date(agora.getTime() + minutos * 60_000)
}

// ─── O que o painel lê (GET /finance/cadastro) ───────────────────────────────

export type EtapaKontino =
  | 'waiting'
  | 'opening'
  | 'authorize'
  | 'terms'
  | 'verifying'
  | 'action_required'
  | 'active'
  | 'rejected'
  | 'review'
  | 'unavailable'

export type EstadoCadastro = {
  eligible: boolean
  stage: 'start' | 'review' | 'approved' | 'rejected' | 'suspended'
  submittedAt: string | null
  reviewedAt: string | null
  rejectionReason: string | null
  summary: { type: 'business' | 'individual'; country: string; name: string; taxId: string } | null
  kontino: { stage: EtapaKontino; message: string | null; bankUrl: string | null }
  capabilities: { card: boolean; local: boolean; payouts: 'locked' | 'held' | 'enabled' }
  prefill: { email: string; name: string | null }
}

/** O que a Kontino diz da conexão, já resumido (ver kontino-seller.ts). */
export type ContaKontinoResumo = {
  status: string
  connectionType: string
  requirements: string[]
  verifying: boolean
  errors: string[]
} | null

const MENSAGENS: Partial<Record<EtapaKontino, string>> = {
  waiting: 'Sua conta de recebimento na Kontino é aberta automaticamente quando a Koopfy aprovar o cadastro.',
  opening: 'Estamos abrindo a sua conta Kontino com os dados do cadastro.',
  authorize: 'Sua empresa já tem conta na Kontino. Autorize a conexão para receber nela.',
  terms: 'Falta aceitar os termos da Kontino para concluir a abertura da conta.',
  verifying: 'A Kontino está verificando a sua conta. Avisamos quando terminar.',
  action_required: 'A Kontino precisa de uma informação para concluir a verificação.',
  active: 'Conta Kontino verificada: Pix, SPEI e repasses liberados.',
  rejected: 'A Kontino não aprovou a conta. Nossa equipe vai falar com você.',
  review: 'Nossa equipe está cuidando da sua conta de recebimento e fala com você em breve.',
  unavailable: 'A conta de recebimento estará disponível em breve.',
}

/** Etapa da Kontino a partir da conexão e do andamento. Puro: testável sem banco. */
export function etapaKontino(i: {
  aprovado: boolean
  configurado: boolean
  conta: ContaKontinoResumo
  andamento: AndamentoKontino | null
}): EtapaKontino {
  if (!i.aprovado) return 'waiting'
  if (!i.configurado) return 'unavailable'
  const c = i.conta
  if (!c) return i.andamento?.etapa === 'equipe' ? 'review' : 'opening'
  if (c.status === 'active') return 'active'
  if (c.status === 'rejected' || c.status === 'disabled') return 'rejected'
  if (c.status === 'disconnected') return 'review'
  if (i.andamento?.etapa === 'equipe') return 'review'
  if (c.connectionType === 'connect_existing') return 'authorize'
  if (c.requirements.includes('tos_acceptance')) return 'terms'
  // Pacote ainda não entregue à Kontino (nova tentativa agendada).
  if (c.requirements.includes('verification') || c.requirements.includes('onboarding')) return 'opening'
  if (c.verifying) return 'verifying'
  if (c.errors.length || c.requirements.length) return 'action_required'
  return 'verifying'
}

export function mensagemKontino(etapa: EtapaKontino, conta: ContaKontinoResumo): string | null {
  if (etapa === 'action_required' && conta?.errors.length) return conta.errors[0]
  return MENSAGENS[etapa] ?? null
}

/**
 * Quem entra no fluxo novo: todo seller ainda não aprovado (conta nova, em
 * análise ou recusado, com ou sem o cadastro antigo enviado). Fica no fluxo
 * antigo só quem já está aprovado, suspenso ou vendendo por provedor externo.
 */
export function elegivel(i: {
  temCadastroV2: boolean
  sellerStatus: string | null
  documentosAntigosEnviados: boolean
  provedorExternoCobrando: boolean
}): boolean {
  if (i.temCadastroV2) return true
  if (!i.sellerStatus) return true
  if (i.provedorExternoCobrando) return false
  if (i.sellerStatus === 'active' || i.sellerStatus === 'suspended') return false
  // Não aprovado (em análise ou recusado), mesmo com o cadastro antigo (LLC/Whop)
  // enviado: o cadastro antigo não serve mais (só LLC), e o novo aceita CPF e CNPJ.
  // `documentosAntigosEnviados` fica no contrato da função para leitura/log.
  void i.documentosAntigosEnviados
  return true
}

export function estadoDoCadastro(i: {
  email: string
  nome: string | null
  sellerStatus: string | null
  reviewedAt: string | null
  rejectionReason: string | null
  cadastro: CadastroGuardado | null
  andamento: AndamentoKontino | null
  conta: ContaKontinoResumo
  contaAtiva: boolean
  configurado: boolean
  eligible: boolean
  bankUrl: string
}): EstadoCadastro {
  const c = i.cadastro
  const enviado = !!c
  let stage: EstadoCadastro['stage'] = 'start'
  if (i.sellerStatus === 'active') stage = 'approved'
  else if (i.sellerStatus === 'suspended') stage = 'suspended'
  else if (i.sellerStatus === 'rejected') stage = 'rejected'
  else if (enviado) stage = 'review'
  // Recusado e reenviado depois: volta para análise.
  if (stage === 'rejected' && c && i.reviewedAt && c.submitted_at > i.reviewedAt) stage = 'review'

  const aprovado = stage === 'approved'
  const etapa = enviado ? etapaKontino({ aprovado, configurado: i.configurado, conta: i.conta, andamento: i.andamento }) : 'waiting'
  const local = aprovado && (etapa === 'active' || i.contaAtiva)
  return {
    eligible: i.eligible,
    stage,
    submittedAt: c?.submitted_at ?? null,
    reviewedAt: i.reviewedAt,
    rejectionReason: stage === 'rejected' ? i.rejectionReason : null,
    summary: c
      ? { type: c.envio.type, country: c.envio.country, name: nomeDoEnvio(c.envio), taxId: documentoMascarado(documentoDoEnvio(c.envio)) }
      : null,
    kontino: { stage: etapa, message: mensagemKontino(etapa, i.conta), bankUrl: etapa === 'active' ? i.bankUrl : null },
    capabilities: { card: aprovado, local, payouts: !aprovado ? 'locked' : local ? 'enabled' : 'held' },
    prefill: { email: i.email, name: i.nome },
  }
}
