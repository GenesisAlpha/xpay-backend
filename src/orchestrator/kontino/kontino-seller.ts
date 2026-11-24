import { supabase } from '../../lib/supabase.client'
import { CADASTRO_VERSAO, type CadastroGuardado, documentoDoEnvio } from '../../onboarding/cadastro-v2'
import {
  type ContaKontino,
  ErroKontino,
  KONTINO_METODOS,
  ehMetodoKontino,
  buscarContaKontino,
  conectarContaKontinoExistente,
  contaKontinoPorSeller,
  criarContaKontino,
  desconectarContaKontino,
  kontinoConfigurado,
  linkDaContaKontino,
  pedirConexaoPorEmailKontino,
} from './kontino'

/**
 * A CONTA KONTINO DO SELLER, do lado da Koopfy.
 *
 * O seller abre (ou liga) a conta Kontino pelo painel da Koopfy. A conexão
 * fica em `seller_profiles.config.kontino` e o id só vira
 * `config.kontino_account_id` — o que o pagamento usa para cobrar Pix e SPEI
 * pela Kontino — quando a conta está APROVADA ("active"). Antes disso o
 * roteamento pula a Kontino e segue para o próximo provedor da regra.
 *
 * O status chega por dois caminhos: webhook `account.*` do Kontino (sempre
 * confirmado na API antes de gravar) e a leitura do painel, que consulta a
 * API a cada abertura. Os dois passam por `guardarConta`.
 */

export type KontinoNoSeller = {
  connection_id: string
  status: string
  connection_type: string
  country: string
  type: string
  updated_at: string
  /** A conexão nasceu de um pedido por e-mail a um titular (que pode ser outra pessoa). */
  por_email?: boolean
  /** E-mail do titular, mascarado (para mostrar "aguardando fu***@…" sem consultar a Kontino). */
  email_mascarado?: string | null
}

export type VisaoKontino = {
  available: boolean
  account: null | {
    id: string
    status: string
    connectionType: string
    country: string
    type: string
    /** Capacidades da conta no Kontino (collections, payouts…). */
    capabilities: Record<string, string>
    /** O que o Kontino ainda pede ao seller (onboarding, terms_acceptance, identity, documents). */
    requirements: string[]
    /** Documentos enviados e em análise no Kontino. */
    verifying: boolean
    /** Avisos da verificação (o que corrigir). */
    errors: string[]
    /** E-mail da conexão, mascarado (o pedido de conexão foi para ele). */
    emailMasked: string | null
    /** Pedido de conexão enviado por e-mail a um titular: quem autoriza é ele, não o seller. */
    byEmail: boolean
    /** Autorizada (ou verificada) e esperando a conferência do time Kontino (titular e preço). */
    inReview: boolean
  }
  /** Onde o seller usa a Kontino como banco (saldo, saques, cartão). */
  bankUrl: string
  /** Métodos que passam a sair pela Kontino com a conta ativa. */
  methods: string[]
}

export const KONTINO_BANCO_URL = 'https://kontino.co/entrar'
const METODOS = Object.keys(KONTINO_METODOS)

export class ErroContaKontino extends Error {
  constructor(
    readonly code: 'not_configured' | 'invalid' | 'closed' | 'provider',
    message: string,
  ) {
    super(message)
  }
}

/** Config com a conexão aplicada. Só a conta aprovada vira `kontino_account_id`. */
export function configComConta(
  config: Record<string, any> | null | undefined,
  conta: ContaKontino,
  agora = new Date(),
  extra: { porEmail?: boolean } = {},
): Record<string, any> {
  const c: Record<string, any> = { ...(config ?? {}) }
  const mesma = c.kontino?.connection_id === conta.id
  const porEmail = extra.porEmail ?? (mesma ? !!c.kontino?.por_email : false)
  const k: KontinoNoSeller = {
    connection_id: conta.id,
    status: String(conta.status),
    connection_type: String(conta.connection_type ?? ''),
    country: String(conta.country ?? ''),
    type: String(conta.type ?? ''),
    updated_at: agora.toISOString(),
    ...(porEmail ? { por_email: true, email_mascarado: conta.email ? mascararEmail(conta.email) : (c.kontino?.email_mascarado ?? null) } : {}),
  }
  c.kontino = k
  if (conta.status === 'active') c.kontino_account_id = conta.id
  else if (c.kontino_account_id === conta.id) delete c.kontino_account_id
  return c
}

