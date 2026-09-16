// src/crm/checkout-internal.ts
// ─── Canal interno com o checkout ─────────────────────────────────────────────
//
// A esteira logística (produtos, fila, carteira do parceiro), os pedidos e agora
// a visão administrativa de sellers e lojas vivem no banco do CHECKOUT. O CRM é
// a TELA onde o gestor decide, mas não é o dono do dado — copiar isso pra cá
// obrigaria o painel a uma chamada cross-service por linha.
//
// Por isso: o CRM lê e grava lá, via segredo compartilhado.
//
// Mora em módulo próprio (e não dentro do CrmService) porque mais de um serviço
// do CRM fala com esse canal, e todos precisam compartilhar o MESMO
// `lastCheckoutFailure` — é ele que faz a tela culpar a causa certa.

/**
 * Último motivo REAL de falha, para a tela não culpar a chave quando o problema
 * é outro. O helper continua devolvendo null (as telas do CRM não podem cair
 * quando o checkout oscila), mas assim dá pra dizer o que aconteceu.
 */
let lastCheckoutFailure: string | null = null

/**
 * Lidos por chamada, não no import: em produção o valor não muda, mas assim o
 * módulo não congela a configuração no instante em que é carregado.
 */
function checkoutBase(): string {
  return process.env.CHECKOUT_API_BASE ?? 'http://127.0.0.1:3006'
}

function checkoutKey(): string {
  return process.env.CHECKOUT_INTERNAL_KEY ?? ''
}

/** Mensagem de erro que aponta a causa provável, não um palpite fixo. */
export function checkoutFailureMessage(acao: string): string {
  const causa = lastCheckoutFailure ?? 'motivo desconhecido'
  return `Não foi possível ${acao}: ${causa} (checkout em ${checkoutBase()}).`
}

/** GET quando não há corpo; POST quando há. Falha nunca estoura: devolve null. */
export async function checkoutInternal<T>(path: string, body?: any): Promise<T | null> {
  const key = checkoutKey()
  if (!key) {
    lastCheckoutFailure = 'CHECKOUT_INTERNAL_KEY não configurada no serviço de pagamentos'
    console.error('[CrmService] CHECKOUT_INTERNAL_KEY não configurada')
    return null
  }
  try {
    const res = await fetch(`${checkoutBase()}/internal/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      const corpo = await res.text()
      lastCheckoutFailure = res.status === 401 || res.status === 403
        ? `o checkout recusou a chave interna (HTTP ${res.status}) — confira CHECKOUT_INTERNAL_KEY aqui e INTERNAL_API_KEY lá`
        : `o checkout respondeu HTTP ${res.status}`
      console.error(`[CrmService] checkout ${path}: ${res.status} ${corpo}`)
      return null
    }
    lastCheckoutFailure = null
    return (await res.json()) as T
  } catch (e: any) {
    // Falha de comunicação não pode derrubar a ficha do seller no CRM.
    const msg = String(e?.message ?? e)
    lastCheckoutFailure = /timeout|abort/i.test(msg)
      ? 'o checkout não respondeu a tempo (8s)'
      : `não foi possível conectar ao checkout (${msg})`
    console.error(`[CrmService] checkout ${path}:`, msg)
    return null
  }
}
