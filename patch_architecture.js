const fs = require('fs');
const path = 'prisma/schema.prisma';

if (fs.existsSync(path)) {
  let schema = fs.readFileSync(path, 'utf8');

  // 1. Atualizar a Enum de Roles para incluir os Customers
  if (!schema.includes('enum Role')) {
      schema = schema.replace(/model User/g, "enum Role {\n  admin\n  merchant\n  customer\n}\n\nmodel User");
  }

  // 2. Atualizar o Modelo User com Tiers e Override Fees
  schema = schema.replace(/role\s+String\s+@default\("merchant"\)/, "role          Role     @default(merchant)");
  
  if (!schema.includes('tier')) {
    schema = schema.replace(/(role.*\n)/, "$1  tier          String   @default(\"NEW\") // AAA, A, B, C, NEW\n  overrideFeeInEur Decimal? // Permite taxa personalizada\n  overrideFeeInBrl Decimal?\n  overrideFeeSwap  Decimal?\n  maxVolumeMonthly Decimal @default(10000) // Limite de volume\n");
  }

  // 3. Atualizar o Modelo Store com Override Fees e Master Providers
  if (schema.includes('model Store') && !schema.includes('overrideFeeInEur')) {
    schema = schema.replace(/(name.*\n)/, "$1  overrideFeeInEur Decimal?\n  overrideFeeInBrl Decimal?\n  providerEurCard  String? // ID do MasterProvider (Ex: Stripe_001_UK)\n  providerEurMbway String?\n  providerBrlPix   String? // MisticPay ou PixMatriz\n");
  }

  // 4. Adicionar as Novas Tabelas Globais: TierConfig e MasterProvider
  if (!schema.includes('model TierConfig')) {
    schema += `
// 💰 CONFIGURAÇÃO GLOBAL DE TIERS (Catálogo de Preços)
model TierConfig {
  id             String   @id @default(cuid())
  name           String   @unique // AAA, A, B, C, NEW
  feeInEur       Decimal
  feeInBrl       Decimal
  feeOut         Decimal  @default(0)
  feeSwap        Decimal  @default(0)
  defaultBrlProv String   // Provider BRL por defeito para este Tier
  defaultEurProv String   // Provider EUR por defeito
  volLimit       Decimal  // Limite global para o Tier
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}

// 🏢 OS PROVEDORES MASTER DA NEXFLOWX (AHub360, NeXTech, etc.)
model MasterProvider {
  id             String   @id // Ex: Stripe_001_UK
  companyName    String   // Ex: AHub360 Ltd UK
  providerType   String   // stripe, sumup, mistic, nowpayments
  capabilities   String[] // [CARD, MBWAY, BANCONTACT]
  settlementDays Int      // Dias de liquidação (Ex: 4, 7, 1)
  apiKeyEncrypted String? // A chave real da NeXFlowX (Se não for via variável de ambiente)
  isActive       Boolean  @default(true)
  createdAt      DateTime @default(now())
}
`;
  }

  fs.writeFileSync(path, schema);
  console.log('✅ Arquitetura de Tiers, Fees e Providers injetada no schema.prisma!');
} else {
  console.log('❌ schema.prisma não encontrado.');
}
