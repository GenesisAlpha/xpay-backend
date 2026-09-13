#!/usr/bin/env node
/* ============================================================================
 * Regras de decisão do comprovante SPEI — suite de regressão
 * ----------------------------------------------------------------------------
 * Duas metades, e as duas são necessárias:
 *
 *   REAIS        — 8 comprovantes observados em produção (BBVA, Banorte x3,
 *                  Banamex, Mercado Pago, Santander). Protegem contra APERTAR
 *                  demais. A primeira versão destas regras aprovava 1 de 8:
 *                  reprovava pagamento legítimo de banco grande e mandava tudo
 *                  para fila humana, o que desliga a automação na prática.
 *   ADVERSARIAIS — protegem contra AFROUXAR. Vieram depois de cada correção
 *                  feita para os reais passarem.
 *
 * Rodar (sem chave de API — `avaliar()` é código puro de propósito):
 *   npx tsc -p tsconfig.json --outDir dist-test --noEmit false
 *   node ops/test-spei-receipt-rules.js
 *
 * ⚠️ Ao mexer em avaliar(), rode isto. Afrouxar aqui não quebra build nem teste
 * nenhum — só libera produto sem pagamento. Apertar não quebra nada tampouco —
 * só afoga a operação em revisão manual.
 *
 * Claves de rastreo tiveram os últimos dígitos alterados. Nenhum dado de
 * comprador aparece aqui: só campos do lado DESTINO, que são das nossas contas.
 * ========================================================================== */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x'

const path = require('path')
const { SpeiReceiptService } = require(
  path.join(__dirname, '..', 'dist-test', 'orchestrator', 'clip', 'spei-receipt.service'))

const svc = new SpeiReceiptService()

// A janela agora é "últimas 24h a partir de agora", então as datas dos casos
// são relativas ao momento do teste. Formato local sem fuso, como os
// comprovantes reais trazem — o serviço interpreta como America/Mexico_City.
const HORAS = (h) => {
  // O serviço lê a string como hora de CDMX e SOMA 6h para chegar em UTC.
  // Então, para representar "h horas atrás" de verdade, a string precisa
  // estar 6h ATRÁS do instante alvo — subtrai, não soma.
  const d = new Date(Date.now() - h * 3600000 - 6 * 3600000)
  return d.toISOString().slice(0, 19)
}

const CONTAS = {
  a5869: { clabe: '646180000000005869', beneficiario: 'Rosa Angelica Carbajal Chavez' },
  a7807: { clabe: '646180000000007807', beneficiario: 'Rosa Angelica Carbajal Chavez' },
  a4573: { clabe: '646180000000004573', beneficiario: 'Laura Olvera' },
}

const ok = (over) => ({
  es_comprobante: true, tipo_documento: 'comprobante_spei',
  monto: 399.00, moneda: null, clabe_destino: '5869',
  beneficiario: 'Tik Tok Shop', banco_destino: 'Cuenta Clip', banco_emisor: 'BBVA',
  fecha_hora: HORAS(2), fecha_hora_texto: '19 agosto 2026 23:47 h',
  clave_rastreo: 'MBAN01002608200087260000', referencia: '0087269760',
  estado_declarado: null, senales_de_edicion: [], confianza_lectura: 0.97,
  observaciones: null, ...over,
})

// ── Comprovantes REAIS observados ───────────────────────────────────────────
const REAIS = [
  ['BBVA · comprobante', 'a5869', 39900, ok({
    monto: 399.00, beneficiario: 'Breah', banco_destino: 'Cuenta CLIP', banco_emisor: 'BBVA' }), 'approved'],
  // Banorte parte a clave de rastreo em duas linhas; o prompt manda juntar sem espaço.
  ['Banorte Dimo · claro', 'a5869', 20900, ok({
    monto: 209.00, banco_emisor: 'Banorte', estado_declarado: 'Transferencia exitosa',
    fecha_hora: HORAS(2), confianza_lectura: 0.90 }), 'approved'],
  // Banamex mascara a conta destino com TRÊS dígitos: "**869".
  ['Banamex · 3 digitos', 'a5869', 20900, ok({
    monto: 209.00, moneda: 'MXN', clabe_destino: '869', beneficiario: 'tiktok',
    banco_destino: 'Clip • TIKTOK SHOP', banco_emisor: 'Banamex',
    fecha_hora: HORAS(2), clave_rastreo: '085907560424320000' }), 'approved'],
  ['Banorte Dimo · modo escuro', 'a5869', 74900, ok({
    monto: 749.00, beneficiario: 'TikTok Shop', banco_emisor: 'Banorte',
    fecha_hora: HORAS(2), confianza_lectura: 0.93 }), 'approved'],
  // Mercado Pago exibe "$ 99 MXN" — sem os centavos quando são zero.
  ['Mercado Pago · sem decimais', 'a5869', 9900, ok({
    monto: 99, moneda: 'MXN', beneficiario: 'TikTok Shop', banco_destino: 'Clip',
    banco_emisor: 'Mercado Pago', fecha_hora: HORAS(2),
    clave_rastreo: null, referencia: '173780053507' }), 'approved'],
  // Banorte escreve "MN" (moneda nacional), não "MXN", e esconde a clave.
  ['Banorte app · moeda MN', 'a7807', 49600, ok({
    monto: 496.00, moneda: 'MN', clabe_destino: '7807', beneficiario: 'CLIP',
    banco_destino: null, banco_emisor: 'Banorte', fecha_hora: HORAS(2),
    clave_rastreo: null, referencia: null,
    estado_declarado: '¡Tu transferencia fue exitosa!' }), 'approved'],
  ['Banorte app · 269', 'a7807', 26900, ok({
    monto: 269.00, moneda: 'MN', clabe_destino: '7807', beneficiario: 'CLIP',
    banco_destino: null, banco_emisor: 'Banorte', fecha_hora: HORAS(2),
    clave_rastreo: null, estado_declarado: '¡Tu transferencia fue exitosa!' }), 'approved'],
  // Reenviado por WhatsApp: o frame do app NÃO é sinal de edição (ver prompt).
  ['Santander · via WhatsApp', 'a4573', 44900, ok({
    monto: 449.00, moneda: 'MXN', clabe_destino: '4573', beneficiario: 'Laura Olvera',
    banco_destino: 'Clip', banco_emisor: 'Santander', fecha_hora: HORAS(2),
    clave_rastreo: null, referencia: '2505078', estado_declarado: 'Exitosa' }), 'approved'],
]

