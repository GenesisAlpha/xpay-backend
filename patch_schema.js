const fs = require('fs');
const path = 'prisma/schema.prisma';

if (fs.existsSync(path)) {
  let schema = fs.readFileSync(path, 'utf8');

  if (!schema.includes('model PaymentLink')) {
    // 1. Adicionar o Modelo PaymentLink
    schema += `
model PaymentLink {
  id          String   @id @default(cuid())
  amount      Decimal
  currency    String
  description String?
  slug        String   @unique
  active      Boolean  @default(true)
  userId      String
  storeId     String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  store       Store?   @relation(fields: [storeId], references: [id], onDelete: Cascade)
}
`;

    // 2. Adicionar as relações inversas aos modelos existentes
    schema = schema.replace(/(model User\s*\{[\s\S]*?)(\n\s*\})/m, "$1\n  paymentLinks PaymentLink[]$2");
    
    if (schema.includes('model Store')) {
      schema = schema.replace(/(model Store\s*\{[\s\S]*?)(\n\s*\})/m, "$1\n  paymentLinks PaymentLink[]$2");
    }

    fs.writeFileSync(path, schema);
    console.log('✅ Tabela PaymentLink injetada no schema.prisma com sucesso!');
  } else {
    console.log('⚠️ A tabela PaymentLink já existe no schema.');
  }
} else {
  console.log('❌ Arquivo schema.prisma não encontrado.');
}
