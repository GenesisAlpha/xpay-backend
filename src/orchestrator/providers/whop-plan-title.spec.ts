import { PLAN_TITLE_MAX, maskedPlanTitle } from './whop-plan-title';

describe('maskedPlanTitle', () => {
  it('descreve a venda pela loja e pelo pedido, nunca pelo produto', () => {
    expect(maskedPlanTitle('Spark Reach', '10428')).toBe('Spark Reach · #10428');
  });

  it('nunca passa do limite da API, mesmo com loja comprida', () => {
    const title = maskedPlanTitle('Loja com um nome realmente enorme', '10428');
    expect(title.length).toBeLessThanOrEqual(PLAN_TITLE_MAX);
    // O pedido sobrevive inteiro: é ele que liga o recibo à compra.
    expect(title.endsWith('#10428')).toBe(true);
    expect(title).toContain('…');
  });

  it('sem número de pedido, usa o fim do id da transação', () => {
    expect(maskedPlanTitle('Spark Reach', 'b3f1c2d4-aaaa-bbbb-cccc-ddddeeee1234'))
      .toBe('Spark Reach · #eeee1234');
  });

  it('sem loja conhecida, sobra o pedido', () => {
    expect(maskedPlanTitle(null, '10428')).toBe('Pedido #10428');
    expect(maskedPlanTitle('   ', '10428')).toBe('Pedido #10428');
  });

  it('pedido de 12 dígitos ainda cabe junto com a loja', () => {
    const title = maskedPlanTitle('Spark Reach', '123456789012');
    expect(title).toBe('Spark Reach · #123456789012');
    expect(title.length).toBeLessThanOrEqual(PLAN_TITLE_MAX);
  });

  it('sem espaço para a loja, o pedido vai inteiro em vez de cortado', () => {
    // Limite apertado (outro provider): o número do pedido é o que não pode
    // sair pela metade — é por ele que o atendimento acha a venda.
    expect(maskedPlanTitle('Spark Reach', '10428', 12)).toBe('#10428');
    expect(maskedPlanTitle(null, '10428', 10)).toBe('#10428');
  });

  it('sem loja e sem pedido, ainda devolve algo cobrável', () => {
    expect(maskedPlanTitle(null, '')).toBe('Pedido');
  });
});
