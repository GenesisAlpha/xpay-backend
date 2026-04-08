const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findFirst({ where: { username: 'xdeals_beta' } });
  
  if (!user) return console.log("Erro: Merchant não encontrado.");

  // Gera a chave
  const rawSecret = crypto.randomBytes(32).toString('hex');
  const apiKey = `nx_live_${rawSecret}`;
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const keyPrefix = apiKey.substring(0, 12) + "..." + apiKey.substring(apiKey.length - 4);

  // Injeta na Base de Dados
  await prisma.apiKey.create({
    data: { name: 'Chave Direta Vercel', key_hash: keyHash, key_prefix: keyPrefix, user_id: user.id }
  });

  console.log("\n===========================================================");
  console.log("✅ CHAVE PRONTA! COPIA O VALOR ABAIXO PARA A TUA VERCEL:");
  console.log("===========================================================\n");
  console.log(apiKey);
  console.log("\n===========================================================\n");
}

main().finally(() => prisma.$disconnect());
