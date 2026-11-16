import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabase } from '../../lib/supabase.client'
import { StorageService } from '../../lib/storage.service'
import {
  type AndamentoKontino,
  type CadastroGuardado,
  CADASTRO_VERSAO,
  arquivosDoEnvio,
  chaveDaEmpresa,
  documentoDoEnvio,
  nomeDoEnvio,
  proximaTentativa,
} from '../../onboarding/cadastro-v2'
import {
  type ContaKontino,
  ErroKontino,
  buscarContaKontino,
  contaKontinoPorSeller,
  criarContaKontino,
  enviarVerificacaoKontino,
  kontinoConfigurado,
} from './kontino'
import { guardarConta } from './kontino-seller'

/**
 * CONTA KONTINO DEPOIS DA APROVAÇÃO (ativação v2).
 *
 * A conta Kontino tem custo mensal, então ela só nasce para seller APROVADO
 * pela Koopfy, e sozinha: o seller não clica em nada. Antes de criar, confere
 * se a empresa já tem conta (na Koopfy, outro seller com o mesmo documento; na
 * Kontino, pelo país + documento fiscal). Ordem:
 *
 * 1. outro seller da Koopfy com a mesma empresa e conexão → reaproveita;
 * 2. cria a conexão na Kontino com o documento fiscal:
 *    - 409 company_already_connected → a empresa já está ligada à Koopfy: reaproveita;
 *    - existing_company (já tem Kontino) → o seller só autoriza a conexão (painel);
 *      empresa recusada/encerrada na Kontino → caso com a equipe;
 * 3. conta nova → envia o mesmo pacote do cadastro (KYB + aceite dos termos).
 *
 * Falha da Kontino (rede, 5xx, chave ausente) agenda nova tentativa; dado
 * recusado (4xx) vai para a equipe. O andamento fica em
 * `seller_profiles.config.cadastro_kontino`.
 */

const URL_ARQUIVO_VALIDADE = 2 * 3600

type SellerRow = { id: string; user_id: string; email: string | null; name: string | null; status: string; config: Record<string, any> | null }

async function seller(sellerId: string): Promise<SellerRow | null> {
  const { data, error } = await supabase.from('seller_profiles').select('id, user_id, email, name, status, config').eq('id', sellerId).maybeSingle()
  if (error) throw new Error(`seller_profiles: ${error.message}`)
  return (data as SellerRow) ?? null
}

export function cadastroV2(config: Record<string, any> | null | undefined): CadastroGuardado | null {
  const c = config?.cadastro
  return c && c.version === CADASTRO_VERSAO && c.envio ? (c as CadastroGuardado) : null
}

/** Grava o andamento relendo o config (guardarConta pode ter escrito no meio). */
async function marcar(sellerId: string, andamento: Omit<AndamentoKontino, 'atualizado_em'>, agora = new Date()): Promise<AndamentoKontino> {
  const s = await seller(sellerId)
  const a: AndamentoKontino = { ...andamento, atualizado_em: agora.toISOString() }
  if (!s) return a
  const { error } = await supabase
    .from('seller_profiles')
    .update({ config: { ...(s.config ?? {}), cadastro_kontino: a } })
    .eq('id', sellerId)
  if (error) throw new Error(`seller_profiles.config: ${error.message}`)
  return a
}

/** Conexão de outro seller da Koopfy com a mesma empresa (país + documento). */
async function conexaoDaMesmaEmpresa(sellerId: string, chave: string): Promise<ContaKontino | null> {
  const { data, error } = await supabase
    .from('seller_profiles')
    .select('id, config')
    .eq('config->>cadastro_chave', chave)
    .neq('id', sellerId)
    .limit(20)
  if (error) throw new Error(`seller_profiles (mesma empresa): ${error.message}`)
  for (const outro of data ?? []) {
    const id: string | undefined = (outro.config as any)?.kontino?.connection_id
    if (!id) continue
    const conta = await buscarContaKontino(id)
    if (conta.status !== 'disconnected') return conta
  }
  return null
}

const pendencias = (c: ContaKontino): string[] => {
  const r = (c.requirements ?? {}) as Record<string, unknown>
  return Array.isArray(r.currently_due) ? r.currently_due.map(String) : []
}

