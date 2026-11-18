import type { MetodoKontino } from './kontino'

/**
 * O que cada trilho da Kontino exige do comprador, conferido antes de chamar a
 * API (a mensagem chega ao comprador, por isso em espanhol nos trilhos de
 * Argentina e Colômbia). null = tudo certo.
 */
export function dadosDoPagadorKontino(
  metodo: MetodoKontino,
  dto: { customer?: { document?: string | null; phone?: string | null } | null; payment_data?: { phone?: string | null; bankCode?: string | null; documentType?: string | null } | null },
): string | null {
  const documento = String(dto.customer?.document ?? '').trim()
  if (metodo === 'transfers_ar') {
    return cuitValido(documento) ? null : 'Ingresá un CUIT/CUIL válido para pagar por transferencia.'
  }
  if (metodo === 'pse') {
    const tipo = String(dto.payment_data?.documentType ?? '').toUpperCase()
    if (!TIPOS_PSE.has(tipo)) return 'Elegí el tipo de documento para pagar con PSE.'
    const limpo = tipo === 'PASS' || tipo === 'PEP' ? documento.replace(/[^A-Za-z0-9]/g, '') : documento.replace(/\D/g, '')
    if (limpo.length < 5) return 'Ingresá el número de documento para pagar con PSE.'
    if (!String(dto.payment_data?.bankCode ?? '').trim()) return 'Elegí tu banco para pagar con PSE.'
    const celular = String(dto.customer?.phone ?? dto.payment_data?.phone ?? '').replace(/\D/g, '')
    const ok = (celular.length === 10 && celular.startsWith('3')) || (celular.length === 12 && celular.startsWith('573'))
    if (!ok) return 'Ingresá un celular colombiano (+57 3XX XXX XXXX) para pagar con PSE.'
  }
  return null
}

/** Tipos de documento aceitos pelo PSE. */
export const TIPOS_PSE = new Set(['CC', 'CE', 'NIT', 'PASS', 'PEP'])

/** CUIT/CUIL argentino: 11 dígitos com dígito verificador (mod 11). */
export function cuitValido(v: string): boolean {
  const d = String(v ?? '').replace(/\D/g, '')
  if (d.length !== 11) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const soma = pesos.reduce((s, p, i) => s + p * Number(d[i]), 0)
  let dv = 11 - (soma % 11)
  if (dv === 11) dv = 0
  if (dv === 10) dv = 9
  return dv === Number(d[10])
}
