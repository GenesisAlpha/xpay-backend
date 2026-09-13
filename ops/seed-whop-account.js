#!/usr/bin/env node
/**
 * Cadastra uma conta Whop no pool, a partir da API KEY e só dela.
 *
 *   node ops/seed-whop-account.js <id> <apiKey> [--ativar] [--teto 5000] [--razao "XYZ LTDA"]
 *
 * Ex.: node ops/seed-whop-account.js whop_01 apik_xxxxx --ativar
 *
 * Faz o mesmo que Administração → Contas Whop no CRM:
 *   1. descobre a company pela chave        (GET  /api/v5/company)
 *   2. registra o webhook /webhook/whop/<id> (POST /api/v1/webhooks)
 *   3. cifra chave e segredo (AES-256-GCM, mesmo formato do CryptoService)
 *   4. grava em whop_accounts via REST do Supabase (service_role)
 *
 * O <id> vira a URL do webhook e o transactions.provider_account_id.
 * Renomear depois quebra o histórico e deixa o webhook apontando pro vazio.
 *
 * Por padrão a conta entra INATIVA — passe --ativar pra já colocá-la no pool.
 */

const path = require('path')
const crypto = require('crypto')

require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, '..', '.env'),
})

const WHOP_API = process.env.WHOP_API_URL ?? 'https://api.whop.com'
const PAY_PUBLIC_URL = process.env.PAY_PUBLIC_URL ?? 'https://api.koopfy.com/pay'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const MASTER_KEY = process.env.CRYPTO_MASTER_KEY

// ─── args ────────────────────────────────────────────────────────────────────

// Varre uma vez separando flags de posicionais. `--ativar` é booleana (não
// consome o próximo token); as demais consomem o valor seguinte.
const BOOLEANAS = new Set(['ativar'])

const argv = process.argv.slice(2)
const flags = {}
const posicionais = []

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) { posicionais.push(a); continue }
  const nome = a.slice(2)
  if (BOOLEANAS.has(nome)) { flags[nome] = true; continue }
  flags[nome] = argv[++i] ?? null
}

const [id, apiKey] = posicionais
const ativar = flags.ativar === true
const teto = flags.teto          // em DÓLARES; convertido pra centavos abaixo
const razao = flags.razao
const peso = flags.peso

function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1) }

if (!id || !apiKey) die('uso: node ops/seed-whop-account.js <id> <apiKey> [--ativar] [--teto 5000] [--razao "XYZ LTDA"] [--peso 1]')
if (!SUPABASE_URL || !SUPABASE_KEY) die('SUPABASE_URL / SUPABASE_KEY ausentes no .env')
if (!MASTER_KEY) die('CRYPTO_MASTER_KEY ausente no .env — sem ela a chave da Whop seria gravada em texto puro')

// ─── cripto: MESMO formato do CryptoService (iv:tag:content, hex) ────────────
// Divergir aqui grava um valor que o pay não consegue decifrar em runtime — e o
// sintoma seria "Whop: api_key ausente na conta" na primeira compra.

function encrypt(text) {
  const key = Buffer.from(MASTER_KEY, 'hex')
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function whop(pathname, init = {}) {
  const res = await fetch(`${WHOP_API}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(json?.error?.message ?? json?.message ?? `Whop HTTP ${res.status}`)
  }
  return json
}

async function supa(pathname, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${pathname}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    if (text.includes('PGRST205')) {
      die('a tabela `whop_accounts` NÃO EXISTE. Rode antes a migration:\n'
        + '   apps/pay/supabase_whop_accounts_migration.sql')
    }
    throw new Error(`Supabase HTTP ${res.status}: ${text}`)
  }
  return text ? JSON.parse(text) : null
}

// ─── main ────────────────────────────────────────────────────────────────────

;(async () => {
  console.log(`\n▸ Provisionando conta "${id}"\n`)

  // 0. Tabela existe? Falha cedo com instrução, em vez de erro cru no fim.
  await supa('/whop_accounts?select=id&limit=1')

  // 1. Company — a chave já está amarrada a uma; não precisa perguntar.
  const company = await whop('/api/v5/company')
  console.log(`  company : ${company.id}  (${company.title ?? 'sem título'})`)

  // 2. Webhook. Reusa se já existir um apontando pra ESTA conta: rodar o script
  //    duas vezes criaria duas entregas do mesmo evento — o dedupe por
  //    webhook-id não pega (são ids diferentes), e só o guard de
  //    "transação já aprovada" evitaria crédito dobrado. Melhor não depender dele.
  const url = `${PAY_PUBLIC_URL}/webhook/whop/${id}`
  const existentes = await whop(`/api/v1/webhooks?company_id=${company.id}`)
  const jaTem = (existentes?.data ?? []).find(w => w.url === url)

  let webhookId, webhookSecret
  if (jaTem) {
    webhookId = jaTem.id
    webhookSecret = jaTem.webhook_secret
    console.log(`  webhook : ${webhookId} (reusado)`)
    if (!webhookSecret) {
      die(`o webhook ${webhookId} já existe mas a API não devolveu o segredo.\n`
        + '   Apague-o no painel da Whop e rode de novo — sem segredo o pagamento\n'
        + '   é cobrado e nunca confirma.')
    }
  } else {
    const criado = await whop('/api/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        // resource_id, NÃO company_id — este endpoint é a exceção da API.
        resource_id: company.id,
        url,
        events: ['payment.succeeded', 'payment.failed', 'refund.created', 'dispute.created'],
        api_version: 'v1',
        enabled: true,
      }),
    })
    webhookId = criado.id
    webhookSecret = criado.webhook_secret
    console.log(`  webhook : ${webhookId} (criado) → ${url}`)
  }

  // 3. Grava. Tetos em CENTAVOS DE USD — é a unidade de
  //    account_daily_metrics.volume, que alimenta o teto diário no router.
  const row = {
    id,
    label: company.title ?? null,
    company_id: company.id,
    api_key: encrypt(apiKey),
    webhook_secret: encrypt(webhookSecret),
    webhook_id: webhookId,
    status: ativar ? 'active' : 'inactive',
    weight: peso ? Number(peso) : 1,
    daily_cap_amount: teto ? Math.round(Number(teto) * 100) : null,
    legal_name: razao ?? null,
    updated_at: new Date().toISOString(),
  }

  await supa('/whop_accounts?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  })

  console.log(`  status  : ${row.status}`)
  console.log(`  teto    : ${row.daily_cap_amount ?? 'sem teto'} (USD cents)`)
  console.log(`\n✓ Conta "${id}" gravada.`)
  if (!ativar) {
    console.log('  Ela está INATIVA — ative em Administração → Contas Whop,')
    console.log('  ou rode de novo com --ativar.')
  }
  console.log('')
})().catch(err => die(err.message))
