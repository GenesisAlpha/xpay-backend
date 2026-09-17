import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabase } from '../lib/supabase.client'

/**
 * Move a comissão de afiliado de pending para available quando vence a carência.
 *
 * Separado do settlement da venda porque `run_settlement_batch` só olha
 * `credit_pending` e exige rastreio sincronizado em produto físico. Comissão é
 * receita da Koopfy, não mercadoria — não há envio para esperar.
 */
@Injectable()
export class AffiliateSettlementCron {
  private readonly logger = new Logger(AffiliateSettlementCron.name)
  private running = false

  @Cron('*/10 * * * *')
  async handle() {
    if (this.running) {
      this.logger.warn('Já em execução, pulando')
      return
    }
    this.running = true

    let totalReleased = 0
    let totalAmount = 0

    try {
      const BATCH_SIZE = 100
      const MAX_BATCHES = 5

      for (let i = 0; i < MAX_BATCHES; i++) {
        const { data, error } = await supabase.rpc('run_affiliate_settlement_batch', {
          p_limit: BATCH_SIZE,
        })

        if (error) {
          this.logger.error(`run_affiliate_settlement_batch: ${error.message}`)
          break
        }

        const row = Array.isArray(data) ? data[0] : data
        const released = Number(row?.released_count ?? 0)
        totalReleased += released
        totalAmount += Number(row?.total_amount ?? 0)

        if (released < BATCH_SIZE) break
      }

      if (totalReleased > 0) {
        this.logger.log(`Comissões liberadas: ${totalReleased} (${totalAmount} cents)`)
      }
    } catch (err: any) {
      this.logger.error(`Falhou: ${err?.message ?? err}`)
    } finally {
      this.running = false
    }
  }
}
