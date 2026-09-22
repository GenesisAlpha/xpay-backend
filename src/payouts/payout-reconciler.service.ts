import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  PayoutExecutionRepository,
  PayoutOrchestratorService,
} from './payout-orchestrator.service';

const RECONCILE_CRON = process.env.PAYOUT_RECONCILE_CRON?.trim() || '*/5 * * * *';
const SYSTEM_ADMIN = {
  managerId: 'system:payout-reconciler',
  role: 'admin',
} as const;

@Injectable()
export class PayoutReconcilerService {
  private readonly logger = new Logger(PayoutReconcilerService.name);
  private running = false;

  constructor(
    private readonly repository: PayoutExecutionRepository,
    private readonly orchestrator: PayoutOrchestratorService,
  ) {}

  @Cron(RECONCILE_CRON)
  async handleScheduledReconciliation() {
    const result = await this.reconcileStaleExecutions(new Date());
    this.logger.log(`Payout reconciliation: ${JSON.stringify(result)}`);
  }

  async reconcileStaleExecutions(now: Date) {
    if (this.running) return { skipped: true, reason: 'already_running' };
    this.running = true;
    try {
      const staleBefore = new Date(
        now.getTime() - reconciliationStaleMs(),
      ).toISOString();
      const [executions, unresolvedCreates] = await Promise.all([
        this.repository.listStaleExecutions(
          staleBefore,
          reconciliationBatchSize(),
        ),
        this.repository.countUnresolvedProviderCreates(staleBefore),
      ]);
      let reconciled = 0;
      let manualRequired = unresolvedCreates;
      let failed = 0;
      for (const execution of executions) {
        if (
          !execution.providerPayoutId &&
          execution.providerCreateStartedAt &&
          !execution.providerCreateResolvedAt
        ) {
          continue;
        }
        try {
          await this.orchestrator.reconcileOne(execution.id, SYSTEM_ADMIN);
          reconciled += 1;
        } catch (error) {
          failed += 1;
          this.logger.error(
            `Payout reconciliation failed for ${execution.id}`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return {
        scanned: executions.length + unresolvedCreates,
        reconciled,
        manualRequired,
        failed,
      };
    } finally {
      this.running = false;
    }
  }
}

function reconciliationStaleMs(): number {
  const configured = Number(process.env.PAYOUT_RECONCILE_STALE_MS);
  return Number.isInteger(configured) && configured >= 10_000
    ? configured
    : 5 * 60 * 1000;
}

function reconciliationBatchSize(): number {
  const configured = Number(process.env.PAYOUT_RECONCILE_BATCH_SIZE);
  return Number.isInteger(configured) && configured >= 1 && configured <= 100
    ? configured
    : 50;
}
