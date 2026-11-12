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
  if (!r.ok) throw new ErroKontino(r.status, json?.error?.code ?? 'kontino_error', json?.error?.message ?? `Kontino respondeu ${r.status}.`)
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
