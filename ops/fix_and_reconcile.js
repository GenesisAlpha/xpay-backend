const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  console.log('🛠️ A CORRIGIR SALDOS E A ATUALIZAR O AUDITOR...\n');

  // 1. Corrigir o esquecimento do Payout na Wallet da Tesouraria
  const admin = await prisma.user.findUnique({ where: { username: 'admin_nexflowx' } });
  const treasury = await prisma.wallet.findFirst({ where: { user_id: admin.id, type: 'treasury', currency_code: 'EUR' } });
  
  if (treasury && Number(treasury.balance_total) === 48.12) {
    // Deduzir os 38.12 do Payout que o server.ts esqueceu de atualizar fisicamente
    await prisma.wallet.update({
      where: { id: treasury.id },
      data: { balance_total: { decrement: 38.12 }, balance_available: { decrement: 38.12 } }
    });
    console.log('✅ Base de dados reparada: Saldo da Tesouraria corrigido para 10.00 EUR.');
  }

  // 2. O Novo Motor de Reconciliação (Com Contabilidade Real)
  console.log('\n🔍 A INICIAR MOTOR DE RECONCILIAÇÃO INTERNA V2...');
  const wallets = await prisma.wallet.findMany({ include: { user: true } });
  let driftFound = false;

  for (const wallet of wallets) {
    const entries = await prisma.ledgerEntry.findMany({
      where: { wallet_id: wallet.id }, include: { ledger_transaction: true }
    });

    let expectedTotal = 0; let expectedAvailable = 0;
    
    // 🧠 A REGRA DE OURO BANCÁRIA: Ativos vs Passivos
    const isAsset = wallet.type === 'treasury' || wallet.type === 'fx_pool';

    for (const entry of entries) {
      const amount = Number(entry.amount);
      const isCleared = entry.ledger_transaction.status === 'cleared';
      
      // Se for Ativo (Cofre), Débito é positivo. Se for Passivo (Cliente/Lucro), Crédito é positivo.
      const isAddition = isAsset ? (entry.direction === 'DEBIT') : (entry.direction === 'CREDIT');

      if (isAddition) {
        expectedTotal += amount;
        if (isCleared) expectedAvailable += amount;
      } else {
        expectedTotal -= amount;
        expectedAvailable -= amount;
      }
    }

    expectedTotal = Math.round(expectedTotal * 100000000) / 100000000;
    expectedAvailable = Math.round(expectedAvailable * 100000000) / 100000000;
    
    const actualTotal = Number(wallet.balance_total);
    const actualAvailable = Number(wallet.balance_available);

    if (expectedTotal !== actualTotal || expectedAvailable !== actualAvailable) {
      driftFound = true;
      console.log(`❌ ALARME DE DRIFT: [${wallet.type.toUpperCase()}] de ${wallet.user.username} (${wallet.currency_code})`);
      console.log(`   Esperava: ${expectedTotal} | Encontrou: ${actualTotal}`);
    } else {
      console.log(`✅ OK: Carteira [${wallet.type.toUpperCase()}] de ${wallet.user.username} (${wallet.currency_code}) alinhada.`);
    }
  }

  if (!driftFound) console.log('\n🛡️ AUDITORIA PASSOU: Todos os saldos batem certo com o Livro-Razão.');
}

run().finally(() => prisma.$disconnect());
