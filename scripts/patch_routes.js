const fs = require('fs');
const file = 'src/routes/api.routes.ts';
let code = fs.readFileSync(file, 'utf8');

if(!code.includes('WalletController')) {
  code = code.replace("import { DepositController }", "import { WalletController } from '../controllers/wallet.controller';\nimport { DepositController }");
  code = code.replace("export default router;", "// Rotas de Leitura (Dashboard)\nrouter.get('/wallets', authenticateUser, WalletController.getWallets);\nrouter.get('/ledger', authenticateUser, WalletController.getLedger);\n\nexport default router;");
  fs.writeFileSync(file, code);
  console.log("✅ Rotas /wallets e /ledger injetadas com sucesso!");
}
