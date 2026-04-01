import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

dotenv.config();
const app = express();
const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' as any });
const JWT_SECRET = process.env.JWT_SECRET || 'nex-secret-cyberpunk-2026';

app.use(cors({ origin: true, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'] }));

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ==========================================
// 1. WEBHOOKS (STRIPE -> NEXFLOWX -> CLIENTE)
// ==========================================
app.post('/api/v1/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig as string, process.env.STRIPE_WEBHOOK_SECRET as string);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as any;
      const txId = session.client_reference_id;

      if (txId) {
        console.log(`✅ [STRIPE] Pagamento Confirmado! TX: ${txId}`);

        const tx = await prisma.transaction.update({
          where: { id: txId },
          data: { status: 'gateway_confirmed' as any }
        });

        const merchant: any = await prisma.user.findUnique({ where: { id: tx.payee_id } });
        
        if (merchant?.webhook_url) {
          const payload = JSON.stringify({
            event: 'payment.gateway_confirmed',
            transaction_id: tx.id,
            amount: tx.amount,
            currency: tx.currency,
            status: 'gateway_confirmed'
          });

          const headers: any = { 'Content-Type': 'application/json' };
          
          // Só assina se o segredo existir (Evita quebrar clientes antigos)
          if (merchant.webhook_secret) {
            headers['x-nexflowx-signature'] = crypto
              .createHmac('sha256', merchant.webhook_secret)
              .update(payload)
              .digest('hex');
          }

          try {
            await fetch(merchant.webhook_url, { method: 'POST', headers, body: payload });
            console.log(`📡 [WEBHOOK MERCHANT] Notificação enviada para: ${merchant.webhook_url}`);
          } catch (e) { console.error(`🔴 [WEBHOOK MERCHANT] Erro ao contactar cliente.`); }
        }
      }
    }
    res.json({ received: true });
  } catch (err: any) { res.status(400).send(`Webhook Error: ${err.message}`); }
});

app.use(express.json());

// ==========================================
// 2. DASHBOARD & AUTH (PARA Z.AI)
// ==========================================
const authenticateUser = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Token em falta" });
  jwt.verify(authHeader.split(' ')[1], JWT_SECRET, (err: any, user: any) => {
    if (err) return res.status(403).json({ error: "Sessão expirada" });
    (req as any).user = user;
    next();
  });
};

app.post('/api/v1/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === 'NeXFlowX' && password === 'Nex123456789*') {
    const token = jwt.sign({ id: 'usr_001', role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ success: true, token, user: { id: 'usr_001', role: 'admin' } });
  }
  res.status(401).json({ error: "Credenciais inválidas" });
});

app.get('/api/v1/pipeline', authenticateUser, async (req, res) => {
  try {
    const user = (req as any).user;
    const isAd = user.role === 'admin';
    const txs = await prisma.transaction.findMany({ where: isAd ? {} : { payee_id: user.id } });
    const p: any = { pending: { total: 0 }, gateway_confirmed: { total: 0 }, holding_provider: { total: 0 }, fx_in_transit: { total: 0 }, inventory_wallet: { total: 0 }, distributed: { total: 0 } };
    txs.forEach((t) => { if (p[t.status]) p[t.status].total += Number(t.amount); });
    res.json({ data: p });
  } catch (e) { res.status(500).json({ error: "Erro Pipeline" }); }
});

// ==========================================
// 3. SDK & PAGAMENTOS (PARA O CLIENTE)
// ==========================================
app.get('/sdk.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    window.NexFlowX = function(key) {
      return {
        async checkout(data) {
          const r = await fetch('https://api.nexflowx.tech/api/v1/payment-links', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key },
            body: JSON.stringify(data)
          });
          const j = await r.json();
          if(!r.ok) throw new Error(j.error || 'Erro API');
          return {
            mount: () => {
              const div = document.createElement('div');
              div.style = "position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:99999;display:flex;align-items:center;justify-content:center;";
              div.innerHTML = "<div style='width:min(450px,95%);height:600px;background:#fff;border-radius:12px;overflow:hidden;position:relative;'><button onclick='this.parentElement.parentElement.remove()' style='position:absolute;top:10px;right:10px;border:none;background:none;font-size:24px;cursor:pointer;'>✕</button><iframe src='https://pay.nexflowx.tech/"+j.data.id+"' style='width:100%;height:100%;border:none;'></iframe></div>";
              document.body.appendChild(div);
            }
          };
        }
      };
    };
  `);
});

app.post('/api/v1/payment-links', async (req, res) => {
  try {
    const key = req.headers['x-api-key'] as string;
    const keyData = await prisma.apiKey.findUnique({ where: { key_hash: key } });
    if (!keyData || !safeEqual(keyData.key_hash, key)) return res.status(403).json({ error: "Chave Inválida" });

    const tx = await prisma.transaction.create({
      data: {
        amount: Number(req.body.amount),
        currency: String(req.body.currency || 'EUR').toUpperCase(),
        status: 'pending' as any,
        provider_name: 'stripe',
        payee_id: keyData.user_id,
        country_code: 'PT',
        payment_method: 'CARD'
      }
    });

    res.status(201).json({ data: { id: tx.id, shareable_url: "https://pay.nexflowx.tech/" + tx.id } });
  } catch (e: any) { res.status(500).json({ error: "Erro Interno" }); }
});

// Roteador Universal (pay.nexflowx.tech)
app.get(['/checkout/:id', '/:id'], async (req, res) => {
  if (['success', 'cancel', 'ping', 'sdk.js'].includes(req.params.id)) return;
  try {
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx) return res.status(404).send('Expirado');
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: tx.currency.toLowerCase(), product_data: { name: 'Pagamento NeXFlowX' }, unit_amount: Math.round(Number(tx.amount) * 100) }, quantity: 1 }],
      mode: 'payment',
      success_url: 'https://pay.nexflowx.tech/success',
      cancel_url: 'https://pay.nexflowx.tech/cancel',
      client_reference_id: tx.id
    });
    res.redirect(303, session.url!);
  } catch (err: any) { res.status(500).send('Erro'); }
});

app.get('/success', (req, res) => {
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding-top:100px;"><h1>✓ Pagamento Recebido</h1><button onclick="window.close()">Fechar</button></body></html>`);
});

app.get('/ping', (req, res) => res.json({ status: "online", version: "2.9.3-HYBRID" }));
app.listen(8080, '0.0.0.0', () => console.log('🚀 NeXFlowX v2.9.3 UP'));
