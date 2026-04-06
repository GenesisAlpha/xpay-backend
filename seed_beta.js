const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("🌱 A limpar a base de dados para o Beta...");
  await prisma.webhookEvent.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.actionTicket.deleteMany();
  await prisma.swap.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.ledgerTransaction.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.gatewayConfig.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.user.deleteMany();
  await prisma.currency.deleteMany();

  console.log("🌍 A criar Moedas...");
  await prisma.currency.createMany({
    data: [
      { code: 'EUR', type: 'fiat', precision: 2 },
      { code: 'USDT', type: 'crypto', precision: 6 },
      { code: 'BRL', type: 'fiat', precision: 2 }
    ]
  });

  console.log("👥 A criar Utilizadores Beta...");
  
  // 1. O Administrador (Backoffice)
  const admin = await prisma.user.create({
    data: { username: 'admin_beta', password_hash: 'admin123', role: 'admin', email: 'admin@nexflowx.tech', kyc_level: 2 }
  });

  // 2. O Merchant (Tem acesso à API)
  const merchant = await prisma.user.create({
    data: { username: 'xdeals_beta', password_hash: 'xdeals123', role: 'merchant', email: 'hello@xdeals.pt', kyc_level: 2 }
  });

  // 3. O Customer (Utilizador Final Particular)
  const customer = await prisma.user.create({
    data: { username: 'joao_beta', password_hash: 'joao123', role: 'customer', email: 'joao@gmail.com', kyc_level: 1 }
  });

  console.log("💰 A financiar Wallets de Teste...");

  // Dinheiro do Merchant (XDeals)
  await prisma.wallet.createMany({
    data: [
      { user_id: merchant.id, currency_code: 'EUR', type: 'merchant', balance_total: 1500.00, balance_available: 1500.00, provider: 'platform' },
      { user_id: merchant.id, currency_code: 'USDT', type: 'merchant', balance_total: 500.00, balance_available: 500.00, provider: 'platform' }
    ]
  });

  // Dinheiro do Customer (João)
  await prisma.wallet.createMany({
    data: [
      { user_id: customer.id, currency_code: 'EUR', type: 'merchant', balance_total: 250.00, balance_available: 250.00, provider: 'platform' }
    ]
  });

  // Cofre da Tesouraria e FX (Para permitir Swaps)
  await prisma.wallet.createMany({
    data: [
      { user_id: admin.id, currency_code: 'EUR', type: 'treasury', balance_total: 50000.00, balance_available: 50000.00, provider: 'platform' },
      { user_id: admin.id, currency_code: 'USDT', type: 'fx_pool', balance_total: 50000.00, balance_available: 50000.00, provider: 'platform' },
      { user_id: admin.id, currency_code: 'EUR', type: 'fx_pool', balance_total: 50000.00, balance_available: 50000.00, provider: 'platform' },
      { user_id: admin.id, currency_code: 'BRL', type: 'fx_pool', balance_total: 50000.00, balance_available: 50000.00, provider: 'platform' }
    ]
  });

  console.log("✅ Seed Beta concluído com sucesso!");
}

main().catch(e => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
