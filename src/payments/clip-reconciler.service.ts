import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PaymentService } from './payments.service';

const RECONCILE_CRON = process.env.CLIP_RECONCILE_CRON?.trim() || '* * * * *';

// A Clip não manda webhook: cartão que ficou no 3DS só era confirmado quando a
// tela do comprador perguntava. Aqui o servidor pergunta por quem não voltou.
@Injectable()
export class ClipReconcilerService {
  private readonly logger = new Logger(ClipReconcilerService.name);
  private running = false;

  constructor(private readonly payments: PaymentService) {}

  @Cron(RECONCILE_CRON)
  async handleScheduledReconciliation() {
    if (process.env.CLIP_RECONCILE_DISABLED === 'true') return;
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.payments.reconcilePendingClip(new Date());
      if (result.resolved) this.logger.log(`Clip 3DS: ${JSON.stringify(result)}`);
    } catch (error: any) {
      this.logger.error(`Clip 3DS: ${error?.message ?? error}`);
    } finally {
      this.running = false;
    }
  }
}
