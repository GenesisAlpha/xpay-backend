const fs = require('fs');
const file = 'src/routes/api.routes.ts';
let content = fs.readFileSync(file, 'utf8');

// 1. Remover TODAS as importações antigas e duplicadas do WalletController
content = content.replace(/import\s+\{.*WalletController.*\}\s+from\s+['"].+['"];?\n?/g, '');

// 2. Colocar UMA ÚNICA importação limpa no topo
content = "import { WalletController } from '../controllers/wallet.controller';\n" + content;

// 3. Remover todas as linhas de rotas antigas que usam o WalletController (limpar os erros TS2551 e TS2339)
content = content.replace(/.*WalletController\.getWallets.*/g, '');
content = content.replace(/.*WalletController\.getLedger.*/g, '');
content = content.replace(/.*WalletController\.getMyWallet.*/g, '');
content = content.replace(/.*WalletController\.listMyWallets.*/g, '');

// 4. Injetar as rotas corretas da V2 logo antes do export final
const novasRotas = `
// ==========================================
// 🏦 ROTAS DE TESOURARIA (V2)
// ==========================================
router.get('/wallet', authenticateUser, WalletController.getMyWallet);
router.get('/wallets', authenticateUser, WalletController.listMyWallets);
`;

content = content.replace(/export default router;?/, novasRotas + '\nexport default router;');

fs.writeFileSync(file, content);
console.log('✅ Ficheiro api.routes.ts limpo e corrigido!');
