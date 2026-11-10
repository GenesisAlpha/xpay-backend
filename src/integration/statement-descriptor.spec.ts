import { statementDescriptorFor } from './statement-descriptor';

describe('statementDescriptorFor', () => {
  it('Whop no cartão: WHOP*KOOPFY', () => {
    expect(statementDescriptorFor('whop', 'credit_card', false, {})).toBe('WHOP*KOOPFY');
    expect(statementDescriptorFor('whop', 'apple_pay', false, {})).toBe('WHOP*KOOPFY');
  });
  it('Kaja: KOOPFY + telefone', () => {
    expect(statementDescriptorFor('kaja', 'card', false, { KOOPFY_SUPPORT_PHONE: '+1 555 0100' })).toBe('KOOPFY +1 555 0100');
    expect(statementDescriptorFor('kaja', 'card', false, {})).toBe('KOOPFY');
  });
  it('sem fatura ou sem certeza: null', () => {
    expect(statementDescriptorFor('kontino', 'pix', false, {})).toBeNull();
    expect(statementDescriptorFor('whop', 'credit_card', true, {})).toBeNull();
    expect(statementDescriptorFor('stripe', 'credit_card', false, {})).toBeNull();
  });
});
