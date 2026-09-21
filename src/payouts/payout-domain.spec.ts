import {
  calculateKoopfyFee,
  canAdvanceState,
  canRestoreFunds,
  mapWhopPayoutState,
  providerIdempotencyKey,
  providerPayoutMinor,
  signPreviewConfirmation,
  verifyPreviewConfirmation,
} from './payout-domain';

describe('payout domain', () => {
  it('rounds percentage up and adds the fixed fee', () => {
    expect(
      calculateKoopfyFee(11_990, {
        percentageBps: 200,
        fixedUsdCents: 300,
      }),
    ).toBe(540);
    expect(
      calculateKoopfyFee(10_001, {
        percentageBps: 50,
        fixedUsdCents: 300,
      }),
    ).toBe(351);
  });

  it('rejects invalid minor-unit values and fees that consume the gross', () => {
    expect(() =>
      calculateKoopfyFee(119.9, {
        percentageBps: 200,
        fixedUsdCents: 300,
      }),
    ).toThrow('unidades mínimas');
    expect(() => providerPayoutMinor(300, 300)).toThrow('valor líquido');
    expect(() => providerPayoutMinor(299, 300)).toThrow('valor líquido');
    expect(providerPayoutMinor(11_990, 540)).toBe(11_450);
  });

  it('generates a stable provider idempotency key without exposing the payout id', () => {
    const first = providerIdempotencyKey('internal-payout-1');
    const replay = providerIdempotencyKey('internal-payout-1');
    const other = providerIdempotencyKey('internal-payout-2');

    expect(first).toMatch(/^koopfy_payout_[0-9a-f]{40}$/);
    expect(first).toBe(replay);
    expect(first).not.toBe(other);
    expect(first).not.toContain('internal-payout-1');
  });

  it.each([
    ['requested', 'processing'],
    ['in_review', 'processing'],
    ['processing', 'processing'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['canceled', 'canceled'],
    ['denied', 'denied'],
    ['reversed', 'reversed'],
  ] as const)('maps provider status %s to %s', (provider, local) => {
    expect(mapWhopPayoutState(provider)).toBe(local);
  });

  it('rejects an unknown provider status instead of guessing', () => {
    expect(() => mapWhopPayoutState('queued_elsewhere')).toThrow(
      'Status de payout não reconhecido.',
    );
  });

  it('enforces forward-only state transitions including completed reversal', () => {
    expect(canAdvanceState('pending_review', 'dispatching')).toBe(true);
    expect(canAdvanceState('dispatching', 'processing')).toBe(true);
    expect(canAdvanceState('processing', 'completed')).toBe(true);
    expect(canAdvanceState('completed', 'reversed')).toBe(true);
    expect(canAdvanceState('completed', 'processing')).toBe(false);
    expect(canAdvanceState('failed', 'processing')).toBe(false);
    expect(canAdvanceState('reversed', 'completed')).toBe(false);
  });

  it('restores only terminal returned funds that were not restored before', () => {
    expect(
      canRestoreFunds({
        state: 'failed',
        fundsReturnedAt: null,
        walletRestoredAt: null,
      }),
    ).toBe(false);
    expect(
      canRestoreFunds({
        state: 'processing',
        fundsReturnedAt: '2026-09-21T12:00:00Z',
        walletRestoredAt: null,
      }),
    ).toBe(false);
    expect(
      canRestoreFunds({
        state: 'reversed',
        fundsReturnedAt: '2026-09-21T12:00:00Z',
        walletRestoredAt: null,
      }),
    ).toBe(true);
    expect(
      canRestoreFunds({
        state: 'reversed',
        fundsReturnedAt: '2026-09-21T12:00:00Z',
        walletRestoredAt: '2026-09-21T12:01:00Z',
      }),
    ).toBe(false);
  });

  it('binds the preview proof to seller and every confirmed field', () => {
    const preview = {
      methodId: 'method-1',
      speed: 'standard',
      grossMinor: 11_990,
      confirmedMinimumNetMinor: 10_810,
      previewExpiresAt: '2026-09-21T15:00:00Z',
    };
    const secret = 'test-secret-at-least-32-bytes-long';
    const token = signPreviewConfirmation(preview, 'seller-1', secret);

    expect(verifyPreviewConfirmation(preview, 'seller-1', token, secret)).toBe(
      true,
    );
    expect(
      verifyPreviewConfirmation(
        { ...preview, grossMinor: 12_000 },
        'seller-1',
        token,
        secret,
      ),
    ).toBe(false);
    expect(verifyPreviewConfirmation(preview, 'seller-2', token, secret)).toBe(
      false,
    );
    expect(
      verifyPreviewConfirmation(
        preview,
        'seller-1',
        `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`,
        secret,
      ),
    ).toBe(false);
  });

  it('requires a strong preview signing secret', () => {
    expect(() =>
      signPreviewConfirmation(
        {
          methodId: 'method-1',
          speed: null,
          grossMinor: 11_990,
          confirmedMinimumNetMinor: 10_810,
          previewExpiresAt: '2026-09-21T15:00:00Z',
        },
        'seller-1',
        'short-secret',
      ),
    ).toThrow('PAYOUT_PREVIEW_HMAC_SECRET');
  });
});