/** Conta nova da Kontino que ainda não recebeu o cadastro. */
export function precisaDoCadastro(c: ContaKontino): boolean {
  if (c.connection_type !== 'onboarding' || c.status !== 'pending') return false
  const p = pendencias(c)
  return p.includes('verification') || p.includes('onboarding')
}

/** O pacote do cadastro no formato da Kontino, com URLs temporárias dos arquivos. */
export async function corpoDaVerificacao(cad: CadastroGuardado, storage: Pick<StorageService, 'getSignedDocumentUrl'>) {
  const envio = structuredClone(cad.envio) as any
  for (const a of arquivosDoEnvio(cad.envio)) {
    const url = await storage.getSignedDocumentUrl(a.id, URL_ARQUIVO_VALIDADE)
    if (!url) throw new ErroKontino(400, 'file_missing', `Arquivo do cadastro não encontrado (${a.campo}).`)
    // campo = "business.owners.0.id_doc_front_file": troca o caminho pela URL no mesmo lugar.
    const partes = a.campo.split('.')
    let alvo = envio
    for (const p of partes.slice(0, -1)) alvo = alvo[/^\d+$/.test(p) ? Number(p) : p]
    alvo[partes[partes.length - 1]] = url
  }
  const corpo: Parameters<typeof enviarVerificacaoKontino>[1] = {
    type: cad.envio.type,
    tos: cad.aceite,
  }
  if (cad.envio.type === 'business') {
    corpo.business = { ...envio.business, country: cad.envio.country }
  } else {
    corpo.individual = { ...envio.individual, country: cad.envio.country }
  }
  return corpo
}

export type ResultadoAbertura = { andamento: AndamentoKontino | null; conta: ContaKontino | null }

/**
 * Abre (ou retoma) a conta Kontino do seller aprovado. Seguro para chamar de
 * novo a qualquer momento: cada passo confere o que já foi feito.
 */
export async function abrirKontinoAposAprovacao(
  sellerId: string,
  deps: { storage?: Pick<StorageService, 'getSignedDocumentUrl'>; agora?: Date } = {},
): Promise<ResultadoAbertura> {
  const agora = deps.agora ?? new Date()
  const storage = deps.storage ?? new StorageService()
  const s = await seller(sellerId)
  const cad = cadastroV2(s?.config)
  if (!s || !cad || s.status !== 'active') return { andamento: null, conta: null }
  const anterior: AndamentoKontino | null = s.config?.cadastro_kontino ?? null
  const tentativas = (anterior?.tentativas ?? 0) + 1

  if (!kontinoConfigurado()) {
    // Sem a chave da Kontino: fica na fila e a varredura retoma quando ela entrar.
    return { andamento: await marcar(sellerId, { etapa: 'abrindo', tentativas: anterior?.tentativas ?? 0, proxima_tentativa: null, motivo: 'kontino_nao_configurada' }, agora), conta: null }
  }

  try {
    let conta: ContaKontino | null = null
    const ja: string | undefined = s.config?.kontino?.connection_id
    if (ja) {
      conta = await buscarContaKontino(ja)
      if (conta.status === 'disconnected') conta = null
    }

    const chave = chaveDaEmpresa(cad.envio.country, documentoDoEnvio(cad.envio))
    if (!conta && chave && cad.envio.type === 'business') conta = await conexaoDaMesmaEmpresa(sellerId, chave)

    if (!conta) {
      try {
        conta = await criarContaKontino({
          sellerId,
          email: String(s.email ?? '').trim().toLowerCase(),
          nome: nomeDoEnvio(cad.envio) || s.name,
          tipo: cad.envio.type,
          pais: cad.envio.country,
          documento: documentoDoEnvio(cad.envio),
        })
      } catch (err) {
        if (!(err instanceof ErroKontino) || err.status !== 409) throw err
        const existente = typeof err.dados?.existing_account === 'string' ? err.dados.existing_account : null
        conta = existente ? await buscarContaKontino(existente) : await contaKontinoPorSeller(sellerId, err.message)
        if (!conta) throw err
      }
    }
    await guardarConta(sellerId, conta)

    const empresa = conta.existing_company?.status
    if (conta.status === 'pending' && (empresa === 'rejected' || empresa === 'closed')) {
      return { andamento: await marcar(sellerId, { etapa: 'equipe', tentativas, proxima_tentativa: null, motivo: `empresa_${empresa}_na_kontino` }, agora), conta }
    }

    if (precisaDoCadastro(conta)) {
      try {
        conta = await enviarVerificacaoKontino(conta.id, await corpoDaVerificacao(cad, storage))
        await guardarConta(sellerId, conta)
      } catch (err) {
        if (!(err instanceof ErroKontino) || err.code !== 'verification_already_submitted') throw err
      }
    }
    return { andamento: await marcar(sellerId, { etapa: 'pronto', tentativas, proxima_tentativa: null, motivo: null }, agora), conta }
  } catch (err: any) {
    const status = err instanceof ErroKontino ? err.status : 0
    const motivo = err instanceof ErroKontino ? `${err.code}: ${err.message}` : String(err?.message ?? err)
    console.error(`[kontino-aprovacao] seller ${sellerId} (tentativa ${tentativas}): ${motivo}`)
    // Dado recusado pela Kontino (4xx, menos limite de requisições): a equipe resolve com o seller.
    if (status >= 400 && status < 500 && status !== 429 && !(err instanceof ErroKontino && err.code === 'not_configured')) {
      return { andamento: await marcar(sellerId, { etapa: 'equipe', tentativas, proxima_tentativa: null, motivo: motivo.slice(0, 500) }, agora), conta: null }
    }
    return {
      andamento: await marcar(sellerId, { etapa: 'erro', tentativas, proxima_tentativa: proximaTentativa(tentativas, agora).toISOString(), motivo: motivo.slice(0, 500) }, agora),
      conta: null,
    }
  }
}

