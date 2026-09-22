import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PayoutExecutionRepository,
  PayoutOrchestratorService,
} from './payout-orchestrator.service';
import { WhopPayoutClient } from './whop-payout.client';

const PAYOUT_EVENTS = new Set([
  'payout.created',
  'payout.updated',
  'payout.reversed',
]);
const PAYOUT_ID_PATTERN = /^wdrl_[A-Za-z0-9_]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VerifiedWhopPayoutEvent {
  id?: string;
  type: string;
  data?: {
    id?: string;
    metadata?: Record<string, unknown>;
  };
}

@Injectable()
export class WhopPayoutWebhookService {
  constructor(
    private readonly repository: PayoutExecutionRepository,
    private readonly whop: WhopPayoutClient,
    private readonly orchestrator: PayoutOrchestratorService,
  ) {}

  handles(eventType: string): boolean {
    return PAYOUT_EVENTS.has(eventType);
  }

  async handleVerifiedEvent(
    event: VerifiedWhopPayoutEvent,
    signingAccountId: string,
  ) {
    if (!this.handles(event.type)) {
      return { ignored: true, reason: 'not_payout_event' };
    }
    const providerPayoutId = String(event.data?.id ?? '').trim();
    if (!PAYOUT_ID_PATTERN.test(providerPayoutId)) {
      throw new ConflictException('Webhook de payout sem ID válido.');
    }
    const metadata = event.data?.metadata ?? {};
    const localPayoutId = stringValue(metadata.koopfy_payout_id);
    const connectedAccountId = stringValue(metadata.koopfy_account_id);
    const masterAccountId = stringValue(metadata.koopfy_master_account_id);
    if (masterAccountId && masterAccountId !== signingAccountId) {
      throw new ConflictException(
        'Webhook de payout assinado por uma conta diferente da metadata.',
      );
    }

    let execution = await this.repository.findByProviderPayoutId(
      providerPayoutId,
    );
    if (!execution && localPayoutId && UUID_PATTERN.test(localPayoutId)) {
      execution = await this.repository.findByReference(localPayoutId);
    }
    if (!execution) {
      if (localPayoutId) {
        throw new ServiceUnavailableException(
          'Payout Koopfy ainda não encontrado para este webhook.',
        );
      }
      return { ignored: true, reason: 'not_koopfy_owned' };
    }
    if (
      connectedAccountId &&
      connectedAccountId !== execution.providerAccountId
    ) {
      throw new ConflictException(
        'Webhook de payout não pertence à conta conectada registrada.',
      );
    }

    const payout = await this.whop.retrievePayout(
      providerPayoutId,
      execution.providerAccountId,
    );
    return this.orchestrator.applyVerifiedProviderPayout(
      execution.id,
      payout,
      `Webhook Whop ${event.id ?? providerPayoutId}`,
    );
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
