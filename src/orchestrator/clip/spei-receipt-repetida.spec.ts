process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY ?? 'x';

jest.mock('../../lib/supabase.client', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }));

import { supabase } from '../../lib/supabase.client';
import { SpeiReceiptService, normalizarClave } from './spei-receipt.service';

// Sem centavo único no valor, o que impede UMA transferência de aprovar DOIS
// pedidos é esta checagem: mesma clave de rastreo, ou mesma data/hora e valor,
// de outro pedido já aprovado na mesma conta → revisão humana.

function approved(rows: { reservation_id: string; extracted: any }[], error: any = null) {
  const q: any = {};
  for (const m of ['select', 'eq', 'gte', 'order']) q[m] = () => q;
  q.limit = async () => ({ data: rows, error });
  (supabase.from as jest.Mock).mockReturnValue(q);
}

describe('SPEI — transferência já usada em outro pedido', () => {
  const svc = new SpeiReceiptService({} as any) as any;
  const lido = (over: Record<string, unknown> = {}) => ({ monto: 601, fecha_hora: '2026-10-10T14:32:00', clave_rastreo: 'MBAN01002610100012345678', ...over });

  beforeEach(() => jest.clearAllMocks());

  it('mesma clave de rastreo de outro pedido aprovado', async () => {
    approved([{ reservation_id: 'outra', extracted: { clave_rastreo: 'mban 0100-2610100012345678', monto: 601, fecha_hora: 'x' } }]);
    await expect(svc.transferenciaJaUsada(lido(), 'spei_mx_gray_01', 'esta')).resolves.toBe('mesma clave de rastreo');
  });

  it('clave lida diferente, mas mesma data, hora e valor', async () => {
    approved([{ reservation_id: 'outra', extracted: { clave_rastreo: 'OUTRALEITURA999', monto: 601, fecha_hora: '2026-10-10T14:32:00' } }]);
    await expect(svc.transferenciaJaUsada(lido(), 'spei_mx_gray_01', 'esta')).resolves.toBe('mesma data, hora e valor');
  });

  it('outro comprador, mesmo valor, outra hora: segue para aprovação', async () => {
    approved([{ reservation_id: 'outra', extracted: { clave_rastreo: 'OUTRACLAVE0001', monto: 601, fecha_hora: '2026-10-10T15:05:00' } }]);
    await expect(svc.transferenciaJaUsada(lido(), 'spei_mx_gray_01', 'esta')).resolves.toBeNull();
  });

  it('reenvio do comprovante do MESMO pedido não conta', async () => {
    approved([{ reservation_id: 'esta', extracted: lido() }]);
    await expect(svc.transferenciaJaUsada(lido(), 'spei_mx_gray_01', 'esta')).resolves.toBeNull();
  });

  it('sem clave e sem data não há o que comparar; banco fora do ar não trava a fila', async () => {
    await expect(svc.transferenciaJaUsada(lido({ clave_rastreo: null, fecha_hora: null }), 'a', 'esta')).resolves.toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
    approved([], { message: 'fora do ar' });
    await expect(svc.transferenciaJaUsada(lido(), 'a', 'esta')).resolves.toBeNull();
  });

  it('clave curta demais não identifica nada', () => {
    expect(normalizarClave('12-34')).toBeNull();
    expect(normalizarClave(' mban 0100-2610 ')).toBe('MBAN01002610');
  });
});
