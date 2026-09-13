#!/usr/bin/env node
/* ============================================================================
 * Eval do extrator de comprovante — chamada REAL ao fal, contra fixtures reais
 * ----------------------------------------------------------------------------
 * POR QUE ISTO EXISTE. `test-spei-receipt-rules.js` prova a DECISÃO (código
 * puro). Isto prova a EXTRAÇÃO — a metade que depende do modelo e que nenhum
 * teste offline alcança. Sem rodar isto contra comprovantes reais, a escolha de
 * modelo é aposta.
 *
 * USO:
 *   1) Ponha os comprovantes em ops/fixtures-spei/  (png, jpg, webp ou pdf)
 *   2) Para cada um, um .json ao lado com o gabarito — só os campos que você
 *      quer conferir. Ex.: recibo-bbva.png + recibo-bbva.json
 *        { "monto": 1399.47, "clabe_destino": "5869", "moneda": null }
 *   3) node ops/eval-spei-fal.js [modelo1,modelo2,...]
 *
 * Precisa de FAL_KEY no .env. GASTA DINHEIRO REAL: uma chamada por fixture por
 * modelo. Com 8 fixtures e 4 modelos são 32 chamadas (~US$0,20).
 *
 * ⚠️ Os fixtures são comprovantes reais: dado pessoal e financeiro. O diretório
 * está no .gitignore de propósito. Não commite.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const DIR = path.join(__dirname, 'fixtures-spei');
const MODELOS = (process.argv[2] ?? 'anthropic/claude-sonnet-4.5,anthropic/claude-haiku-4.5,google/gemini-2.5-flash').split(',');
const BRL = Number(process.env.USD_BRL ?? 6.10);

const env = fs.readFileSync(path.join(RAIZ, '.env'), 'utf8');
const KEY = (env.match(/^FAL_KEY=(.+)$/m) || [])[1];
if (!KEY) { console.error('FAL_KEY ausente no .env'); process.exit(1); }

// Lê prompt e schema DO CÓDIGO, não de uma cópia: um eval que testa um prompt
// diferente do que roda em produção mede a coisa errada.
const src = fs.readFileSync(path.join(RAIZ, 'src/orchestrator/clip/spei-receipt.service.ts'), 'utf8');
const SYSTEM = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];
const props = eval('(' + src.match(/const EXTRACTION_SCHEMA = ([\s\S]*?)\} as const;/)[1].replace(/\bas const\b/, '') + '})').properties;

// ⚠️ COMPARA COMO O CÓDIGO COMPARA, NÃO POR IGUALDADE DE STRING.
// `avaliar()` normaliza antes de decidir: a conta destino perde tudo que não é
// dígito ("-5869" → "5869") e a moeda perde tudo que não é letra ("$" → sem
// código declarado). Um eval que reprovasse essas duas leituras estaria medindo
// cosmética, não risco — e apontaria para o modelo errado na hora de escolher.
function equivale(campo, lido, esperado) {
  if (campo === 'clabe_destino') {
    const d = (v) => String(v ?? '').replace(/\D/g, '');
    return d(lido) === d(esperado);
  }
  if (campo === 'moneda') {
    const m = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z]/g, '');
    return m(lido) === m(esperado);   // '$' e null viram '' — equivalentes
  }
  if (campo === 'monto') return Number(lido) === Number(esperado);
  return String(lido) === String(esperado);
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };

async function extrair(arquivo, modelo) {
  const ext = path.extname(arquivo).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return { erro: `extensão não suportada: ${ext}` };

  const b64 = fs.readFileSync(arquivo).toString('base64');
  const url = `data:${mime};base64,${b64}`;
  const anexo = mime === 'application/pdf' ? { pdf_urls: [url] } : { image_urls: [url] };

  const prompt = `Lee este documento y reporta los campos.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin bloques de código.
El objeto debe tener EXACTAMENTE estas claves:
${JSON.stringify(props, null, 1)}`;

  const res = await fetch('https://fal.run/openrouter/router/vision', {
    method: 'POST',
    headers: { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelo, prompt, system_prompt: SYSTEM, ...anexo }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) return { erro: `HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}` };

  const bruto = String(j?.output ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return { dados: JSON.parse(bruto), custo: j?.usage?.cost ?? null };
  } catch (e) {
    return { erro: `JSON inválido: ${String(e.message).slice(0, 80)}`, custo: j?.usage?.cost ?? null };
  }
}

(async () => {
  if (!fs.existsSync(DIR)) {
    console.error(`Crie ${DIR} e ponha os comprovantes lá (ver cabeçalho).`);
    process.exit(1);
  }
  const arquivos = fs.readdirSync(DIR).filter(f => MIME[path.extname(f).toLowerCase()]);
  if (!arquivos.length) { console.error('Nenhum comprovante em ' + DIR); process.exit(1); }

  console.log(`${arquivos.length} comprovante(s) × ${MODELOS.length} modelo(s) = ${arquivos.length * MODELOS.length} chamadas\n`);

  for (const modelo of MODELOS) {
    let acertos = 0, campos = 0, custoTotal = 0, falhas = 0;
    console.log(`── ${modelo}`);
    for (const arq of arquivos) {
      const caminho = path.join(DIR, arq);
      const gabPath = caminho.replace(/\.[^.]+$/, '.json');
      const gab = fs.existsSync(gabPath) ? JSON.parse(fs.readFileSync(gabPath, 'utf8')) : null;

      const r = await extrair(caminho, modelo);
      custoTotal += r.custo ?? 0;

      if (r.erro) { falhas++; console.log(`  FALHA ${arq}: ${r.erro}`); continue; }
      if (!gab) { console.log(`  ${arq}: (sem gabarito) monto=${r.dados.monto} clabe=${r.dados.clabe_destino}`); continue; }

      const errados = Object.entries(gab).filter(([k, v]) => !equivale(k, r.dados[k], v));
      acertos += Object.keys(gab).length - errados.length;
      campos += Object.keys(gab).length;
      const marca = errados.length ? 'ERRO ' : 'ok   ';
      console.log(`  ${marca}${arq.padEnd(28)}${Object.keys(gab).length - errados.length}/${Object.keys(gab).length}`
        + (errados.length ? `  ${errados.map(([k]) => `${k}=${JSON.stringify(r.dados[k])}`).join(', ')}` : ''));
    }
    const pct = campos ? ((acertos / campos) * 100).toFixed(1) : '—';
    console.log(`  → ${acertos}/${campos} campos (${pct}%)  falhas: ${falhas}`
      + `  custo: US$${custoTotal.toFixed(4)} (R$${(custoTotal * BRL).toFixed(2)})`
      + `  por comprovante: R$${(custoTotal * BRL / arquivos.length).toFixed(3)}\n`);
  }
})();
