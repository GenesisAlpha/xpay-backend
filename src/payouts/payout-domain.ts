import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import {
  FeeRule,
  PayoutLocalState,
  PreviewConfirmationFields,
  RestorablePayout,
  WhopPayoutStatus,
} from './payout.types';

const MIN_PREVIEW_SECRET_BYTES = 32;

const PROVIDER_STATE: Record<WhopPayoutStatus, PayoutLocalState> = {
  requested: 'processing',
  in_review: 'processing',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
  canceled: 'canceled',
  denied: 'denied',
  reversed: 'reversed',
};

const NEXT_STATES: Record<PayoutLocalState, readonly PayoutLocalState[]> = {
  pending_review: ['dispatching', 'rejected'],
  dispatching: ['processing', 'requote_required', 'dispatch_failed'],
  processing: ['completed', 'failed', 'canceled', 'denied', 'reversed'],
  completed: ['reversed'],
  failed: [],
  canceled: [],
  denied: [],
  reversed: [],
  rejected: [],
  requote_required: ['pending_review', 'rejected'],
  dispatch_failed: ['dispatching', 'rejected'],
};

const RESTORABLE_STATES = new Set<PayoutLocalState>([
  'failed',
  'canceled',
  'denied',
  'reversed',
]);

function assertInteger(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} deve usar unidades mínimas inteiras.`);
  }
}

function assertFeeRule(rule: FeeRule): void {
  assertInteger(rule.percentageBps, 'Percentual da taxa');
  assertInteger(rule.fixedUsdCents, 'Taxa fixa');
  if (rule.percentageBps > 10_000) {
    throw new Error('Percentual da taxa deve ser de no máximo 100%.');
  }
}

export function calculateKoopfyFee(
  grossMinor: number,
  rule: FeeRule,
): number {
  assertInteger(grossMinor, 'Valor bruto', 1);
  assertFeeRule(rule);
  return (
    Math.ceil((grossMinor * rule.percentageBps) / 10_000) +
    rule.fixedUsdCents
  );
}

export function providerPayoutMinor(
  grossMinor: number,
  koopfyFeeMinor: number,
): number {
  assertInteger(grossMinor, 'Valor bruto', 1);
  assertInteger(koopfyFeeMinor, 'Taxa Koopfy');
  const amount = grossMinor - koopfyFeeMinor;
  if (amount <= 0) {
    throw new Error('O valor líquido para o payout deve ser positivo.');
  }
  return amount;
}

export function providerIdempotencyKey(payoutId: string): string {
  const normalized = payoutId.trim();
  if (!normalized) {
    throw new Error('Identificador local do payout é obrigatório.');
  }
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `koopfy_payout_${digest.slice(0, 40)}`;
}

export function mapWhopPayoutState(status: string): PayoutLocalState {
  const mapped = PROVIDER_STATE[status as WhopPayoutStatus];
  if (!mapped) {
    throw new Error('Status de payout não reconhecido.');
  }
  return mapped;
}

export function canAdvanceState(
  from: PayoutLocalState,
  to: PayoutLocalState,
): boolean {
  return from === to || NEXT_STATES[from].includes(to);
}

export function canRestoreFunds(payout: RestorablePayout): boolean {
  return (
    RESTORABLE_STATES.has(payout.state) &&
    Boolean(payout.fundsReturnedAt) &&
    !payout.walletRestoredAt
  );
}

function previewPayload(
  fields: PreviewConfirmationFields,
  sellerId: string,
): string {
  const normalizedSeller = sellerId.trim();
  const normalizedMethod = fields.methodId.trim();
  if (!normalizedSeller || !normalizedMethod) {
    throw new Error('Seller e método do preview são obrigatórios.');
  }
  assertInteger(fields.grossMinor, 'Valor bruto', 1);
  assertInteger(fields.confirmedMinimumNetMinor, 'Valor líquido confirmado');
  if (!fields.previewExpiresAt.trim()) {
    throw new Error('Expiração do preview é obrigatória.');
  }
  return JSON.stringify([
    normalizedSeller,
    normalizedMethod,
    fields.speed?.trim() || null,
    fields.grossMinor,
    fields.confirmedMinimumNetMinor,
    fields.previewExpiresAt.trim(),
  ]);
}

function previewSecret(secret: string): Buffer {
  const value = Buffer.from(secret, 'utf8');
  if (value.byteLength < MIN_PREVIEW_SECRET_BYTES) {
    throw new Error(
      'PAYOUT_PREVIEW_HMAC_SECRET deve possuir pelo menos 32 bytes.',
    );
  }
  return value;
}

export function signPreviewConfirmation(
  fields: PreviewConfirmationFields,
  sellerId: string,
  secret: string,
): string {
  return createHmac('sha256', previewSecret(secret))
    .update(previewPayload(fields, sellerId))
    .digest('base64url');
}

export function verifyPreviewConfirmation(
  fields: PreviewConfirmationFields,
  sellerId: string,
  token: string,
  secret: string,
): boolean {
  const expected = Buffer.from(
    signPreviewConfirmation(fields, sellerId, secret),
    'utf8',
  );
  const received = Buffer.from(token, 'utf8');
  return (
    expected.byteLength === received.byteLength &&
    timingSafeEqual(expected, received)
  );
}
