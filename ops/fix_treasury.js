const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: 'admin' } });
  
  if (!admin) {
    console.log("Admin não encontrado. Corre o seed primeiro.");
    return;
  }

  // Cria a Tesouraria em USDT (Para permitir saídas de Crypto)
  await prisma.wallet.upsert({
    where: { user_id_currency_code_type_provider: { user_id: admin.id, currency_code: 'USDT', type: 'treasury', provider: 'platform' } },
    update: {},
    create: { user_id: admin.id, currency_code: 'USDT', type: 'treasury', balance_total: 100000.00, balance_available: 100000.00, provider: 'platform' }
  });

  // Cria a Tesouraria em BRL (Para permitir PIX)
  await prisma.wallet.upsert({
    where: { user_id_currency_code_type_provider: { user_id: admin.id, currency_code: 'BRL', type: 'treasury', provider: 'platform' } },
    update: {},
    create: { user_id: admin.id, currency_code: 'BRL', type: 'treasury', balance_total: 500000.00, balance_available: 500000.00, provider: 'platform' }
  });

  console.log("✅ Cofres de Tesouraria em USDT e BRL criados com sucesso!");
}

main().finally(() => prisma.$disconnect());
