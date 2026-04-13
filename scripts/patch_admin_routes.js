const fs = require('fs');
const file = 'src/routes/api.routes.ts';
let code = fs.readFileSync(file, 'utf8');

if(!code.includes('AdminController')) {
  code = code.replace("import { WalletController }", "import { AdminController } from '../controllers/admin.controller';\nimport { WalletController }");
  code = code.replace("export default router;", "// Rotas de Backoffice / Operador\nrouter.get('/admin/users', authenticateUser, AdminController.listUsers);\nrouter.post('/admin/users/:id/force-password', authenticateUser, AdminController.forcePasswordReset);\n\nexport default router;");
  fs.writeFileSync(file, code);
  console.log("✅ Rotas de Administração Injetadas!");
}
