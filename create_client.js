const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

async function provisionEnterpriseClient() {
  try {
    console.log('🏗️  A iniciar provisionamento de conta Enterprise...');

    // 1. Definição do Cliente Estratégico
    const client = await prisma.user.create({
      data: {
        username: 'C.Euro2026',
        password_hash: 'nx_sec_9kL2p_Xv92_Rz8w_Kq', // Hash de alta entropia
        role: 'operator',
        preferred_provider: 'stripe'
      }
    });

    // 2. Geração da Chave de API de Produção
    const rawKey = crypto.randomBytes(24).toString('hex');
    const apiKey = `nx_live_${rawKey}`;

    // 3. Registo no Ledger de Identidade (ApiKey)
    await prisma.apiKey.create({
      data: {
        name: 'Euro2026 Production Key',
        key_hash: apiKey,
        key_prefix: 'nx_live_',
        user_id: client.id
      }
    });

    console.log('\n================================================');
    console.log('   NEXFLOWX CORE - CLIENT PROVISIONING REPORT   ');
    console.log('================================================');
    console.log(`🏢 ENTIDADE:      ${client.username}`);
    console.log(`🆔 LEDGER ID:     ${client.id}`);
    console.log(`🔒 ACCESS HASH:   [PROTECTED]`);
    console.log(`🔑 PRODUCTION KEY: ${apiKey}`);
    console.log('================================================\n');
    console.log('A infraestrutura está pronta para receber tráfego deste cliente.');

  } catch (error) {
    console.error('❌ Falha no Provisionamento:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

provisionEnterpriseClient();
