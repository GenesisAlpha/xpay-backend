#!/usr/bin/env node
/* ============================================================================
 * Parser de dinheiro em texto livre — casos de mesa
 * ----------------------------------------------------------------------------
 * ⚠️ POR QUE ISTO PRECISA DE TESTE PRÓPRIO.
 * No caminho fal (any-llm) NÃO existe schema imposto pela API: o modelo devolve
 * texto, e `validarExtracao` é a ÚNICA coisa entre esse texto e uma decisão de
 * pagamento. O valor é a porta mais forte do validador — se ele for lido
 * errado, todo o resto do desenho não vale nada.
 *
 * Duas convenções opostas convivem nos comprovantes mexicanos:
 *   "1,247.63" → vírgula é milhar    "1.247,63" → ponto é milhar
 * A regra que desempata é contar os dígitos DEPOIS do último separador:
 * exatamente 3 = milhar, 1 ou 2 = decimal. Dinheiro não tem 3 casas decimais.
 *
 * Rodar:
 *   npx tsc -p tsconfig.json --outDir dist-test --noEmit false
 *   node ops/test-spei-money-parser.js
 * ========================================================================== */

process.env.SUPABASE_URL='http://localhost'; process.env.SUPABASE_KEY='x'
const path = require('path')
const { SpeiReceiptService } = require(
  path.join(__dirname, '..', 'dist-test', 'orchestrator', 'clip', 'spei-receipt.service'))
const s = new SpeiReceiptService({})
const casos = [
  ['numero normal',        1247.63,            1247.63],
  ['US: 1,247.63',         '1,247.63',         1247.63],
  ['US com simbolos',      '$ 1,247.63 MXN',   1247.63],
  ['ES: 1.247,63',         '1.247,63',         1247.63],
  ['milhar so: 1,247',     '1,247',            1247],
  ['milhar so: 1.247',     '1.247',            1247],
  ['sem separador',        '99',               99],
  ['duas casas',           '399.00',           399],
  ['MP sem decimais',      '$ 99 MXN',         99],
  ['ilegivel',             'ilegible',         null],
  ['vazio',                '',                 null],
  ['null',                 null,               null],
  ['NaN',                  NaN,                null],
]
let f=0
for (const [n, v, esp] of casos) {
  const r = s.validarExtracao({ monto: v }).monto
  const ok = r === esp; if(!ok) f++
  console.log(`${ok?'ok   ':'FALHA'} ${n.padEnd(20)} ${String(v).padEnd(18)} -> ${r}`)
}
console.log(f===0?'\n13/13 OK':`\n${f} FALHA(S)`); process.exit(f?1:0)
