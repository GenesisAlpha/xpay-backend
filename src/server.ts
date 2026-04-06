import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';

// Importamos as nossas novas rotas e middlewares modulares
import apiRoutes from './routes/api.routes';
import { authenticateUser } from './middleware/auth.middleware';

dotenv.config();
const app = express();
const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' as any });
const JWT_SECRET = process.env.JWT_SECRET || 'nexflowx-dev-sandbox-2026';

app.use(cors({ origin: true, methods: ['GET', 'POST', 'PATCH', 'OPTIONS', 'PUT'], allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'] }));
app.use(express.json());

const isAssetWallet = (type: string) => type === 'treasury' || type === 'fx_pool';

// ==========================================
// 🔗 AS NOVAS ROTAS MODULARES (ZOD + LEDGER SERVICE)
// ==========================================
app.use('/api/v1', apiRoutes);

// ==========================================
// 🔐 AUTENTICAÇÃO E LEITURA (MANTIDAS)
// ==========================================
app.post('/api/v1/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || user.password_hash !== password) return res.status(401).json({ error: "Credenciais inválidas" });
  const token = jwt.sign({ id: user.id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.get('/api/v1/wallets', authenticateUser, async (req, res) => {
  const user = (req as any).user;
  const whereClause = user.role === 'admin' ? { type: { in: ['treasury', 'fee', 'fx_pool'] } } : { user_id: user.id };
  const wallets = await prisma.wallet.findMany({ where: whereClause, orderBy: { currency_code: 'asc' } });
  res.json({ data: wallets });
});

app.get('/api/v1/ledger', authenticateUser, async (req, res) => {
  const user = (req as any).user;
  const wallets = await prisma.wallet.findMany({ where: { user_id: user.id }, select: { id: true } });
  const entries = await prisma.ledgerEntry.findMany({
    where: { wallet_id: { in: wallets.map(w => w.id) } },
    include: { ledger_transaction: true },
    orderBy: { created_at: 'desc' },
    take: 50
  });
  
  const formatted = entries.map(e => ({
    id: e.id,
    transaction_id: e.ledger_transaction_id,
    type: e.ledger_transaction.type,
    status: e.ledger_transaction.status,
    direction: e.direction,
    amount: e.amount,
    currency: e.currency_code,
    description: e.ledger_transaction.description,
    created_at: e.created_at
  }));
  res.json({ data: formatted });
});

app.get('/api/v1/action-tickets', authenticateUser, async (req, res) => {
  if ((req as any).user.role !== 'admin') return res.status(403).json({ error: "Acesso negado" });
  const tickets = await prisma.actionTicket.findMany({ where: { status: 'open' }, include: { merchant: { select: { username: true } } }, orderBy: { created_at: 'asc' } });
  res.json({ data: tickets });
});

app.post('/api/v1/action-tickets/:id/approve', authenticateUser, async (req, res) => {
  if ((req as any).user.role !== 'admin') return res.status(403).json({ error: "Acesso negado" });
  try {
    const ticket = await prisma.actionTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket || ticket.status !== 'open') return res.status(400).json({ error: "Ticket inválido" });

    if (ticket.type === 'PAYOUT_APPROVAL' || ticket.type === 'MANUAL_CLEARING') {
       const ledgerTx = await prisma.ledgerTransaction.findUnique({ where: { id: ticket.reference_id! }, include: { entries: { include: { wallet: true } } } });
       await prisma.$transaction(async (tx) => {
         await tx.ledgerTransaction.update({ where: { id: ledgerTx!.id }, data: { status: 'cleared', cleared_at: new Date() } });
         if (ticket.type === 'MANUAL_CLEARING') {
           for (const e of ledgerTx!.entries) {
             const isAsset = isAssetWallet(e.wallet.type);
             const isAddition = isAsset ? e.direction === 'DEBIT' : e.direction === 'CREDIT';
             if (isAddition) await tx.wallet.update({ where: { id: e.wallet_id }, data: { balance_available: { increment: e.amount } } });
           }
         }
         await tx.actionTicket.update({ where: { id: ticket.id }, data: { status: 'resolved', assignee_id: (req as any).user.id, updated_at: new Date() } });
       });
    }
    res.json({ success: true, message: "Ticket aprovado." });
  } catch (e) { res.status(500).json({ error: "Erro ao aprovar" }); }
});

// ==========================================
// 💳 SISTEMA DE CHECKOUT (RESTAURADO!)
// ==========================================
app.post('/api/v1/payment-links', authenticateUser, async (req, res) => {
  try {
    const user_id = (req as any).user.id;
    const tx = await prisma.transaction.create({ data: { amount: Number(req.body.amount), currency: String(req.body.currency || 'EUR').toUpperCase(), status: 'pending' as any, provider_name: 'pending', payee_id: user_id, country_code: 'UNKNOWN', payment_method: 'PENDING', fee_amount: 0, net_amount: 0 } });
    res.status(201).json({ data: { id: tx.id, shareable_url: "https://api-dev.nexflowx.tech/checkout/" + tx.id } });
  } catch (e: any) { res.status(500).json({ error: "Erro link" }); }
});

app.get(['/checkout/:id', '/:id'], async (req, res) => {
  try {
    const tx = await prisma.transaction.findUnique({ where: { id: req.params.id } });
    if (!tx) return res.status(404).send('Expirado');
    const session = await stripe.checkout.sessions.create({ line_items: [{ price_data: { currency: tx.currency.toLowerCase(), product_data: { name: 'NeXFlowX Deposit' }, unit_amount: Math.round(Number(tx.amount) * 100) }, quantity: 1 }], mode: 'payment', success_url: 'https://api-dev.nexflowx.tech/success', cancel_url: 'https://api-dev.nexflowx.tech/cancel', client_reference_id: tx.id, payment_intent_data: { metadata: { txId: tx.id } } });
    return res.redirect(303, session.url!);
  } catch (err: any) { res.status(500).send('Error.'); }
});

app.get('/success', (req, res) => res.send('✅ Pagamento Confirmado. Pode fechar esta janela.'));
app.get('/cancel', (req, res) => res.send('❌ Pagamento Cancelado.'));

// O MOTOR LIGA AQUI:
app.listen(8080, '0.0.0.0', () => console.log('🚀 NeXFlowX v5.3.0-FINAL UP'));
