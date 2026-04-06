const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
require('dotenv').config();

const prisma = new PrismaClient();
const ENCRYPTION_KEY = Buffer.from(process.env.NEXFLOWX_MASTER_KEY || '7c8f9b2d3e4a5c6b7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c', 'hex');

function encryptKey(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

async function run() {
  console.log("🌱 A inicializar o Core Banking NeXFlowX...");

  // 1. INJETAR AS MOEDAS REAIS
  const currencies = [
    { code: 'EUR', type: 'fiat', precision: 2 },
    { code: 'USD', type: 'fiat', precision: 2 },
    { code: 'BRL', type: 'fiat', precision: 2 },
    { code: 'USDT', type: 'crypto', precision: 6 },
    { code: 'BTC', type: 'crypto', precision: 8 }
  ];
  for (const c of currencies) {
    await prisma.currency.upsert({ where: { code: c.code }, update: {}, create: c });
  }

  // 2. O NOSSO ADMIN (Tesouraria / Treasury)
  const admin = await prisma.user.upsert({
    where: { username: 'admin_nexflowx' },
    update: {},
    create: { username: 'admin_nexflowx', password_hash: 'admin123', role: 'admin' }
  });

  // 3. O CLIENTE DE TESTE (XDeals)
  const merchant = await prisma.user.upsert({
    where: { username: 'XDeals' },
    update: {},
    create: { username: 'XDeals', password_hash: 'xdeals123', role: 'merchant', webhook_url: 'https://webhook.site/teste-xdeals' }
  });

  // 4. API KEY
  const apiKey = 'nx_test_892nf823jf823nf'; 
  await prisma.apiKey.upsert({
    where: { key_hash: apiKey },
    update: {},
    create: { key_hash: apiKey, key_prefix: 'nx_test', name: 'Chave DEV V5', user_id: merchant.id }
  });

  // 5. CONFIGS DE CLEARING (Stripe = Manual para testarmos os Tickets)
  const stripeTestKey = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';
  await prisma.gatewayConfig.upsert({
    where: { user_id_provider_name: { user_id: merchant.id, provider_name: 'stripe' } },
    update: { clearing_type: 'manual', clearing_delay: 24 }, 
    create: { user_id: merchant.id, provider_name: 'stripe', api_key: encryptKey(stripeTestKey), merchant_id: '', clearing_type: 'manual' }
  });

  console.log("✅ Seed concluído! Base de dados bancária pronta.");
}

run().finally(() => prisma.$disconnect());
