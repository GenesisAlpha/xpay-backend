const fs = require('fs');
const path = 'prisma/schema.prisma';

if (fs.existsSync(path)) {
  let schema = fs.readFileSync(path, 'utf8');

  // 1. Atualizar Wallet: Trocar balance_total por incoming e pending
  if (schema.includes('balance_total')) {
    schema = schema.replace(
      /balance_total\s+Decimal\s+@db\.Decimal\(20, 8\)\s+@default\(0\.0\)/,
      "balance_incoming  Decimal       @db.Decimal(20, 8) @default(0.0)\n  balance_pending   Decimal       @db.Decimal(20, 8) @default(0.0)"
    );
  }

  // 2. Atualizar Transaction: Adicionar a Previsão de Libertação (clears_at)
  if (!schema.includes('clears_at')) {
    schema = schema.replace(
      /(model Transaction \{[\s\S]*?)(created_at\s+DateTime\s+@default\(now\(\)\))/,
      "$1clears_at               DateTime? // Previsão de quando os fundos ficam disponíveis\n  $2"
    );
  }

  // 3. Atualizar Payout: Adicionar suporte a Tickets Manuais (FIAT)
  if (!schema.includes('is_manual_ticket')) {
    schema = schema.replace(
      /(model Payout \{[\s\S]*?)(created_at\s+DateTime\s+@default\(now\(\)\))/,
      "$1is_manual_ticket  Boolean  @default(false)\n  resolved_at       DateTime?\n  $2"
    );
  }

  fs.writeFileSync(path, schema);
  console.log('✅ Settlement Engine: Campos de Wallet, Transaction e Payout atualizados no Schema!');
} else {
  console.log('❌ Arquivo schema.prisma não encontrado.');
}
