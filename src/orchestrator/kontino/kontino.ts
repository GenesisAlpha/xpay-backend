import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * KONTINO CONNECT como provedor de métodos locais da Koopfy.
 *
 * A Koopfy é parceira do Kontino Connect no modelo de CONTAS CONECTADAS: a
 * cobrança sai pela API do Kontino com a chave da plataforma
 * (KONTINO_SECRET_KEY), SEMPRE em nome da conta Kontino do próprio seller
 * (seller.config.kontino_account_id), o comprador paga no trilho local e o
 * Kontino avisa por webhook assinado (POST /webhook/kontino). Diferente do SPEI
 * da Clip, não há comprovante: cada cobrança tem a própria CLABE e a
 * confirmação é automática.
 *
 * Sem conta conectada o Kontino NÃO é usado: receber em nome de um seller na
 * conta da Koopfy é "nesting" e a BlindPay recusa (blindpay.com/docs/kb/nested-payments).
 * O dinheiro cai na conta do seller; a comissão da Koopfy vai em
 * `application_fee_amount` (centavos de USD) e a venda não entra na carteira da
 * Koopfy (ver isKontinoOwnAccountId).
 *
 * Variáveis: KONTINO_API_URL (padrão produção), KONTINO_SECRET_KEY (sk_live_ ou
 * sk_test_), KONTINO_WEBHOOK_SECRET (whsec_ do endpoint cadastrado no painel).
 */

export const KONTINO_METODOS = {
  spei: { moeda: 'MXN' },
  pix: { moeda: 'BRL' },
} as const
export type MetodoKontino = keyof typeof KONTINO_METODOS

export const ehMetodoKontino = (m: string): m is MetodoKontino => m in KONTINO_METODOS

export type CobrancaKontino = {
  id: string
  status: 'pending' | 'paid' | 'expired' | 'canceled'
  method: string
  amount: number
  currency: string
  reference: string
  instructions: { type: 'clabe' | 'cvu' | 'pix'; clabe?: string | null; copy_paste?: string | null; reference?: string; bank?: string | null; beneficiary?: string | null }
  expires_at: string
  settlement?: { gross: number; fee: number; net: number; fx_rate: number } | null
}

export class ErroKontino extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Campos extras do erro (ex.: `existing_account` no 409 de empresa já conectada). */
    readonly dados: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

/** provider_account_id de venda na conta Kontino do seller: fora da carteira da Koopfy. */
const PREFIXO_CONTA = 'kontino:'
export const toKontinoOwnAccountId = (contaKontino: string) => `${PREFIXO_CONTA}${contaKontino}`
export const isKontinoOwnAccountId = (id: string | null | undefined): boolean => typeof id === 'string' && id.startsWith(PREFIXO_CONTA)

const base = () => (process.env.KONTINO_API_URL?.trim() || 'https://api.kontino.co/api/kontino/v1').replace(/\/+$/, '')

export const kontinoConfigurado = () => !!process.env.KONTINO_SECRET_KEY?.trim()

