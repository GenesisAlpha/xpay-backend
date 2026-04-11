const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
require('dotenv').config();

const prisma = new PrismaClient();

const MASTER_KEY = process.env.NEXFLOWX_MASTER_KEY || '7c8f9b2d3e4a5c6b7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c';
const ENCRYPTION_KEY = Buffer.from(MASTER_KEY, 'hex');

function encryptKey(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

async function run() {
  console.log("🔄 A abrir Cofre do Supabase...");
  
  const userId = 'cmngnjdcn0000a8an74ymrz55';

  // 1. GARANTIR QUE A API KEY ESTÁ LIGADA
  await prisma.apiKey.upsert({
    where: { key_hash: 'nx_test_1c085094166bbf6eb4f55c0c3d732bf7c1016719290f69dd' },
    update: { user_id: userId },
    create: {
      name: 'Chave Dev XDeals',
      key_hash: 'nx_test_1c085094166bbf6eb4f55c0c3d732bf7c1016719290f69dd',
      key_prefix: 'nx_test_',
      user_id: userId
    }
  });
  console.log("✅ API Key ligada com sucesso!");

  // 2. INJETAR STRIPE ENCRIPTADA (CORREÇÃO: merchant_id Vazio)
  await prisma.gatewayConfig.upsert({
    where: { user_id_provider_name: { user_id: userId, provider_name: 'stripe' } },
    update: { api_key: encryptKey('sk_test_REMOVED_FOR_SECURITY'), merchant_id: '', is_active: true },
    create: { user_id: userId, provider_name: 'stripe', api_key: encryptKey('sk_test_REMOVED_FOR_SECURITY'), merchant_id: '', is_active: true }
  });
  console.log("💳 Chave Stripe guardada e trancada!");

  // 3. INJETAR SUMUP ENCRIPTADA
  await prisma.gatewayConfig.upsert({
    where: { user_id_provider_name: { user_id: userId, provider_name: 'sumup' } },
    update: { api_key: encryptKey('sup_sk_vwxlKNP74cO4uyBp3qOtKqRbtXcP3hfvW'), merchant_id: 'sup_pk_xcV2mIUsIjeZUk1qkK95k3qp5CyFmyfu1', is_active: true },
    create: { user_id: userId, provider_name: 'sumup', api_key: encryptKey('sup_sk_vwxlKNP74cO4uyBp3qOtKqRbtXcP3hfvW'), merchant_id: 'sup_pk_xcV2mIUsIjeZUk1qkK95k3qp5CyFmyfu1', is_active: true }
  });
  console.log("📱 Chave SumUp guardada e trancada!");

  console.log("🚀 TUDO PRONTO! O Roteador já pode trabalhar.");
}

run()
  .catch(e => console.error("❌ Erro:", e))
  .finally(() => prisma.$disconnect());
