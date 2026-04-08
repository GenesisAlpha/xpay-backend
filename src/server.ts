import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

import apiRoutes from './routes/api.routes';
import { authenticateUser } from './middleware/auth.middleware';

dotenv.config();
const app = express();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'nexflowx-dev-sandbox-2026';

app.use(cors({ origin: true, methods: ['GET', 'POST', 'PATCH', 'OPTIONS', 'PUT'], allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'] }));
app.use(express.json());

app.use('/api/v1', apiRoutes);

// ==========================================
// 🛒 CHECKOUT SESSION (FORMATO EXACTO DO DOSSIER)
// ==========================================
app.get('/api/v1/checkout-session/:id', async (req, res) => {
  try {
    const tx = await prisma.transaction.findUnique({ 
      where: { id: req.params.id }, 
      include: { payee: { select: { username: true } } } 
    });
    
    if (!tx) return res.status(404).json({ error: 'Sessão não encontrada' });

    // Resposta formatada conforme o dossier técnico
    res.json({ 
      id: tx.id, 
      amount: Number(tx.amount), 
      currency: tx.currency, 
      merchant_name: tx.payee.username,
      branding: { 
        logo_url: "https://ui-avatars.com/api/?name=" + tx.payee.username + "&background=random", 
        primary_color: "#1a1a2e", 
        accent_color: "#f0ebe3" // Campo obrigatório que faltava
      },
      allowed_methods: ["card"] 
    });
  } catch (err) { res.status(500).json({ error: "Erro interno" }); }
});

// PATCH para Auto-save (Conforme Dossier)
app.patch('/api/v1/checkout-session/:id/customer', async (req, res) => {
  try {
    const { customer_name, customer_email, address, country } = req.body;
    await prisma.transaction.update({
      where: { id: req.params.id },
      data: { customer_email, country_code: country, metadata: { customer_name, address, updated_at: new Date() } }
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Erro save" }); }
});

// POST para Initiate (Conforme Dossier)
app.post('/api/v1/checkout-session/:id/initiate', async (req, res) => {
  try {
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    const gateway = await prisma.gatewayConfig.findFirst({ where: { user_id: tx?.payee_id, provider_name: 'sumup', is_active: true } });
    
    if (!gateway) return res.status(500).json({ error: "Gateway offline" });

    const response = await fetch('https://api.sumup.com/v0.1/checkouts', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${gateway.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Number(tx?.amount), currency: tx?.currency, checkout_reference: tx?.id, merchant_code: gateway.merchant_id })
    });
    const data = await response.json();
    res.json({ provider: 'sumup', checkout_id: data.id });
  } catch (e) { res.status(500).json({ error: "Erro initiate" }); }
});

app.listen(8080, '0.0.0.0', () => console.log('🚀 NeXFlowX API v5.5.5 - DOSSIER COMPLIANT'));
