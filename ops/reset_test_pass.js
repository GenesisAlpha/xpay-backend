const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function reset() {
  try {
    const hash = await bcrypt.hash('xdeals123', 10);
    const result = await prisma.user.updateMany({
      where: { username: 'xdeals_beta' },
      data: { password_hash: hash }
    });
    if (result.count > 0) {
      console.log("✅ Password do xdeals_beta restaurada e encriptada com sucesso para: xdeals123");
    } else {
      console.log("⚠️ Utilizador xdeals_beta não encontrado.");
    }
  } catch(e) {
    console.error("Erro:", e.message);
  } finally {
    await prisma.$disconnect();
  }
}
reset();