const mudou = (antes: Record<string, any> | null | undefined, depois: Record<string, any>) =>
  antes?.kontino?.connection_id !== depois.kontino?.connection_id ||
  antes?.kontino?.status !== depois.kontino?.status ||
  !!antes?.kontino?.por_email !== !!depois.kontino?.por_email ||
  (antes?.kontino_account_id ?? null) !== (depois.kontino_account_id ?? null)

async function configDoSeller(sellerId: string): Promise<Record<string, any> | null> {
  const { data, error } = await supabase.from('seller_profiles').select('id, config').eq('id', sellerId).maybeSingle()
  if (error) throw new Error(`seller_profiles: ${error.message}`)
  if (!data) return null
  return (data.config as Record<string, any>) ?? {}
}

/** Grava a conexão no seller (só escreve quando algo mudou). */
export async function guardarConta(sellerId: string, conta: ContaKontino, extra: { porEmail?: boolean } = {}): Promise<void> {
  const antes = await configDoSeller(sellerId)
  if (antes === null) return
  const depois = configComConta(antes, conta, new Date(), extra)
  if (!mudou(antes, depois)) return
  const { error } = await supabase.from('seller_profiles').update({ config: depois }).eq('id', sellerId)
  if (error) throw new Error(`seller_profiles.config: ${error.message}`)
  console.log(`[kontino-seller] seller ${sellerId}: conta ${conta.id} → ${conta.status}${depois.kontino_account_id ? ' (cobrando pela Kontino)' : ''}`)
}

function pendencias(req: unknown): { requirements: string[]; verifying: boolean; errors: string[]; inReview: boolean } {
  const r = (req ?? {}) as Record<string, unknown>
  const lista = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])
  const emVerificacao = lista(r.pending_verification)
  return { requirements: lista(r.currently_due), verifying: emVerificacao.length > 0, errors: lista(r.errors), inReview: emVerificacao.includes('kontino_review') }
}

function visao(conta: ContaKontino | null, cache?: KontinoNoSeller | null): VisaoKontino {
  const base = { available: true, bankUrl: KONTINO_BANCO_URL, methods: METODOS }
  if (conta) {
    return {
      ...base,
      account: {
        id: conta.id,
        status: String(conta.status),
        connectionType: String(conta.connection_type ?? ''),
        country: String(conta.country ?? ''),
        type: String(conta.type ?? ''),
        capabilities: (conta.capabilities as Record<string, string>) ?? {},
        ...pendencias(conta.requirements),
        emailMasked: conta.email ? mascararEmail(conta.email) : null,
        byEmail: !!cache?.por_email && cache.connection_id === conta.id,
      },
    }
  }
  if (cache?.connection_id) {
    return {
      ...base,
      account: {
        id: cache.connection_id,
        status: cache.status,
        connectionType: cache.connection_type,
        country: cache.country,
        type: cache.type,
        capabilities: {},
        requirements: [],
        verifying: false,
        errors: [],
        emailMasked: cache.email_mascarado ?? null,
        byEmail: !!cache.por_email,
        inReview: false,
      },
    }
  }
  return { ...base, account: null }
}

/** O que o painel mostra. Consulta o Kontino a cada abertura (status fresco). */
export async function estadoKontino(sellerId: string | null): Promise<VisaoKontino> {
  if (!kontinoConfigurado()) return { available: false, account: null, bankUrl: KONTINO_BANCO_URL, methods: METODOS }
  if (!sellerId) return visao(null)
  const config = await configDoSeller(sellerId)
  const cache: KontinoNoSeller | null = config?.kontino ?? null
  if (!cache?.connection_id) return visao(null)
  try {
    const conta = await buscarContaKontino(cache.connection_id)
    await guardarConta(sellerId, conta)
    return visao(conta, cache)
  } catch (err: any) {
    console.warn(`[kontino-seller] não consegui ler a conta ${cache.connection_id}:`, err?.message)
    return visao(null, cache)
  }
}

const PAIS = /^[A-Z]{2}$/

/**
 * Abre a conta Kontino do seller (ou retoma a que já existe) e devolve o link
 * para ele concluir no Kontino. Conta já aprovada não precisa de link.
 */
