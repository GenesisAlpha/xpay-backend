process.env.KOOPFY_PLATFORM_WALLET_REF = process.env.KOOPFY_PLATFORM_WALLET_REF ?? 'wallet-test';

jest.mock('../lib/supabase.client', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }));

import { PaymentService } from './payments.service';

// A tela de resultado pergunta de 3 em 3 segundos; a confirmação na fonte só
// pode virar chamada à Whop quando faz sentido, e uma vez a cada 2 s.
describe('confirmação na fonte (upsell da espera)', () => {
  const service = Object.create(PaymentService.prototype) as any;
  const whopStatus = jest.fn();
  const handleWebhookProvider = jest.fn().mockResolvedValue({});

  const tx = (overrides: Record<string, unknown> = {}) => ({
    id: `tx-${Math.random()}`,
    status: 'pending',
    provider: 'whop',
    provider_account_id: 'whop_main',
    metadata: { whop_payment_id: 'pay_1' },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service.normalizeProviderName = (p: string) => String(p ?? '').toLowerCase();
    service.accountRouter = { resolveAccountById: jest.fn().mockResolvedValue({ apiKey: 'k', api_url: 'https://api.whop.test' }) };
    service.webhookService = { handleWebhookProvider };
    jest.spyOn(require('../orchestrator/providers/whop.provider').WhopProvider.prototype, 'getPaymentStatus')
      .mockImplementation(whopStatus as never);
  });

  it('aplica o pagamento que a Whop já confirmou, sem esperar o aviso', async () => {
    whopStatus.mockResolvedValue({ status: 'paid', raw: {} });
    await expect(service.confirmAtProvider(tx())).resolves.toBe(true);
    expect(handleWebhookProvider).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PAID', type: 'TRANSACTION' }),
    );
  });

  it('aplica a recusa do mesmo jeito', async () => {
    whopStatus.mockResolvedValue({ status: 'failed', raw: {} });
    await expect(service.confirmAtProvider(tx())).resolves.toBe(true);
    expect(handleWebhookProvider).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
  });

  it('não decide nada enquanto a Whop não decidiu', async () => {
    whopStatus.mockResolvedValue({ status: 'open', raw: {} });
    await expect(service.confirmAtProvider(tx())).resolves.toBe(false);
    expect(handleWebhookProvider).not.toHaveBeenCalled();
  });

  it('não pergunta por transação já aprovada, nem sem pagamento no provedor', async () => {
    await expect(service.confirmAtProvider(tx({ status: 'approved' }))).resolves.toBe(false);
    await expect(service.confirmAtProvider(tx({ metadata: {} }))).resolves.toBe(false);
    expect(whopStatus).not.toHaveBeenCalled();
  });

  it('duas consultas seguidas da mesma transação viram uma só chamada', async () => {
    whopStatus.mockResolvedValue({ status: 'open', raw: {} });
    const same = tx();
    await service.confirmAtProvider(same);
    await service.confirmAtProvider(same);
    expect(whopStatus).toHaveBeenCalledTimes(1);
  });

  it('falha na consulta não quebra a tela: segue esperando o webhook', async () => {
    whopStatus.mockRejectedValue(new Error('timeout'));
    await expect(service.confirmAtProvider(tx())).resolves.toBe(false);
  });
});

// A lista de métodos da Whop disse "não cobrável" para um cartão recém salvo e
// toda oferta virou "não está mais disponível". Ela não pode mais reprovar
// ninguém sozinha.
describe('elegibilidade do upsell não é derrubada pela lista de métodos', () => {
  const service = Object.create(PaymentService.prototype) as any;

  it('não consulta a Whop enquanto a checagem não for ligada de propósito', async () => {
    delete process.env.WHOP_UPSELL_METHOD_CHECK;
    service.accountRouter = { resolveAccountById: jest.fn() };
    await expect(service.savedMethodChargeable({ provider_account_id: 'whop_main', metadata: {} }))
      .resolves.toBeNull();
    expect(service.accountRouter.resolveAccountById).not.toHaveBeenCalled();
  });
});
