import { supabase } from '../../lib/supabase.client'
import {
  type ContaKontino,
  ErroKontino,
  KONTINO_METODOS,
  ehMetodoKontino,
  buscarContaKontino,
  contaKontinoPorSeller,
  criarContaKontino,
  kontinoConfigurado,
  linkDaContaKontino,
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
  }
  /** Onde o seller usa a Kontino como banco (saldo, saques, cartão). */
  bankUrl: string
  /** Métodos que passam a sair pela Kontino com a conta ativa. */
  methods: string[]
}

export const KONTINO_BANCO_URL = 'https://kontino.co/entrar'
const METODOS = ['pix', 'spei']

export class ErroContaKontino extends Error {
  constructor(
    readonly code: 'not_configured' | 'invalid' | 'closed' | 'provider',
    message: string,
  ) {
    super(message)
  }
}

/** Config com a conexão aplicada. Só a conta aprovada vira `kontino_account_id`. */
export function configComConta(config: Record<string, any> | null | undefined, conta: ContaKontino, agora = new Date()): Record<string, any> {
  const c: Record<string, any> = { ...(config ?? {}) }
  const k: KontinoNoSeller = {
    connection_id: conta.id,
    status: String(conta.status),
    connection_type: String(conta.connection_type ?? ''),
    country: String(conta.country ?? ''),
    type: String(conta.type ?? ''),
    updated_at: agora.toISOString(),
  }
  c.kontino = k
  if (conta.status === 'active') c.kontino_account_id = conta.id
  else if (c.kontino_account_id === conta.id) delete c.kontino_account_id
  return c
}

const mudou = (antes: Record<string, any> | null | undefined, depois: Record<string, any>) =>
  antes?.kontino?.connection_id !== depois.kontino?.connection_id ||
  antes?.kontino?.status !== depois.kontino?.status ||
  (antes?.kontino_account_id ?? null) !== (depois.kontino_account_id ?? null)

async function configDoSeller(sellerId: string): Promise<Record<string, any> | null> {
  const { data, error } = await supabase.from('seller_profiles').select('id, config').eq('id', sellerId).maybeSingle()
  if (error) throw new Error(`seller_profiles: ${error.message}`)
  if (!data) return null
  return (data.config as Record<string, any>) ?? {}
}

/** Grava a conexão no seller (só escreve quando algo mudou). */
export async function guardarConta(sellerId: string, conta: ContaKontino): Promise<void> {
  const antes = await configDoSeller(sellerId)
  if (antes === null) return
  const depois = configComConta(antes, conta)
  if (!mudou(antes, depois)) return
  const { error } = await supabase.from('seller_profiles').update({ config: depois }).eq('id', sellerId)
  if (error) throw new Error(`seller_profiles.config: ${error.message}`)
  console.log(`[kontino-seller] seller ${sellerId}: conta ${conta.id} → ${conta.status}${depois.kontino_account_id ? ' (cobrando pela Kontino)' : ''}`)
}

function pendencias(req: unknown): { requirements: string[]; verifying: boolean; errors: string[] } {
  const r = (req ?? {}) as Record<string, unknown>
  const lista = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])
  return { requirements: lista(r.currently_due), verifying: lista(r.pending_verification).length > 0, errors: lista(r.errors) }
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
      },
    }
  }
  if (cache?.connection_id) {
    return {
      ...base,
      account: { id: cache.connection_id, status: cache.status, connectionType: cache.connection_type, country: cache.country, type: cache.type, capabilities: {}, requirements: [], verifying: false, errors: [] },
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
    return visao(conta)
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
