import { clipFailureReason } from './clip-failure-reason';

describe('clipFailureReason', () => {
  it('3DS abandonado ganha texto em português e o código cru', () => {
    expect(clipFailureReason('CA-AUT01', 'Cancelled')).toEqual({
      failure_code: 'CA-AUT01',
      failure_message: 'Clip CA-AUT01 (Cancelled): 3DS não concluído: o comprador não terminou a verificação do banco e a Clip cancelou',
    });
  });
  it('código desconhecido usa a mensagem da Clip', () => {
    expect(clipFailureReason('RE-XYZ', 'Insufficient funds')?.failure_message).toBe('Clip RE-XYZ: Insufficient funds');
  });
  it('sem nada, não inventa motivo', () => {
    expect(clipFailureReason(null, null)).toBeNull();
  });
});