async function chamar<T>(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown, idempotencia?: string): Promise<T> {
  const chave = process.env.KONTINO_SECRET_KEY?.trim()
  if (!chave) throw new ErroKontino(500, 'not_configured', 'KONTINO_SECRET_KEY não configurada.')
  const r = await fetch(`${base()}${caminho}`, {
    method: metodo,
    headers: {
      authorization: `Bearer ${chave}`,
      'content-type': 'application/json',
      'user-agent': 'Koopfy-Pay/1.0',
      ...(idempotencia ? { 'idempotency-key': idempotencia } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const texto = await r.text()
  let json: any = null
  try {
    json = texto ? JSON.parse(texto) : null
  } catch {
    /* corpo não-JSON */
  }
  if (!r.ok) {
    const erro = json?.error && typeof json.error === 'object' ? json.error : {}
    throw new ErroKontino(r.status, erro.code ?? 'kontino_error', erro.message ?? `Kontino respondeu ${r.status}.`, erro)
  }
  return json as T
}

/** Cria a cobrança. A chave de idempotência é o id da transação: reenvio não duplica. */
export async function criarCobranca(i: {
  transactionId: string
  metodo: MetodoKontino
  valorMinor: number
  moeda: string
  referencia?: string | null
  comprador?: { nome?: string | null; email?: string | null; documento?: string | null }
  /** Conta Kontino do seller (acct_…). Obrigatória: sem ela não há cobrança. */
  contaConectada: string
  /** Comissão da Koopfy em centavos de USD, tirada da conta do seller quando paga. */
  comissaoUsdCents?: number | null
}) {
  if (!i.contaConectada) throw new ErroKontino(400, 'account_required', 'Seller sem conta Kontino conectada.')
  // A API aceita referência de 4 a 30 caracteres (letras, números e hífen).
  const ref = String(i.referencia ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 30)
  const referencia = ref.length >= 4 ? ref : null
  const email = i.comprador?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.comprador.email) ? i.comprador.email : null
  const pagador = {
    ...(i.comprador?.nome ? { name: i.comprador.nome.slice(0, 140) } : {}),
    ...(email ? { email: email.slice(0, 200) } : {}),
    ...(i.comprador?.documento && i.comprador.documento !== 'N/A' ? { tax_id: i.comprador.documento.replace(/\D/g, '').slice(0, 20) } : {}),
  }
  return chamar<CobrancaKontino>(
    'POST',
    '/collections',
    {
      amount: i.valorMinor,
      currency: i.moeda.toUpperCase(),
      method: i.metodo,
      ...(referencia ? { reference: referencia } : {}),
      ...(Object.keys(pagador).length ? { payer: pagador } : {}),
      account: i.contaConectada,
      ...(i.comissaoUsdCents && i.comissaoUsdCents >= 1 ? { application_fee_amount: Math.round(i.comissaoUsdCents) } : {}),
      metadata: { koopfy_transaction_id: i.transactionId },
    },
    `koopfy-${i.transactionId}`,
  )
}

export const buscarCobranca = (id: string) => chamar<CobrancaKontino>('GET', `/collections/${encodeURIComponent(id)}`)

/** Confere `Kontino-Signature: t=…,v1=…` (HMAC-SHA256 de `${t}.${corpo}`), com tolerância de 5 minutos. */
export function assinaturaKontinoValida(segredo: string, corpo: string, cabecalho: string | undefined, toleranciaSeg = 300, agora = Date.now()): boolean {
  if (!cabecalho) return false
  const partes = Object.fromEntries(
    cabecalho.split(',').map((p) => {
      const i = p.indexOf('=')
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()]
    }),
  )
  const t = Number(partes.t)
  if (!t || !partes.v1 || Math.abs(agora / 1000 - t) > toleranciaSeg) return false
  const esperado = createHmac('sha256', segredo).update(`${t}.${corpo}`).digest('hex')
  const a = Buffer.from(esperado)
  const b = Buffer.from(String(partes.v1))
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Resposta ao checkout no mesmo formato dos outros provedores (SPEI e Pix). */
export function respostaAoCheckout(transactionId: string, c: CobrancaKontino, valorMinor: number) {
  if (c.method === 'spei') {
    return {
      success: true,
      status: 'pending',
      transactionId,
      provider: 'kontino',
      spei: {
        // O checkout exige um id de reserva; aqui é a própria cobrança (CLABE exclusiva).
        reservationId: c.id,
        clabe: c.instructions.clabe ?? null,
        banco: c.instructions.bank ?? 'SPEI',
        beneficiario: c.instructions.beneficiary ?? 'Kontino',
        chargeMinor: valorMinor,
        expiresAt: c.expires_at,
        referencia: c.instructions.reference ?? c.reference,
        // Sem comprovante: a confirmação chega sozinha pelo webhook.
        automatico: true,
      },
    }
  }
  return {
    success: true,
    status: 'pending',
    transactionId,
    provider: 'kontino',
    pix: { copyPaste: c.instructions.copy_paste ?? null, qrcode: null, expiration: c.expires_at },
  }
}

// ─── Contas conectadas (a conta Kontino de cada seller) ──────────────────────
//
// A Koopfy cria a conta conectada do seller na API do Kontino e pede um link:
// o seller abre a conta Kontino (KYB próprio, que é o que evita o nesting) ou
// liga uma conta Kontino que já tem. Com a conta aprovada a conexão fica
// "active" e só então as cobranças saem em nome dela.

export type StatusContaKontino = 'pending' | 'active' | 'rejected' | 'disconnected' | string

export type ContaKontino = {
  id: string
  status: StatusContaKontino
  type: 'individual' | 'business'
  country: string
  email: string
  name: string | null
  external_id: string | null
  /** onboarding (conta nova) | connect_existing (já tinha conta Kontino) */
  connection_type: 'onboarding' | 'connect_existing' | string
  capabilities?: Record<string, string>
  requirements?: unknown
  /** A empresa (país + documento fiscal) já tinha conta Kontino: só o status, sem dados dela. */
  existing_company?: { status: 'active' | 'verifying' | 'action_required' | 'rejected' | 'closed' | string } | null
}

export type LinkDaContaKontino = { url: string; expires_at: string; type: string; account: string }

export function criarContaKontino(i: {
  sellerId: string
  email: string
  nome?: string | null
  tipo: 'individual' | 'business'
  pais: string
  retorno?: string | null
  /** Documento fiscal da empresa: a Kontino confere se a empresa já tem conta antes de abrir outra. */
  documento?: string | null
}) {
  return chamar<ContaKontino>(
    'POST',
    '/accounts',
    {
      email: i.email,
      ...(i.nome ? { name: i.nome.slice(0, 140) } : {}),
      type: i.tipo,
      country: i.pais.toUpperCase(),
      ...(i.tipo === 'business' && i.documento ? { tax_id: i.documento } : {}),
      external_id: i.sellerId,
      metadata: { koopfy_seller_id: i.sellerId },
      ...(i.retorno ? { return_url: i.retorno } : {}),
      // O seller usa a Kontino também como banco (saldo, saques, cartão).
      dashboard: 'kontino',
    },
    `koopfy-seller-${i.sellerId}-${i.pais.toUpperCase()}-${i.tipo}`,
  )
}

export const buscarContaKontino = (id: string) => chamar<ContaKontino>('GET', `/accounts/${encodeURIComponent(id)}`)

/**
 * A conta que o Kontino já tem para este seller (external_id = id do seller).
 * O 409 de "já existe" traz o id na mensagem; sem ele, procura nas contas do
 * parceiro, página a página.
 */
export async function contaKontinoPorSeller(sellerId: string, mensagem409?: string | null): Promise<ContaKontino | null> {
  const doErro = mensagem409?.match(/\bacct_[A-Za-z0-9]+/)?.[0]
  if (doErro) return buscarContaKontino(doErro)
  let depois: string | null = null
  for (let pagina = 0; pagina < 50; pagina++) {
    const r: { data: ContaKontino[]; has_more?: boolean } = await chamar('GET', `/accounts?limit=100${depois ? `&starting_after=${encodeURIComponent(depois)}` : ''}`)
    const achada = (r?.data ?? []).find((c) => c.external_id === sellerId)
    if (achada) return achada
    if (!r?.has_more || !r.data?.length) return null
    depois = r.data[r.data.length - 1].id
  }
  return null
}

export function linkDaContaKontino(id: string, retorno?: string | null) {
  return chamar<LinkDaContaKontino>('POST', `/accounts/${encodeURIComponent(id)}/onboarding_links`, retorno ? { return_url: retorno } : {})
}

/**
 * Envia à Kontino o cadastro (KYC/KYB) que o seller já fez na Koopfy, com a
 * evidência do aceite dos termos. A Kontino baixa os arquivos (URLs https
 * temporárias) e cuida da verificação no banco parceiro.
 */
export function enviarVerificacaoKontino(
  id: string,
  corpo: {
    type: 'individual' | 'business'
    business?: Record<string, unknown>
    individual?: Record<string, unknown>
    tos: { accepted_at: string; ip_address: string; user_agent: string }
  },
) {
  return chamar<ContaKontino>('POST', `/accounts/${encodeURIComponent(id)}/verification`, corpo)
  // Sem chave de idempotência: o próprio endpoint recusa um segundo envio (409), e uma
  // tentativa que falhou no banco parceiro precisa poder ser refeita.
}
