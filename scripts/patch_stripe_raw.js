const fs = require('fs');
const path = 'src/server.ts';
let code = fs.readFileSync(path, 'utf8');

if (!code.includes('/api/v1/webhooks/stripe')) {
  const injection = `
// ⚠️ STRIPE WEBHOOK (Tem de estar antes do express.json)
import { WebhookController } from './controllers/webhook.controller';
app.post('/api/v1/webhooks/stripe', express.raw({ type: 'application/json' }), WebhookController.stripeWebhook);

app.use(express.json());
`;
  code = code.replace("app.use(express.json());", injection);
  fs.writeFileSync(path, code);
  console.log('✅ Rota Raw da Stripe injetada no server.ts com sucesso!');
}