export async function iniciarContaKontino(i: {
  sellerId: string
  email: string
  nome?: string | null
  tipo: 'individual' | 'business'
  pais: string
  retorno?: string | null
}): Promise<{ url: string | null; expiresAt: string | null; state: VisaoKontino }> {
  if (!kontinoConfigurado()) throw new ErroContaKontino('not_configured', 'A Kontino ainda não está disponível na sua conta.')
  const pais = String(i.pais ?? '').trim().toUpperCase()
  if (!PAIS.test(pais)) throw new ErroContaKontino('invalid', 'Informe o país da conta.')
  if (i.tipo !== 'individual' && i.tipo !== 'business') throw new ErroContaKontino('invalid', 'Informe se a conta é de empresa ou pessoa.')
  const email = String(i.email ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErroContaKontino('invalid', 'Informe um e-mail válido.')
  const retorno = i.retorno && /^https:\/\//.test(i.retorno) ? i.retorno : null

  const config = await configDoSeller(i.sellerId)
  if (config === null) throw new ErroContaKontino('invalid', 'Conta Koopfy não encontrada.')

  let conta: ContaKontino | null = null
  try {
    const ja: string | undefined = config.kontino?.connection_id
    if (ja) conta = await buscarContaKontino(ja)
    if (!conta || conta.status === 'disconnected') {
      try {
        conta = await criarContaKontino({ sellerId: i.sellerId, email, nome: i.nome, tipo: i.tipo, pais, retorno })
      } catch (err) {
        if (!(err instanceof ErroKontino) || err.status !== 409) throw err
        conta = await contaKontinoPorSeller(i.sellerId, err.message)
        if (!conta) throw err
      }
    }
    await guardarConta(i.sellerId, conta)

    if (conta.status === 'disconnected') {
      throw new ErroContaKontino('closed', 'A conexão com a Kontino foi encerrada. Fale com o suporte para reabrir.')
    }
    if (conta.status === 'rejected' || conta.status === 'disabled') {
      throw new ErroContaKontino('closed', 'A Kontino não aprovou esta conta. Fale com o suporte.')
    }
    if (conta.status !== 'pending') return { url: null, expiresAt: null, state: visao(conta) }

    const link = await linkDaContaKontino(conta.id, retorno)
    return { url: link.url, expiresAt: link.expires_at, state: visao(conta) }
  } catch (err) {
    if (err instanceof ErroContaKontino) throw err
    if (err instanceof ErroKontino) {
      console.error(`[kontino-seller] seller ${i.sellerId}: ${err.status} ${err.code} ${err.message}`)
      // 4xx do Kontino é dado do pedido (país, e-mail…): a mensagem serve ao seller.
      if (err.status >= 400 && err.status < 500 && err.code !== 'not_configured') throw new ErroContaKontino('invalid', err.message)
      throw new ErroContaKontino('provider', 'A Kontino não respondeu agora. Tente de novo em instantes.')
    }
    throw err
  }
}

/** Empresa do cadastro único (para a Kontino comparar com o titular da conta escolhida). */
function empresaDoCadastro(config: Record<string, any>): { pais: string; documento: string; tipo: 'individual' | 'business' } | null {
  const c = config?.cadastro
  if (!c || c.version !== CADASTRO_VERSAO || !c.envio) return null
  const envio = c.envio as CadastroGuardado['envio']
  const documento = documentoDoEnvio(envio)
  const pais = String(envio.country ?? '').toUpperCase()
  return documento && PAIS.test(pais) ? { pais, documento, tipo: envio.type === 'individual' ? 'individual' : 'business' } : null
}

/** Pedido por e-mail ainda pendente (conexão que espera o titular). */
async function pedidoPendente(sellerId: string): Promise<{ config: Record<string, any>; conta: ContaKontino } | null> {
  const config = await configDoSeller(sellerId)
  const id: string | undefined = config?.kontino?.connection_id
  if (!config || !id) return null
  const conta = await buscarContaKontino(id).catch(() => null)
  return conta && conta.status === 'pending' && conta.connection_type === 'connect_existing' ? { config, conta } : null
}

function erroDaKontino(sellerId: string, acao: string, err: unknown): never {
  if (err instanceof ErroContaKontino) throw err
  if (err instanceof ErroKontino) {
    console.error(`[kontino-seller] seller ${sellerId} ${acao}: ${err.status} ${err.code} ${err.message}`)
    if (err.code === 'no_kontino_account') throw new ErroContaKontino('invalid', 'Este e-mail não tem conta Kontino. Confira o e-mail ou abra uma conta nova.')
    if (err.status >= 400 && err.status < 500 && err.code !== 'not_configured') throw new ErroContaKontino('invalid', err.message)
    throw new ErroContaKontino('provider', 'A Kontino não respondeu agora. Tente de novo em instantes.')
  }
  throw err
}

/**
 * Conecta uma conta Kontino que o seller (ou a empresa dele) JÁ TEM, pelo
 * e-mail do titular. A Kontino manda o pedido a esse e-mail; o titular
 * autoriza no app dela, o time Kontino confere (titular e preço) e a conexão
 * fica ativa; o webhook `account.updated` grava `kontino_account_id`.
 *
 * Sem e-mail (ou o mesmo e-mail) com pedido pendente: só reenvia. Pedido
 * pendente de outro tipo (conta nova, outro e-mail) é cancelado antes. Conta
 * já ativa: recusa. A empresa do cadastro vai junto (tax_id) para a Kontino
 * avisar o time quando o titular for outra empresa.
 */
export async function conectarContaExistente(i: {
  sellerId: string
  email?: string | null
  tipo?: 'individual' | 'business'
  pais?: string | null
  retorno?: string | null
}): Promise<{ emailedTo: string | null; expiresAt: string | null; state: VisaoKontino }> {
  if (!kontinoConfigurado()) throw new ErroContaKontino('not_configured', 'A Kontino ainda não está disponível na sua conta.')
  const pedido = String(i.email ?? '').trim().toLowerCase()
  if (pedido && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pedido)) throw new ErroContaKontino('invalid', 'Informe o e-mail da conta Kontino.')
  const pais = String(i.pais ?? '').trim().toUpperCase()
  const retorno = i.retorno && /^https:\/\//.test(i.retorno) ? i.retorno : null
  const config = await configDoSeller(i.sellerId)
  if (config === null) throw new ErroContaKontino('invalid', 'Conta Koopfy não encontrada.')

  try {
    const ja: string | undefined = config.kontino?.connection_id
    let conta: ContaKontino | null = ja ? await buscarContaKontino(ja).catch(() => null) : null
    if (conta?.status === 'active') throw new ErroContaKontino('invalid', 'Você já tem uma conta Kontino conectada.')
    const pendente = conta?.status === 'pending' && conta.connection_type === 'connect_existing'
    const email = pedido || (pendente ? String(conta!.email ?? '').toLowerCase() : '')
    if (!email) throw new ErroContaKontino('invalid', 'Informe o e-mail da conta Kontino.')
    const mesmoPedido = pendente && String(conta!.email ?? '').toLowerCase() === email
    if (conta && conta.status === 'pending' && !mesmoPedido) {
      await desconectarContaKontino(conta.id).catch((e) => console.warn(`[kontino-seller] cancelar conexão ${conta?.id}:`, e?.message))
      conta = null
    }
    if (!mesmoPedido) {
      const empresa = empresaDoCadastro(config)
      const tipo = i.tipo ?? empresa?.tipo ?? 'business'
      conta = await conectarContaKontinoExistente({
        sellerId: i.sellerId,
        email,
        tipo,
        pais: PAIS.test(pais) ? pais : empresa?.pais || String(config.kontino?.country ?? '').toUpperCase() || 'US',
        documento: tipo === 'business' ? (empresa?.documento ?? null) : null,
        retorno,
      })
    }
    await guardarConta(i.sellerId, conta!, { porEmail: true })
    const link = await pedirConexaoPorEmailKontino(conta!.id, retorno)
    console.log(`[kontino-seller] seller ${i.sellerId}: pedido de conexão ${conta!.id} enviado ao titular (${link.emailed_to ?? '—'})`)
    return { emailedTo: link.emailed_to ?? null, expiresAt: link.expires_at ?? null, state: visao(conta, { ...(config.kontino ?? {}), connection_id: conta!.id, por_email: true } as KontinoNoSeller) }
  } catch (err) {
    erroDaKontino(i.sellerId, 'conectar existente', err)
  }
}

