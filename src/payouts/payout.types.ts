export type PayoutMethodKey =
  | 'pix'
  | 'bank_wire'
  | 'ach_instant'
  | 'ach_next_day'
  | 'ach_standard'
  | 'crypto';

export type PayoutLocalState =
  | 'pending_review'
  | 'dispatching'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'denied'
  | 'reversed'
  | 'rejected'
  | 'requote_required'
  | 'dispatch_failed';

export type WhopPayoutStatus =
  | 'requested'
  | 'in_review'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'denied'
  | 'reversed';

export interface FeeRule {
  percentageBps: number;
  fixedUsdCents: number;
}

export interface PreviewConfirmationFields {
  methodId: string;
  speed: string | null;
  grossMinor: number;
  confirmedMinimumNetMinor: number;
  previewExpiresAt: string;
}

export interface PublicSavedPayoutMethod {
  id: string;
  methodKey: PayoutMethodKey;
  label: string;
  maskedReference: string;
  currency: string | null;
  country: string | null;
  network: string | null;
  speeds: string[];
  isDefault: boolean;
  status: 'active' | 'inactive' | 'restricted';
}

export interface PayoutReadiness {
  status:
    | 'provisioning'
    | 'verification_required'
    | 'under_review'
    | 'ready'
    | 'restricted'
    | 'error';
  payoutsEnabled: boolean;
  verificationActionUrl: string | null;
  blockerCode: string | null;
  blockerMessage: string | null;
  methods: PublicSavedPayoutMethod[];
}

export interface PayoutPreview extends PreviewConfirmationFields {
  methodKey: PayoutMethodKey;
  consolidatedFeeMinor: number;
  netMinor: number;
  sourceCurrency: 'USD';
  destinationCurrency: string;
  destinationAmountMinor: number;
  exchangeRate: string | null;
  estimatedArrival: string | null;
  expiresAt: string;
  confirmationToken: string;
}

export interface ConfirmPayoutRequest extends PreviewConfirmationFields {
  confirmationToken: string;
}

export interface RestorablePayout {
  state: PayoutLocalState;
  fundsReturnedAt: string | null;
  walletRestoredAt: string | null;
}
