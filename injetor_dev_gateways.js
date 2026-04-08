const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  // 1. Localizar o utilizador Merchant de testes
  const user = await prisma.user.findUnique({ where: { username: 'xdeals_beta' } });
  
  if (!user) {
    return console.log("❌ Erro: Utilizador xdeals_beta não encontrado. Garante que o seed_beta.js foi executado.");
  }

  // 2. Chaves de Teste (Mock/Sandbox) para não afetar a Produção
  const STRIPE_TEST_KEY = ''; // Usa a tua chave de teste do .env
  const SUMUP_TEST_KEY = '';  // Usa a tua chave de teste do .env
  const SUMUP_MERCHANT_CODE = 'M6CS4X5G'; // O teu código de merchant

  console.log("🔧 Injetando credenciais de gateway para xdeals_beta no ambiente DEV...");

  // Configuração Stripe (Multi-Pagamentos)
  await prisma.gatewayConfig.upsert({
    where: { user_id_provider_name: { user_id: user.id, provider_name: 'stripe' } },
    update: { api_key: STRIPE_TEST_KEY, merchant_id: '', is_active: true },
    create: { user_id: user.id, provider_name: 'stripe', api_key: STRIPE_TEST_KEY, merchant_id: '', is_active: true }
  });

  // Configuração SumUp (Checkout Express)
  await prisma.gatewayConfig.upsert({
    where: { user_id_provider_name: { user_id: user.id, provider_name: 'sumup' } },
    update: { api_key: SUMUP_TEST_KEY, merchant_id: SUMUP_MERCHANT_CODE, is_active: true },
    create: { user_id: user.id, provider_name: 'sumup', api_key: SUMUP_TEST_KEY, merchant_id: SUMUP_MERCHANT_CODE, is_active: true }
  });

  console.log("✅ Configuração concluída. SumUp (M6CS4X5G) e Stripe estão ativos para xdeals_beta!");
}

run().finally(() => prisma.$disconnect());
