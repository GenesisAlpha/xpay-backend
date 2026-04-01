import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

const app = express();
const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' as any });

app.use(cors({ origin: '*' }));
app.use(express.json());

// ROTA DE DIAGNÓSTICO ABSOLUTO
app.get('/ping', (req, res) => {
  console.log('--- PING RECEBIDO ---');
  res.status(200).json({ status: "online", version: "2.7.1", timestamp: new Date() });
});

// SDK SERVIDO VIA ROTA (À prova de 404)
app.get('/sdk.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    window.NexFlowX = function(key) {
      return {
        async checkout(data) {
          console.log('Iniciando Checkout NeXFlowX...');
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
              div.style = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:99999;display:flex;align-items:center;justify-content:center;";
              div.innerHTML = "<div style='width:450px;height:600px;background:#fff;border-radius:12px;overflow:hidden;position:relative;'><button onclick='this.parentElement.parentElement.remove()' style='position:absolute;top:10px;right:10px;border:none;background:none;font-size:20px;cursor:pointer;'>✕</button><iframe src='https://api.nexflowx.tech/checkout/"+j.data.id+"' style='width:100%;height:100%;border:none;'></iframe></div>";
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
    const key = req.headers['x-api-key'];
    const keyData = await prisma.apiKey.findFirst({ where: { key_hash: String(key) }, include: { user: true } });
    if (!keyData) return res.status(403).json({ error: "Chave Inválida" });

    const tx = await prisma.transaction.create({
      data: {
        amount: Number(req.body.amount),
        currency: String(req.body.currency || 'EUR'),
        status: 'pending' as any,
        provider_name: keyData.user.preferred_provider,
        payee_id: keyData.user.id,
        country_code: 'PT',
        payment_method: 'CARD'
      }
    });
    res.status(201).json({ data: { id: tx.id, shareable_url: "https://api.nexflowx.tech/checkout/" + tx.id }});
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/checkout/:id', async (req, res) => {
  const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
  if (!tx) return res.status(404).send('Not Found');
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{ price_data: { currency: tx.currency.toLowerCase(), product_data: { name: 'Pagamento NeXFlowX' }, unit_amount: Math.round(Number(tx.amount) * 100) }, quantity: 1 }],
    mode: 'payment',
    success_url: 'https://api.nexflowx.tech/success',
    cancel_url: 'https://api.nexflowx.tech/cancel',
    client_reference_id: tx.id
  });
  res.redirect(session.url!);
});

app.listen(8080, '0.0.0.0', () => console.log('🚀 NeXFlowX v2.7.1 LIVE'));
