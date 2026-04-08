const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findFirst({ where: { username: 'xdeals_beta' } });
  
  if (!user) {
    console.log("❌ Erro: Utilizador xdeals_beta não encontrado. Corre o seed_beta.js primeiro.");
    return;
  }

  // Restaurar Configurações de Gateway
  await prisma.gatewayConfig.upsert({
    where: { user_id_provider_name: { user_id: user.id, provider_name: 'stripe' } },
    update: { is_active: true },
    create: { user_id: user.id, provider_name: 'stripe', api_key: 'sk_test_... (está no .env)', merchant_id: 'acct_...', is_active: true }
  });

  await prisma.gatewayConfig.upsert({
    where: { user_id_provider_name: { user_id: user.id, provider_name: 'sumup' } },
    update: { is_active: true },
    create: { user_id: user.id, provider_name: 'sumup', api_key: 'sumup_key_...', merchant_id: 'm_...', is_active: true }
  });

  console.log("✅ Credenciais Stripe/SumUp restauradas para xdeals_beta!");
}

main().finally(() => prisma.$disconnect());
