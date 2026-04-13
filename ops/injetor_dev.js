const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
require('dotenv').config();

const prisma = new PrismaClient();
const ENCRYPTION_KEY = Buffer.from(process.env.NEXFLOWX_MASTER_KEY, 'hex');

function encryptKey(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

async function run() {
  // ⚠️ COLOCA AQUI O ID DO TEU UTILIZADOR DE TESTES (ex: XDeals)
  const userId = 'cmngnjdcn0000a8an74ymrz55'; 
  
  // ⚠️ COLOCA AQUI A MESMA sk_test_REMOVED_FOR_SECURITY QUE PUSESTE NO .ENV
  const STRIPE_TEST_KEY = 'sk_test_REMOVED_FOR_SECURITY';

  console.log("🛠️ A injetar nova chave Stripe de Teste no DEV...");

  await prisma.gatewayConfig.upsert({
    where: { user_id_provider_name: { user_id: userId, provider_name: 'stripe' } },
    update: { api_key: encryptKey(STRIPE_TEST_KEY), is_active: true },
    create: { user_id: userId, provider_name: 'stripe', api_key: encryptKey(STRIPE_TEST_KEY), merchant_id: '', is_active: true }
  });

  console.log("✅ Nova chave encriptada com sucesso!");
}

run().finally(() => prisma.$disconnect());
