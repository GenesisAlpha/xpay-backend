jest.mock('../lib/supabase.client', () => ({ supabase: {} }));

import { stripeEventOlderThan } from './webhook.service';

describe('stripeEventOlderThan', () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const hour = 60 * 60 * 1000;

  it('evento recente segue sendo recusado para a Stripe reentregar', () => {
    expect(stripeEventOlderThan({ created: (now - 10 * 60 * 1000) / 1000 }, 2 * hour, now)).toBe(false);
  });

  it('evento antigo é aceito e fica para conciliação', () => {
    expect(stripeEventOlderThan({ created: (now - 3 * hour) / 1000 }, 2 * hour, now)).toBe(true);
  });

  it('sem data não é tratado como antigo', () => {
    expect(stripeEventOlderThan({}, 2 * hour, now)).toBe(false);
    expect(stripeEventOlderThan(null, 2 * hour, now)).toBe(false);
  });
});
