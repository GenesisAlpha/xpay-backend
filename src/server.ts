import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

import apiRoutes from './routes/api.routes';

dotenv.config();
const app = express();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'nexflowx-dev-sandbox-2026';
const MASTER_KEY = process.env.NEXFLOWX_MASTER_KEY || '';

// Função para suportar tanto chaves em plain-text no dev, como encriptadas de prod
function decryptKey(text: string) {
  if (!text || !text.includes(':') || !MASTER_KEY) return text; 
  try {
    const ENCRYPTION_KEY = Buffer.from(MASTER_KEY, 'hex');
    const textParts = text.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(textParts[0], 'hex'));
    return decipher.update(Buffer.from(textParts[1], 'hex'), undefined, 'utf8') + decipher.final('utf8');
  } catch (e) { return text; }
}

app.use(cors({ origin: true, methods: ['GET', 'POST', 'PATCH', 'OPTIONS', 'PUT'], allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'] }));
app.use(express.json());

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
      // Agora o frontend sabe se deve abrir SumUp, Stripe, etc.
      allowed_methods: [tx.provider_name]
    });
  } catch (err) { res.status(500).json({ error: "Erro interno" }); }
});

// PATCH para Auto-save (Mantido sem quebrar)
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

// POST para Initiate (Agora 100% Dinâmico)
app.post('/api/v1/checkout-session/:id/initiate', async (req, res) => {
  try {
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx) return res.status(404).json({ error: "Transação não encontrada" });

    // 1. Tenta buscar o gateway da LOJA específica
    let gateway = await prisma.gatewayConfig.findFirst({ 
      where: { store_id: tx.store_id, provider_name: tx.provider_name, is_active: true } 
    });

    // 2. Fallback: Busca o gateway GLOBAL do User
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
       // Estrutura pronta para a Stripe
       return res.json({ provider: 'stripe', client_secret: 'pi_mock_dev_secret' });
    }

    res.status(400).json({ error: "Provedor não suportado para Iniciação de Checkout" });
  } catch (e) { res.status(500).json({ error: "Erro initiate" }); }
});

app.listen(8081, '0.0.0.0', () => console.log('🚀 NeXFlowX Core Bank API (SaaS Routing) ON'));
