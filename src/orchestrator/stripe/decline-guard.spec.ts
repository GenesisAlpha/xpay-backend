import { declineCodeOf, declineGuardDecision, maxFailedAttempts } from './decline-guard';

describe('trava de recusas por pedido', () => {
  it('recusa comum deixa tentar de novo até o teto', () => {
    expect(declineGuardDecision({ attempts: 1, declineCode: 'insufficient_funds' })).toBeNull();
    expect(declineGuardDecision({ attempts: 3, declineCode: 'incorrect_cvc' })).toBeNull();
    expect(declineGuardDecision({ attempts: 4, declineCode: 'insufficient_funds' })).toBe('too_many_attempts');
  });

  it('recusa definitiva encerra na primeira', () => {
    expect(declineGuardDecision({ attempts: 1, declineCode: 'stolen_card' })).toBe('hard_decline');
    expect(declineGuardDecision({ attempts: 1, declineCode: 'FRAUDULENT' })).toBe('hard_decline');
  });

  it('teto configurável; 0 desliga a contagem mas não a recusa definitiva', () => {
    expect(maxFailedAttempts({})).toBe(4);
    expect(maxFailedAttempts({ STRIPE_MAX_FAILED_ATTEMPTS: '6' })).toBe(6);
    expect(maxFailedAttempts({ STRIPE_MAX_FAILED_ATTEMPTS: 'abc' })).toBe(4);
    expect(declineGuardDecision({ attempts: 50, declineCode: 'do_not_honor', maxAttempts: 0 })).toBeNull();
    expect(declineGuardDecision({ attempts: 1, declineCode: 'lost_card', maxAttempts: 0 })).toBe('hard_decline');
  });

  it('lê o código da recusa do intent', () => {
    expect(declineCodeOf({ last_payment_error: { code: 'card_declined', decline_code: 'stolen_card' } })).toBe('stolen_card');
    expect(declineCodeOf({ last_payment_error: { code: 'expired_card' } })).toBe('expired_card');
    expect(declineCodeOf({})).toBeNull();
  });
});