// ── Adversariais ────────────────────────────────────────────────────────────
const ADVERSARIAIS = [
  // Os centavos únicos por pedido são a chave de conciliação. Sem eles,
  // qualquer comprovante de $399 aprovaria qualquer pedido de $399.
  ['centavo a menos (pesos batem)', 'a5869', 39963, ok({ monto: 399.00 }), 'review'],
  ['centavo a mais', 'a5869', 39963, ok({ monto: 399.64 }), 'rejected'],
  ['peso completamente diferente', 'a5869', 39900, ok({ monto: 1399.00 }), 'rejected'],
  ['valor ilegivel', 'a5869', 39900, ok({ monto: null }), 'rejected'],

  // Captura de saldo real não tem conta destino nem valor de transferência.
  ['captura de saldo', 'a5869', 39900, ok({
    tipo_documento: 'captura_de_saldo', es_comprobante: false,
    monto: null, clabe_destino: null }), 'rejected'],
  ['documento que nao e comprovante', 'a5869', 39900, ok({
    es_comprobante: false, monto: null, clabe_destino: null,
    fecha_hora: null }), 'rejected'],

  // ⚠️ AGENDAMENTO: valor certo, conta certa, dinheiro NÃO saiu. Quem pega é a
  // janela de 24h — a data de uma transferência agendada está no FUTURO.
  ['transferencia agendada (data futura)', 'a5869', 39900, ok({
    fecha_hora: HORAS(-72), estado_declarado: 'Programada' }), 'review'],

  ['conta destino de terceiro', 'a5869', 39900, ok({ clabe_destino: '1234' }), 'review'],
  // Pagou uma conta Clip NOSSA, mas não a que a reserva debitou. Aprovar aqui
  // corromperia o occupied_minor das duas contas e, com ele, a deriva no saque.
  ['conta Clip errada', 'a5869', 39900, ok({ clabe_destino: '7807' }), 'review'],

  ['comprovante de 3 dias atras', 'a5869', 39900, ok({ fecha_hora: HORAS(72) }), 'review'],
  ['comprovante de 25h atras', 'a5869', 39900, ok({ fecha_hora: HORAS(25) }), 'review'],
  ['sem data', 'a5869', 39900, ok({ fecha_hora: null }), 'review'],

  ['leitura ruim', 'a5869', 39900, ok({ confianza_lectura: 0.4 }), 'review'],
  // 399 USD != 399 MXN — perda de ~20x se aprovar.
  ['moeda estrangeira', 'a5869', 39900, ok({ moneda: 'USD' }), 'review'],

  // ── Deixaram de barrar de propósito (ficam registrados, não decidem) ──────
  ['sinais de edicao (so registra)', 'a5869', 39900, ok({
    senales_de_edicion: ['tipografia inconsistente no importe'] }), 'approved'],
  ['beneficiario estranho (so registra)', 'a5869', 39900, ok({
    beneficiario: 'Juan Perez', banco_destino: 'BBVA' }), 'approved'],
]

function rodar(titulo, casos) {
  console.log(`\n── ${titulo} ─────────────────────────────`)
  let fail = 0
  for (const [nome, contaKey, chargeMinor, ext, esperado] of casos) {
    const c = CONTAS[contaKey]
    // A janela não olha mais o created_at da reserva — só "últimas 24h".
    const created = new Date(Date.now() - 30 * 60000).toISOString()
    const r = svc.avaliar(ext, {
      charge_minor: chargeMinor, currency: 'MXN',
      clabe: c.clabe, beneficiario: c.beneficiario, created_at: created,
    })
    const passou = r.verdict === esperado
    if (!passou) fail++
    console.log(`${passou ? 'ok   ' : 'FALHA'} ${nome.padEnd(32)} -> ${r.verdict.padEnd(9)} (esperado ${esperado})`)
    if (!passou) console.log(`        ${r.reasons.join(' | ')}`)
  }
  return fail
}

const falhas = rodar('COMPROVANTES REAIS (nao apertar)', REAIS)
             + rodar('ADVERSARIAIS (nao afrouxar)', ADVERSARIAIS)
const total = REAIS.length + ADVERSARIAIS.length
console.log(falhas === 0 ? `\n${total}/${total} passaram` : `\n${falhas} FALHA(S) de ${total}`)
process.exit(falhas === 0 ? 0 : 1)