/** Cadastro único sem conta Kontino ativa: os repasses ficam retidos na Koopfy. */
export async function repasseRetido(sellerId: string): Promise<boolean> {
  const { data, error } = await supabase.from('seller_profiles').select('config').eq('id', sellerId).maybeSingle()
  if (error) throw new Error(`seller_profiles: ${error.message}`)
  const config = (data?.config as Record<string, any>) ?? null
  return !!cadastroV2(config) && !config?.kontino_account_id
}

/** Marca o seller recém-aprovado como "abrindo" e dispara a abertura em segundo plano. */
export async function iniciarAberturaAposAprovacao(sellerId: string): Promise<void> {
  const s = await seller(sellerId)
  if (!s || !cadastroV2(s.config)) return
  await marcar(sellerId, { etapa: 'abrindo', tentativas: 0, proxima_tentativa: null, motivo: null })
  void abrirKontinoAposAprovacao(sellerId).catch((e) => console.error(`[kontino-aprovacao] seller ${sellerId}:`, e?.message))
}

/** Sellers aprovados com a abertura pendente cuja vez chegou. */
export async function aberturasPendentes(agora = new Date(), limite = 20): Promise<string[]> {
  const { data, error } = await supabase
    .from('seller_profiles')
    .select('id, config')
    .eq('status', 'active')
    .in('config->cadastro_kontino->>etapa', ['abrindo', 'erro'])
    .limit(200)
  if (error) throw new Error(`seller_profiles (aberturas): ${error.message}`)
  return (data ?? [])
    .filter((r: any) => {
      const p = r.config?.cadastro_kontino?.proxima_tentativa
      return !p || new Date(p).getTime() <= agora.getTime()
    })
    .slice(0, limite)
    .map((r: any) => r.id)
}

@Injectable()
export class KontinoAprovacaoCron {
  private readonly log = new Logger('KontinoAprovacao')
  private rodando = false

  @Cron('*/5 * * * *')
  async varrer() {
    if (this.rodando || !kontinoConfigurado() || process.env.KONTINO_ABERTURA_AUTOMATICA === 'off') return
    this.rodando = true
    try {
      for (const id of await aberturasPendentes()) {
        const r = await abrirKontinoAposAprovacao(id)
        this.log.log(`seller ${id}: ${r.andamento?.etapa ?? 'sem cadastro v2'}`)
      }
    } catch (e: any) {
      this.log.warn(`varredura: ${e?.message}`)
    } finally {
      this.rodando = false
    }
  }
}
