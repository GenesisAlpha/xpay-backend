import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { supabase } from '../lib/supabase.client';

@Injectable()
export class SettlementCronService {
  private readonly logger = new Logger(SettlementCronService.name);
  private running = false;

  @Cron('*/5 * * * *') // a cada 5 minutos
  async handleSettlement() {
    if (this.running) {
      this.logger.warn('Already running, skipping');
      return;
    }
    this.running = true;

    let totalReleased = 0;
    let totalAmount = 0;

    try {
      const BATCH_SIZE = 100;
      const MAX_BATCHES = 5; // no máximo 500 entries por execução

      for (let i = 0; i < MAX_BATCHES; i++) {
        // 💰 toda a lógica (filtro de rastreio + move pending→available + ledger)
        //    roda atômica no banco. Pedidos SEM rastreio NÃO são liberados.
        const { data, error } = await supabase.rpc('run_settlement_batch', {
          p_limit: BATCH_SIZE,
        });

        if (error) {
          this.logger.error('run_settlement_batch error', error);
          break;
        }

        const row = Array.isArray(data) ? data[0] : data;
        const released = Number(row?.released_count ?? 0);
        totalReleased += released;
        totalAmount += Number(row?.total_amount ?? 0);

        if (released < BATCH_SIZE) break; // não há mais o que liberar
      }

      // Reservas vencidas voltam ao disponível; as de vendas estornadas são canceladas.
      const { data: reserveData, error: reserveError } = await supabase.rpc('run_reserve_release_batch', { p_limit: 500 });
      if (reserveError) {
        this.logger.error('run_reserve_release_batch error', reserveError);
      } else {
        const reserveRow = Array.isArray(reserveData) ? reserveData[0] : reserveData;
        if (Number(reserveRow?.released_count ?? 0) > 0) {
          this.logger.log(`Reservas liberadas: ${reserveRow.released_count} (${reserveRow.total_amount} cents)`);
        }
      }

      this.logger.log(
        `Settlement: ${totalReleased} liberadas (${totalAmount} cents) — apenas pedidos com rastreio`,
      );
    } catch (err: any) {
      this.logger.error('Settlement failed', err?.message ?? err);
    } finally {
      this.running = false;
    }
  }
}
