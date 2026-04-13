import { startCronJobs } from './cron';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import apiRoutes from './routes/api.routes';

dotenv.config();
const app = express();

const allowedOrigins = [
  'https://central.nexflowx.tech',
  'https://atlas.nexflowx.tech',
  'http://localhost:3000',
  'http://localhost:3001'
];

app.use(cors({
  origin: function (origin, callback) {
    // Permite chamadas sem origin (ex: Postman, cURL) ou domínios da lista VIP
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, origin || '*');
    } else {
      // Para evitar que a aplicação quebre durante esta fase de transição, 
      // estamos a aceitar temporariamente tudo. Quando quiseres trancar a API,
      // substitui a linha abaixo por: callback(new Error('Bloqueado por CORS'));
      callback(null, origin); 
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'stripe-signature', 'x-nowpayments-sig', 'x-nexflowx-signature'],
  credentials: true
}));

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'nexflowx-dev-sandbox-2026';
const MASTER_KEY = process.env.NEXFLOWX_MASTER_KEY || '';

// Função de Segurança para Chaves
function decryptKey(text: string) {
  if (!text || !text.includes(':') || !MASTER_KEY) return text; 
  try {
    const ENCRYPTION_KEY = Buffer.from(MASTER_KEY, 'hex');
    const textParts = text.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(textParts[0], 'hex'));
    return decipher.update(Buffer.from(textParts[1], 'hex'), undefined, 'utf8') + decipher.final('utf8');
  } catch (e) { return text; }
}



// ⚠️ STRIPE WEBHOOK (Tem de estar antes do express.json)
import { WebhookController } from './controllers/webhook.controller';
app.post('/api/v1/webhooks/stripe', express.raw({ type: 'application/json' }), WebhookController.stripeWebhook);

app.use(express.json());


// ==========================================
// 🔐 AUTENTICAÇÃO E LOGIN (DASHBOARD)
// ==========================================
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(401).json({ error: "Credenciais inválidas" });

    // Suporta senhas antigas em texto plano e novas com hash bcrypt
    const isValid = (user.password_hash === password) || await bcrypt.compare(password, user.password_hash);
    
    if (isValid) {
      return res.json({
        success: true,
        token: jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' }),
        user: { id: user.id, role: user.role, username: user.username }
      });
    }
    res.status(401).json({ error: "Credenciais inválidas" });
  } catch (e) {
    res.status(500).json({ error: "Erro interno no login" });
  }
});

app.use('/api/v1', apiRoutes);

// ==========================================
// 🛒 CHECKOUT SESSION (INTEGRADO COM SAAS)
// ==========================================
app.get('/api/v1/checkout-session/:id', async (req, res) => {
  try {
    const tx = await prisma.transaction.findUnique({
      where: { id: req.params.id },
      include: { payee: { select: { username: true } }, store: true }
    });

    if (!tx) return res.status(404).json({ error: 'Sessão não encontrada' });

    res.json({
      id: tx.id,
      amount: Number(tx.amount),
      currency: tx.currency,
      merchant_name: tx.store?.name || tx.payee.username,
      branding: {
        logo_url: tx.store?.logo_url || "https://ui-avatars.com/api/?name=" + tx.payee.username + "&background=random",
        primary_color: tx.store?.primary_color || "#1a1a2e",
        accent_color: tx.store?.accent_color || "#f0ebe3" 
      },
      allowed_methods: [tx.provider_name]
    });
  } catch (err) { res.status(500).json({ error: "Erro interno" }); }
});

app.patch('/api/v1/checkout-session/:id/customer', async (req, res) => {
  try {
    const { customer_name, customer_email, address, country } = req.body;
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    const meta = (tx?.metadata as any) || {};
    await prisma.transaction.update({
      where: { id: req.params.id },
      data: { customer_email, country_code: country, metadata: { ...meta, customer_name, address, updated_at: new Date() } }
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Erro save" }); }
});

app.post('/api/v1/checkout-session/:id/initiate', async (req, res) => {
  try {
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx) return res.status(404).json({ error: "Transação não encontrada" });

    let gateway = await prisma.gatewayConfig.findFirst({ 
      where: { store_id: tx.store_id, provider_name: tx.provider_name, is_active: true } 
    });

    if (!gateway) {
       gateway = await prisma.gatewayConfig.findFirst({ 
         where: { user_id: tx.payee_id, store_id: null, provider_name: tx.provider_name, is_active: true } 
       });
    }

    if (!gateway) return res.status(500).json({ error: `Gateway ${tx.provider_name} offline ou não configurado.` });

    const rawApiKey = decryptKey(gateway.api_key);

    if (tx.provider_name === 'sumup') {
      const response = await fetch('https://api.sumup.com/v0.1/checkouts', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${rawApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(tx.amount), currency: tx.currency, checkout_reference: tx.id, merchant_code: gateway.merchant_id })
      });
      const data = await response.json();
      return res.json({ provider: 'sumup', checkout_id: data.id });
    }
    
    if (tx.provider_name === 'stripe') {
       return res.json({ provider: 'stripe', client_secret: 'pi_mock_dev_secret' });
    }

    res.status(400).json({ error: "Provedor não suportado para Iniciação de Checkout" });
  } catch (e) { res.status(500).json({ error: "Erro initiate" }); }
});

// 🚀 CORREÇÃO DA PORTA PARA 8080
startCronJobs();
  app.listen(8080, '0.0.0.0', () => console.log('🚀 NeXFlowX Core Bank API ON'));