/**
 * Link do pedido de conexão para o seller mandar ao titular por outro canal
 * (WhatsApp etc.). Só abre com a senha do titular no Kontino; vale 24 h.
 */
export async function linkDoPedidoDeConexao(sellerId: string, retorno?: string | null): Promise<{ url: string; expiresAt: string | null }> {
  if (!kontinoConfigurado()) throw new ErroContaKontino('not_configured', 'A Kontino ainda não está disponível na sua conta.')
  try {
    const p = await pedidoPendente(sellerId)
    if (!p) throw new ErroContaKontino('invalid', 'Não há pedido de conexão esperando o titular.')
    const link = await linkDaContaKontino(p.conta.id, retorno && /^https:\/\//.test(retorno) ? retorno : null)
    if (!link.url) throw new ErroContaKontino('provider', 'A Kontino não devolveu o link. Tente de novo.')
    return { url: link.url, expiresAt: link.expires_at ?? null }
  } catch (err) {
    erroDaKontino(sellerId, 'link do pedido', err)
  }
}

/** Cancela o pedido de conexão que espera o titular (a conta Kontino dele não muda). */
export async function cancelarPedidoDeConexao(sellerId: string): Promise<VisaoKontino> {
  if (!kontinoConfigurado()) throw new ErroContaKontino('not_configured', 'A Kontino ainda não está disponível na sua conta.')
  try {
    const p = await pedidoPendente(sellerId)
    if (!p) throw new ErroContaKontino('invalid', 'Não há pedido de conexão esperando o titular.')
    await desconectarContaKontino(p.conta.id)
    // Sai do seller: um pedido cancelado não é "conexão encerrada" (o seller pode pedir de novo ou abrir conta).
    const config = { ...p.config }
    if (config.kontino?.connection_id === p.conta.id) delete config.kontino
    if (config.kontino_account_id === p.conta.id) delete config.kontino_account_id
    const { error } = await supabase.from('seller_profiles').update({ config }).eq('id', sellerId)
    if (error) throw new Error(`seller_profiles.config: ${error.message}`)
    console.log(`[kontino-seller] seller ${sellerId}: pedido de conexão ${p.conta.id} cancelado`)
    return visao(null)
  } catch (err) {
    erroDaKontino(sellerId, 'cancelar pedido', err)
  }
}

/** "fi***@empresa.com" */
export function mascararEmail(email: string): string {
  const [nome, dominio] = String(email).split('@')
  if (!dominio) return '***'
  return `${nome.slice(0, Math.min(2, Math.max(1, nome.length - 1)))}***@${dominio}`
}

/**
 * Webhook `account.*`: confere a conta na API (fonte autoritativa) e grava no
 * seller dono dela (external_id). Conta de outro seller ou desconhecida é
 * ignorada.
 */
export async function contaKontinoMudou(contaId: string): Promise<{ ok: boolean; reason?: string }> {
  const conta = await buscarContaKontino(contaId)
  // Dono (external_id) + outros sellers da mesma empresa que reaproveitam a conexão.
  const sellers = new Set<string>()
  if (conta.external_id) sellers.add(conta.external_id)
  for (const id of await sellersDaConexao(conta.id)) sellers.add(id)
  if (!sellers.size) return { ok: false, reason: 'account without external_id' }
  let gravou = false
  for (const sellerId of sellers) {
    const config = await configDoSeller(sellerId)
    if (config === null) continue
    const atual: string | undefined = config.kontino?.connection_id
    if (atual && atual !== conta.id) continue
    await guardarConta(sellerId, conta)
    gravou = true
  }
  return gravou ? { ok: true } : { ok: false, reason: 'seller not found or has another connection' }
}

async function sellersDaConexao(contaId: string): Promise<string[]> {
  try {
    const { data, error } = await supabase.from('seller_profiles').select('id').eq('config->kontino->>connection_id', contaId).limit(50)
    if (error) throw new Error(error.message)
    return (data ?? []).map((r: any) => String(r.id))
  } catch (e: any) {
    // Sem a lista, o dono (external_id) ainda é atualizado.
    console.warn(`[kontino-seller] sellers da conexão ${contaId}: ${e?.message}`)
    return []
  }
}

/**
 * Pix (BRL) e SPEI (MXN) saem pela conta Kontino ATIVA do seller quando não há
 * regra da plataforma para o método. Devolve a reserva (o provedor de antes) ou
 * null quando a Kontino não entra nesta cobrança.
 */
export function kontinoPelaContaDoSeller(i: {
  routedByMethod: boolean
  upsell: boolean
  contaKontino: unknown
  configurado: boolean
  metodo: string
  moeda: string
  metodosDoSeller: unknown
  provedorAtual: string | null | undefined
}): { reserva: string | null } | null {
  if (i.routedByMethod || i.upsell || !i.configurado) return null
  if (!String(i.contaKontino ?? '').trim()) return null
  if (!ehMetodoKontino(i.metodo)) return null
  if (String(i.moeda).toUpperCase() !== KONTINO_METODOS[i.metodo].moeda) return null
  const metodos = Array.isArray(i.metodosDoSeller) ? i.metodosDoSeller.map((m) => String(m).toLowerCase()) : []
  if (!metodos.includes(i.metodo)) return null
  const reserva = i.provedorAtual && i.provedorAtual !== 'kontino' ? i.provedorAtual : null
  return { reserva }
}
