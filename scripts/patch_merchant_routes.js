const fs = require('fs');
const file = 'src/routes/api.routes.ts';
let code = fs.readFileSync(file, 'utf8');

if(!code.includes('StoreController')) {
  code = code.replace("import { AdminController }", "import { StoreController } from '../controllers/store.controller';\nimport { GatewayController } from '../controllers/gateway.controller';\nimport { AdminController }");
  code = code.replace("export default router;", "// Rotas Merchant (SaaS)\nrouter.get('/stores', authenticateUser, StoreController.listStores);\nrouter.post('/stores', authenticateUser, StoreController.createStore);\nrouter.patch('/stores/:id', authenticateUser, StoreController.updateStore);\n\nrouter.get('/settings/gateways', authenticateUser, GatewayController.listGateways);\nrouter.post('/settings/gateways', authenticateUser, GatewayController.createGateway);\n\nexport default router;");
  fs.writeFileSync(file, code);
  console.log("✅ Rotas de Stores e Gateways injetadas na V2!");
}
