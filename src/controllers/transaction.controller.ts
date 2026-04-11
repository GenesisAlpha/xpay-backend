import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { LedgerService } from '../services/ledger.service';

const prisma = new PrismaClient();

export class TransactionController {
  
  // ==========================================
  // 💱 SWAP (CÂMBIOS) VIA LEDGER
  // ==========================================
  static async swap(req: Request, res: Response) {
    try {
      const user_id = (req as any).user.id;
      const { from_currency, to_currency, amount } = req.body;
      const amountNum = Number(amount);

      if (!from_currency || !to_currency || !amount) return res.status(400).json({ error: "Missing parameters" });

      // 1. Obter a Wallet de Origem
      const walletFrom = await prisma.wallet.findUnique({ 
        where: { user_id_currency_code_type: { user_id, currency_code: from_currency, type: 'merchant' } } 
      });

      if (!walletFrom || Number(walletFrom.balance_available) < amountNum) {
        return res.status(400).json({ error: "Insufficient balance" });
      }

      // 2. Garantir que as Wallets de Destino e Taxa existem
      const walletTo = await prisma.wallet.upsert({
        where: { user_id_currency_code_type: { user_id, currency_code: to_currency, type: 'merchant' } },
        update: {}, create: { user_id, currency_code: to_currency, type: 'merchant' }
      });

      const feeWallet = await prisma.wallet.upsert({
        where: { user_id_currency_code_type: { user_id, currency_code: to_currency, type: 'fee' } },
        update: {}, create: { user_id, currency_code: to_currency, type: 'fee' }
      });

      // 3. Cálculos do Câmbio
      const rate = from_currency === 'EUR' && to_currency === 'USDT' ? 1.08 : 0.92;
      const feePercent = 0.01; 
      const grossToAmount = amountNum * rate;
      const feeAmount = grossToAmount * feePercent;
      const netToAmount = grossToAmount - feeAmount;

      const refId = 'SWAP_' + Date.now();

      // 4. Executar Partidas Dobradas (Com os 6 argumentos corretos!)
      const ledgerTx = await prisma.$transaction(async (tx) => {
        return await LedgerService.commitTransaction(
          'SWAP',                                   // 1. type
          'cleared',                                // 2. status (Instantâneo)
          refId,                                    // 3. reference_id
          `Swap ${amountNum} ${from_currency} to ${netToAmount.toFixed(2)} ${to_currency}`, // 4. description
          [                                         // 5. entries
            { wallet_id: walletFrom.id, direction: 'DEBIT', amount: amountNum, currency_code: from_currency, _type: 'merchant' },
            { wallet_id: walletTo.id, direction: 'CREDIT', amount: netToAmount, currency_code: to_currency, _type: 'merchant' },
            { wallet_id: feeWallet.id, direction: 'CREDIT', amount: feeAmount, currency_code: to_currency, _type: 'fee' }
          ],
          tx                                        // 6. Prisma Transaction
        );
      });

      res.json({ success: true, data: { ledger_tx: ledgerTx.id, from_currency, to_currency, amount_debited: amountNum, amount_credited: netToAmount } });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Internal error" });
    }
  }

  // ==========================================
  // 📤 PAYOUT (LEVANTAMENTOS)
  // ==========================================
  static async payout(req: Request, res: Response) {
    try {
      const user_id = (req as any).user.id;
      const { amount, currency, method, destination } = req.body;
      const amountNum = Number(amount);

      const walletFrom = await prisma.wallet.findUnique({ 
        where: { user_id_currency_code_type: { user_id, currency_code: currency, type: 'merchant' } } 
      });

      if (!walletFrom || Number(walletFrom.balance_available) < amountNum) {
         return res.status(400).json({ error: "Insufficient balance" });
      }

      const payoutResult = await prisma.$transaction(async (tx) => {
        const refId = 'PAYOUT_' + Date.now();
        
        // 1. Tranca o dinheiro (Status: pending cativa o balance_available)
        const ledgerTx = await LedgerService.commitTransaction(
          'PAYOUT',             // 1. type
          'pending',            // 2. status (Aguarda aprovação)
          refId,                // 3. reference_id
          `Hold for Payout to ${destination}`, // 4. description
          [                     // 5. entries
            { wallet_id: walletFrom.id, direction: 'DEBIT', amount: amountNum, currency_code: currency, _type: 'merchant' }
          ],
          tx                    // 6. Prisma Transaction
        );

        // 2. Regista o pedido oficial
        return await tx.payout.create({
          data: {
            user_id, amount: amountNum, currency_code: currency, method, destination,
            status: 'pending', reference_id: ledgerTx.id
          }
        });
      });

      res.json({ success: true, message: "Payout requested and funds secured", data: payoutResult });
    } catch (e: any) {
       res.status(500).json({ error: e.message || "Internal error" });
    }
  }
}
