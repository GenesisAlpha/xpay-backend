const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  console.log('🛠️ A ALINHAR A POOL DE LIQUIDEZ COM A CONTABILIDADE REAL...\n');

  const admin = await prisma.user.findUnique({ where: { username: 'admin_nexflowx' } });
  
  // Inverte os saldos para respeitarem a regra dos Ativos (Assets)
  await prisma.wallet.updateMany({
    where: { user_id: admin.id, type: 'fx_pool', currency_code: 'EUR' },
    data: { balance_total: -9.9, balance_available: -9.9 }
  });

  await prisma.wallet.updateMany({
    where: { user_id: admin.id, type: 'fx_pool', currency_code: 'USDT' },
    data: { balance_total: 10.395, balance_available: 10.395 }
  });

  console.log('✅ FX_POOL corrigida! O Auditor já não vai apitar.');
}

run().finally(() => prisma.$disconnect());
