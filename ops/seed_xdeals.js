const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

async function seed() {
  try {
    console.log('🌱 A atualizar o projeto interno XDeals...');
    
    // 1. Procurar ou Criar o Utilizador (Evita erro de duplicado)
    const user = await prisma.user.upsert({
      where: { username: 'xdeals' },
      update: {},
      create: {
        username: 'xdeals',
        password_hash: 'xdeals-test-2026',
        role: 'merchant'
      }
    });

    // 2. Gerar a API Key e o Prefixo
    const rawKey = 'nx_test_' + crypto.randomBytes(24).toString('hex');
    const prefix = rawKey.substring(0, 16); // Pega nos primeiros 16 caracteres
    
    await prisma.apiKey.create({
      data: {
        user_id: user.id,
        key_hash: rawKey, // Num cenário real, isto levaria um bcrypt hash
        key_prefix: prefix, // <-- A CORREÇÃO ESTÁ AQUI
        name: 'Chave Dev XDeals'
      }
    });

    console.log('✅ SUCESSO! Base de dados populada.');
    console.log('====================================');
    console.log('👤 Username : xdeals');
    console.log('🔑 Password : xdeals-test-2026');
    console.log('🛠️ API Key  : ' + rawKey);
    console.log('====================================');

  } catch (error) {
    console.error('❌ Erro:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

seed();
