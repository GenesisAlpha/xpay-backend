import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { supabase } from '../lib/supabase.client';

@Injectable()
export class SettlementCronService {
  private readonly logger = new Logger(SettlementCronService.name);
  private running = false;

  @Cron('*/5 * * * *') // 👈 mudei pra a cada 5 minutos enquanto estabiliza
  async handleSettlement() {
    if (this.running) {
      this.logger.warn('Already running, skipping');
      return;
    }
    this.running = true;

    let totalProcessed = 0;
    let totalErrors = 0;

    try {
      const BATCH_SIZE = 20;          // 👈 reduzi pra 20
      const MAX_BATCHES = 5;          // 👈 reduzi pra 5 (max 100 entries por execução)
      const MAX_ERRORS = 10;          // 👈 circuit breaker: para se errar muito

      // available_at em formato compatível com timestamp (sem 'Z')
      const now = new Date().toISOString().replace('Z', '');

      for (let i = 0; i < MAX_BATCHES; i++) {
        if (totalErrors >= MAX_ERRORS) {
          this.logger.error(`Circuit breaker: ${totalErrors} erros, abortando execução`);
          break;
        }

        const { data: entries, error } = await supabase
          .from('wallet_ledger')
          .select('*')
          .eq('type', 'credit_pending')
          .eq('status', 'pending')
          .lte('available_at', now)
          .limit(BATCH_SIZE);

        if (error) {
          this.logger.error('Fetch error', error);
          return;
        }
        if (!entries?.length) break;

        for (const entry of entries) {
          const ok = await this.processEntry(entry);
          if (ok) totalProcessed++;
          else totalErrors++;
        }
      }

      this.logger.log(`Settlement: ${totalProcessed} processadas, ${totalErrors} erros`);
    } finally {
      this.running = false;
    }
  }

  /** retorna true se processou com sucesso, false se deu erro */
  async processEntry(entry: any): Promise<boolean> {
    try {
      // 🔒 lock otimista: pending -> hold
      const { data: updated, error: lockError } = await supabase
        .from('wallet_ledger')
        .update({ status: 'hold' })
        .eq('id', entry.id)
        .eq('status', 'pending')
        .select()
        .single();

      if (lockError) {
        this.logger.error(`Lock failed for ${entry.id}`, lockError);
        return false;
      }
      if (!updated) return false; // outro worker pegou, ou status mudou

      // 💰 move saldo
      const { error: rpcError } = await supabase.rpc('move_pending_to_available', {
        p_seller_id: entry.seller_id,
        p_amount: entry.amount,
      });
      if (rpcError) throw rpcError;

      // 🧾 cria ledger de release com status válido
      const { error: insertError } = await supabase.from('wallet_ledger').insert({
        seller_id: entry.seller_id,
        transaction_id: entry.transaction_id,
        type: 'release_to_available',
        amount: entry.amount,
        currency: entry.currency,
        status: 'completed',
        created_at: new Date().toISOString(),
      });
      if (insertError) throw insertError;

      // ✅ finaliza: hold -> completed
      const { error: finalError } = await supabase
        .from('wallet_ledger')
        .update({ status: 'completed' })
        .eq('id', entry.id);
      if (finalError) throw finalError;

      return true;

    } catch (err: any) {
      // 🚨 LOG DETALHADO — pra finalmente entender qual é o erro
      this.logger.error(
        `Process error on entry ${entry.id}`,
        JSON.stringify({
          message: err?.message,
          code: err?.code,
          details: err?.details,
          hint: err?.hint,
          full: err,
        }, null, 2),
      );

      // ⚠️ NÃO volta pra 'pending' (causaria reprocessamento e risco de saldo duplicado)
      // ⚠️ Deixa em 'hold' pra investigação manual
      // (entries em 'hold' NÃO são pegas pelo cron porque o filtro é status='pending')
      return false;
    }
  }
}