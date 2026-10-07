process.env.KOOPFY_PLATFORM_WALLET_REF = process.env.KOOPFY_PLATFORM_WALLET_REF ?? 'wallet-test';

jest.mock('../lib/supabase.client', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }));

import { supabase } from '../lib/supabase.client';
import { PaymentService } from './payments.service';

// Upsell de um clique na Clip: sem cartão salvo, a oferta vale enquanto houver
// token extra da compra; e o 3DS (sem webhook da Clip) é confirmado na fonte.

function parentQuery(row: any) {
  const q: any = {};
  q.select = () => q; q.eq = () => q;
  q.maybeSingle = async () => ({ data: row });
  return q;
}

describe('upsell Clip — elegibilidade', () => {
  const service = Object.create(PaymentService.prototype) as any;
  const available = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    service.normalizeProviderName = (p: string) => String(p ?? '').toLowerCase();
    service.clipAccounts = { availableUpsellTokens: available };
  });

  const parent = (over: Record<string, unknown> = {}) => ({
    id: 'tx-parent', seller_id: 's1', provider: 'clip', provider_account_id: 'clip_mx_gray_01',
    status: 'approved', approved_at: new Date().toISOString(), metadata: {}, ...over,
  });

  it('oferece enquanto sobra token da compra', async () => {
    (supabase.from as jest.Mock).mockReturnValue(parentQuery(parent()));
    available.mockResolvedValue(2);
    await expect(service.checkUpsellEligibility('s1', 'tx-parent')).resolves.toEqual({ eligible: true, reason: null });
  });

  it('sem token (acabaram ou venceram) não oferece', async () => {
    (supabase.from as jest.Mock).mockReturnValue(parentQuery(parent()));
    available.mockResolvedValue(0);
    await expect(service.checkUpsellEligibility('s1', 'tx-parent'))
      .resolves.toEqual({ eligible: false, reason: 'no_saved_payment_method' });
  });

  it('compra ainda não aprovada não oferece', async () => {
    (supabase.from as jest.Mock).mockReturnValue(parentQuery(parent({ status: 'pending' })));
    await expect(service.checkUpsellEligibility('s1', 'tx-parent'))
      .resolves.toEqual({ eligible: false, reason: 'not_approved' });
    expect(available).not.toHaveBeenCalled();
  });
});

describe('Clip — confirmação do 3DS na fonte', () => {
  const service = Object.create(PaymentService.prototype) as any;
  const retrieve = jest.fn();
  const handleWebhookProvider = jest.fn().mockResolvedValue({});
  const capture = jest.fn().mockResolvedValue(true);
  const release = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    service.normalizeProviderName = (p: string) => String(p ?? '').toLowerCase();
    service.accountRouter = { resolveAccountById: jest.fn().mockResolvedValue({ id: 'clip_mx_gray_01', apiKey: 'sk', config: { public_key: 'pk' } }) };
    service.webhookService = { handleWebhookProvider };
    service.clipAccounts = { capture, release, getReservation: jest.fn().mockResolvedValue({ amount_minor: 150000 }) };
    jest.spyOn(require('../orchestrator/providers/clip.provider').ClipProvider.prototype, 'retrieve')
      .mockImplementation(retrieve as never);
  });

  const tx = (over: Record<string, unknown> = {}) => ({
    id: `tx-${Math.random()}`, status: 'pending', provider: 'clip', provider_account_id: 'clip_mx_gray_01',
    provider_transaction_id: 'clip_pay_1', amount: 29900, metadata: { clip_reservation_id: 'res-1' }, ...over,
  });

  it('venda base aprovada no banco: aprova e captura o valor da reserva', async () => {
    retrieve.mockResolvedValue({ success: true, status: 'paid' });
    await expect(service.confirmAtProvider(tx())).resolves.toBe(true);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'res-1', amountMinor: 150000, kind: 'base' }));
    expect(handleWebhookProvider).toHaveBeenCalledWith(expect.objectContaining({ status: 'PAID' }));
  });

  it('upsell aprovado: captura o valor do upsell contra a reserva da compra-mãe', async () => {
    retrieve.mockResolvedValue({ success: true, status: 'paid' });
    const t = tx({ metadata: { clip_reservation_id: 'res-1', clip_upsell_of: 'tx-parent' } });
    await expect(service.confirmAtProvider(t)).resolves.toBe(true);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 29900, kind: `upsell:${t.id}` }));
  });

  it('recusa da venda base devolve a reserva; a do upsell não mexe na da compra-mãe', async () => {
    retrieve.mockResolvedValue({ success: true, status: 'failed' });
    await service.confirmAtProvider(tx());
    expect(release).toHaveBeenCalledWith('res-1', 'declined');
    release.mockClear();
    await service.confirmAtProvider(tx({ metadata: { clip_reservation_id: 'res-1', clip_upsell_of: 'p' } }));
    expect(release).not.toHaveBeenCalled();
  });

  it('banco ainda decidindo: nada muda', async () => {
    retrieve.mockResolvedValue({ success: true, status: 'pending' });
    await expect(service.confirmAtProvider(tx())).resolves.toBe(false);
    expect(handleWebhookProvider).not.toHaveBeenCalled();
  });
});
