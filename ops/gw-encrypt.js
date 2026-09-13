#!/usr/bin/env node
/* ============================================================================
 * gw-encrypt — cifra o secret da Clip para colar em private.gw_card_secrets
 * ----------------------------------------------------------------------------
 * RODE NA SUA MÁQUINA. O secret em claro nunca sai deste terminal: não vira env
 * var da Netlify, não entra em arquivo versionado, não aparece em chat.
 *
 * Uso:
 *   CRYPTO_MASTER_KEY=<64 hex> node ops/gw-encrypt.js clip_mx_gray_01
 *   (o secret é pedido em seguida, com o eco do terminal desligado)
 *
 * ⚠️ POR QUE O SECRET É LIDO DO STDIN E NÃO DE ARGV.
 * Argumento de linha de comando fica no histórico do shell E é visível para
 * qualquer processo da máquina via `ps`. Um secret de gateway que passou por
 * argv deve ser considerado vazado e rotacionado. Aqui ele só existe em memória.
 *
 * ⚠️ MASTER KEY: reusa CRYPTO_MASTER_KEY, a mesma do CryptoService do pay.
 * O handoff previa um GW_MASTER_KEY novo; não vale a pena. A chave já existe,
 * já está no ambiente do pay, e é ela que o AccountRouter usa para decifrar os
 * secrets de Stripe/Whop. Uma segunda master key seria mais um segredo para
 * rotacionar, guardar e perder, protegendo exatamente a mesma coisa.
 * ========================================================================== */

const crypto = require('crypto');
const readline = require('readline');

const accountId = process.argv[2];
if (!accountId) {
  console.error('uso: CRYPTO_MASTER_KEY=<64 hex> node ops/gw-encrypt.js <account_id>');
  process.exit(1);
}

const rawKey = process.env.CRYPTO_MASTER_KEY || '';
if (!/^[0-9a-fA-F]{64}$/.test(rawKey)) {
  console.error(
    'CRYPTO_MASTER_KEY ausente ou inválida.\n' +
    'Precisa ser 32 bytes em hex (64 caracteres). Gerar uma nova:\n' +
    '  openssl rand -hex 32\n\n' +
    '⚠️ Se este pay JÁ tem contas Stripe/Whop cadastradas, use a chave que já\n' +
    '   está no ambiente. Gerar outra torna os secrets existentes indecifráveis.'
  );
  process.exit(1);
}
const key = Buffer.from(rawKey, 'hex');

// Formato iv:tag:content, idêntico ao CryptoService.encrypt — é o que o
// AccountRouter sabe ler. Divergir aqui só aparece em produção, na primeira
// cobrança, como erro de autenticação da Clip.
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(blob) {
  const [ivHex, tagHex, encHex] = blob.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8');
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const onData = (ch) => {
      // Reescreve a linha sem o caractere digitado. Sem isto o secret fica
      // legível na tela — e prints de tela vazam tanto quanto histórico.
      if (['\n', '\r', ''].includes(ch.toString())) return;
      readline.clearLine(process.stderr, 0);
      readline.cursorTo(process.stderr, 0);
      process.stderr.write(question);
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  const secret = (await promptHidden(`secret da Clip para "${accountId}": `)).trim();
  if (!secret) {
    console.error('secret vazio — nada a fazer.');
    process.exit(1);
  }

  const blob = encrypt(secret);

  // Round-trip antes de imprimir. Um blob que não decifra só daria erro na
  // primeira venda real, e aí o diagnóstico custa caro. Verificar aqui é grátis.
  if (decrypt(blob) !== secret) {
    console.error('FALHA: o round-trip não bateu. Não use este blob.');
    process.exit(1);
  }

  process.stderr.write('\nround-trip ok. Cole no banco:\n\n');
  console.log(
    `insert into private.gw_card_secrets (account_id, secret_enc)\n` +
    `values ('${accountId.replace(/'/g, "''")}', '${blob}')\n` +
    `on conflict (account_id) do update\n` +
    `  set secret_enc = excluded.secret_enc, updated_at = now();`
  );
  process.stderr.write(
    '\n⚠️ Rode este INSERT pelo SQL Editor do Supabase, não por um arquivo\n' +
    '   versionado. O blob é inútil sem a master key, mas os dois juntos num\n' +
    '   repositório anulam a cifra inteira.\n'
  );
})();
