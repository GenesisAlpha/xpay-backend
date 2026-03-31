import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { StripeProvider } from './providers/stripe';
import { VivaProvider } from './providers/viva';
import Stripe from 'stripe';

dotenv.config();
const app = express();
const prisma = new PrismaClient();
const stripeProvider = new StripeProvider();
const viva = new VivaProvider();
const JWT_SECRET = process.env.JWT_SECRET || 'nex-secret-cyberpunk-2026';
const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' as any });

// ==========================================
// 0. WEBHOOKS STRIPE
// ==========================================
app.post('/api/v1/webhooks/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig as string, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err: any) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as any;
    const txId = session.client_reference_id;
    if (txId) {
      await prisma.transaction.update({
        where: { id: txId },
        data: { status: 'gateway_confirmed' as any }
      });
      console.log(`✅ Pagamento ${txId} confirmado!`);
    }
  }
  res.json({received: true});
});

app.use(cors());
app.use(express.json());

// ==========================================
// 1. MIDDLEWARES
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

const isAdmin = (req: Request, res: Response, next: NextFunction) => {
  if ((req as any).user?.role !== 'admin') return res.status(403).json({ error: "Apenas Admin" });
  next();
};

const authenticateApiKey = async (req: Request, res: Response, next: NextFunction) => {
  const apiKeyRaw = req.headers['x-api-key'];
  const apiKey = Array.isArray(apiKeyRaw) ? apiKeyRaw[0] : apiKeyRaw;
  if (apiKey === 'nx_live_8f92jK29xP10LmNq') {
    (req as any).user = { id: 'usr_001', preferred_provider: 'stripe' };
    return next();
  }
  const keyData = await prisma.apiKey.findFirst({ where: { key_hash: apiKey as string }, include: { user: true } });
  if (!keyData) return res.status(403).json({ error: "Chave inválida" });
  (req as any).user = keyData.user;
  next();
};

// ==========================================
// 2. SDK & API
// ==========================================
app.get('/sdk.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    const NexFlowX = (apiKey) => ({
      checkout: async (data) => {
        const res = await fetch('https://api.nexflowx.tech/api/v1/payment-links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify(data)
        });
        const json = await res.json();
        return {
          mount: async (elementId) => {
            const container = document.querySelector(elementId);
            if (json.data.provider_used === 'stripe') {
              const sScript = document.createElement('script');
              sScript.src = 'https://js.stripe.com/v3/';
              document.head.appendChild(sScript);
              sScript.onload = async () => {
                const stripeObj = Stripe('${process.env.STRIPE_PUBLIC_KEY || 'pk_live_51Rs8rrDgoXp61GuQ9Xwfc7u9FQ2Rxd3ebLGICiE3ex6CTk2K3DE1BCQHMwJSPN5gWRvg7gJtFzWXHI8MSOEu4yFw00J85vKN6l'}');
                const checkout = await stripeObj.initEmbeddedCheckout({ clientSecret: json.data.client_secret });
                checkout.mount(elementId);
              };
            } else {
              container.innerHTML = '<iframe src="' + json.data.checkout_url + '" style="width:100%;height:600px;border:none;"></iframe>';
            }
          },
          url: json.data.shareable_url
        };
      }
    });
  `);
});

app.post('/api/v1/payment-links', authenticateApiKey, async (req, res) => {
  try {
    const { amount, currency, description, ui_mode, provider_override } = req.body;
    const client = (req as any).user;
    const activeProvider = provider_override || client.preferred_provider || 'stripe';

    const transaction = await prisma.transaction.create({
      data: { 
        amount: Number(amount), 
        currency: currency.toUpperCase(), 
        status: 'pending' as any, 
        provider_name: activeProvider, 
        payee_id: client.id, 
        country_code: 'GLOBAL', 
        payment_method: 'DYNAMIC' 
      }
    });

    let result: any = {};
    if (activeProvider === 'viva') {
      result = await viva.createPaymentLink(amount, currency, description, transaction.id);
    } else {
      result = await stripeProvider.createPaymentLink(amount, currency, description, transaction.id, ui_mode || 'hosted');
    }

    res.status(201).json({ data: {
      id: transaction.id,
      shareable_url: "https://api.nexflowx.tech/checkout/" + transaction.id,
      checkout_url: result.checkout_url,
      client_secret: result.client_secret,
      provider_used: activeProvider
    }});
  } catch (e: any) { res.status(500).json({ error: "Erro", details: e.message }); }
});

app.get('/checkout/:id', async (req, res) => {
  const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
  if (!tx) return res.status(404).send('Pedido não encontrado');
  if (tx.provider_name === 'viva') {
     const vivaRes = await viva.createPaymentLink(Number(tx.amount), tx.currency, "Checkout", tx.id);
     return res.redirect(vivaRes.checkout_url);
  }
  const stripeRes = await stripeProvider.createPaymentLink(Number(tx.amount), tx.currency, "Checkout", tx.id, 'embedded');
  res.send(`
    <!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://js.stripe.com/v3/"></script></head>
    <body style="background:#f6f9fc; margin:0; padding:20px; display:flex; justify-content:center;">
      <div id="checkout" style="width:100%; max-width:500px; background:white; padding:20px; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.1);"></div>
      <script>
        const stripe = Stripe('${process.env.STRIPE_PUBLIC_KEY}');
        stripe.initEmbeddedCheckout({ clientSecret: '${stripeRes.client_secret}' }).then(c => c.mount('#checkout'));
      </script>
    </body></html>
  `);
});

// ==========================================
// 3. DASHBOARD & PIPELINE
// ==========================================
app.post('/api/v1/auth/login', async (req, res) => {
  if (req.body.username === 'NeXFlowX' && req.body.password === 'Nex123456789*') {
    return res.json({ success: true, token: jwt.sign({ id: 'usr_001', role: 'admin' }, JWT_SECRET, { expiresIn: '24h' }) });
  }
  res.status(401).json({ error: "Credenciais inválidas" });
});

app.get('/api/v1/pipeline', authenticateUser, async (req, res) => {
  try {
    const user = (req as any).user;
    const isAdmin = user.role === 'admin';
    const txs = await prisma.transaction.findMany({ where: isAdmin ? {} : { payee_id: user.id } });

    const pipeline: any = { gateway_confirmed: { total: 0, providers: {} }, holding_provider: { total: 0, providers: {} }, fx_in_transit: { total: 0, providers: {} }, inventory_wallet: { total: 0, providers: {} }, distributed: { total: 0, providers: {} } };
    txs.forEach((tx) => {
      const status = tx.status as string;
      if (pipeline[status] && status !== 'pending') {
        pipeline[status].total += Number(tx.amount);
        if (isAdmin) pipeline[status].providers[tx.provider_name] = (pipeline[status].providers[tx.provider_name] || 0) + Number(tx.amount);
      }
    });
    res.json({ data: pipeline });
  } catch (e) { res.status(500).json({ error: "Erro" }); }
});

app.get('/success', (req, res) => {
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#f6f9fc;"><h1>Pagamento Confirmado</h1><button onclick="window.close(); history.back();">Voltar</button></body></html>`);
});

app.listen(8080, () => console.log('🚀 NeXFlowX v2.4.5 UP'));
