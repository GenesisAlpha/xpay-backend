// Máquina de estados do saque de seller conectado, com um wallet_ledger em
// memória. O que importa aqui é dinheiro: quando o saldo volta ao seller,
// quanto sai da master e com que chave de idempotência.

type Row = Record<string, any>;
const ledger = new Map<string, Row>();
const rpcCalls: Array<{ fn: string; args: any }> = [];

function query(table: string) {
  const filters: Array<[string, any]> = [];
  let patch: Row | null = null;

  const matches = (row: Row) => filters.every(([col, val]) => row[col] === val);
  const rows = () => (table === 'wallet_ledger' ? [...ledger.values()].filter(matches) : []);
  const apply = () => {
    const hit = rows();
    if (patch) for (const row of hit) Object.assign(row, structuredClone(patch));
    return hit;
  };

  const builder: any = {
    select: () => builder,
    update: (value: Row) => { patch = value; return builder; },
    insert: async () => ({ error: null }),
    eq: (col: string, val: any) => { filters.push([col, val]); return builder; },
    single: async () => {
      const hit = apply();
      return hit.length === 1 ? { data: structuredClone(hit[0]), error: null } : { data: null, error: { message: 'not found' } };
    },
    maybeSingle: async () => {
      const hit = apply();
      return { data: hit[0] ? structuredClone(hit[0]) : null, error: null };
    },
  };
  return builder;
}

jest.mock('../../lib/supabase.client', () => ({
  supabase: {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: any) => { rpcCalls.push({ fn, args }); return { error: null }; },
  },
}));

jest.mock('../../utils/seller-mail', () => ({ notifySellerPayout: jest.fn(async () => undefined) }));

import { WhopConnectedPayoutService } from './whop-connected-payout.service';
import { newPayoutExecution, payoutTransferKey, payoutWithdrawalKey } from './whop-connected-payout';
import { WhopApiError } from './whop-platform.client';

const SELLER = 'seller_1';
const BIZ = 'biz_seller';
const MASTER = 'biz_master';

function seedPayout(overrides: Row = {}) {
  const row: Row = {
    id: 'pay_1',
    seller_id: SELLER,
    type: 'debit_payout',
    amount: 10000,
    fee: 300,
    currency: 'USD',
    status: 'approved',
    created_at: '2026-09-16T12:00:00Z',
    metadata: { method: 'ach', net_cents: 9700, execution: newPayoutExecution(BIZ) },
    ...overrides,
  };
  ledger.set(row.id, row);
  return row;
}

function makeService() {
  const whop = {
    listSavedPayoutMethods: jest.fn<Promise<any>, any[]>(async () => ({ data: [{ id: 'potk_1', is_default: true }] })),
    createTransfer: jest.fn<Promise<any>, any[]>(async () => ({ id: 'xfer_1', status: 'succeeded' })),
    getTransfer: jest.fn<Promise<any>, any[]>(async () => ({ id: 'xfer_1', status: 'succeeded' })),
    createPayout: jest.fn<Promise<any>, any[]>(async () => ({ id: 'cofr_1', status: 'requested' })),
    getPayout: jest.fn<Promise<any>, any[]>(async () => ({ id: 'cofr_1', status: 'completed' })),
  };
  const balances: Record<string, number> = { [MASTER]: 1_000_000, [BIZ]: 9700 };
  const connect = {
    getRow: jest.fn<Promise<any>, any[]>(async () => ({ seller_id: SELLER, whop_account_id: BIZ, status: 'active' })),
    masterAccountId: jest.fn(async () => MASTER),
    accountAvailableCents: jest.fn(async (id: string) => balances[id] ?? 0),
  };
  const service = new WhopConnectedPayoutService(whop as any, connect as any);
  return { service, whop, connect, balances };
}

const row = () => ledger.get('pay_1')!;
const stage = () => row().metadata.execution.stage;
const credits = () => rpcCalls.filter(c => c.fn === 'credit_balance');

beforeEach(() => {
  ledger.clear();
  rpcCalls.length = 0;
  process.env.WHOP_CONNECTED_PAYOUTS = 'true';
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('caminho feliz', () => {
  it('transfere o líquido, saca e conclui', async () => {
    seedPayout();
    const { service, whop } = makeService();

    await service.advance('pay_1');

    // Taxa de saque fica na master: sai só o líquido.
    expect(whop.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ origin_id: MASTER, destination_id: BIZ, amount: 97, currency: 'usd' }),
      payoutTransferKey('pay_1'),
    );
    expect(whop.createPayout).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: BIZ, payout_method_id: 'potk_1', amount: 97, currency: 'usd', platform_covers_fees: false }),
      payoutWithdrawalKey('pay_1', 1),
    );
    expect(stage()).toBe('paying_out');
    expect(row().status).toBe('processing');

    // Próximo ciclo: o banco confirmou.
    await service.advance('pay_1');
    expect(row().status).toBe('completed');
    expect(row().provider_payout_id).toBe('cofr_1');
    expect(stage()).toBe('completed');
    expect(credits()).toHaveLength(0);
  });

  it('transferência ainda processando não dispara o saque', async () => {
    seedPayout();
    const { service, whop } = makeService();
    whop.createTransfer.mockResolvedValueOnce({ id: 'xfer_1', status: 'pending' });

    await service.advance('pay_1');

    expect(stage()).toBe('transferring');
    expect(whop.createPayout).not.toHaveBeenCalled();

    // Próximo ciclo consulta a MESMA transferência, não cria outra.
    await service.advance('pay_1');
    expect(whop.createTransfer).toHaveBeenCalledTimes(1);
    expect(whop.getTransfer).toHaveBeenCalledWith('xfer_1');
    expect(whop.createPayout).toHaveBeenCalledTimes(1);
  });

  it('espera o saldo aparecer na conta conectada antes de sacar', async () => {
    seedPayout();
    const { service, whop, balances } = makeService();
    balances[BIZ] = 0;

    await service.advance('pay_1');
    expect(stage()).toBe('paying_out');
    expect(whop.createPayout).not.toHaveBeenCalled();

    balances[BIZ] = 9700;
    await service.advance('pay_1');
    expect(whop.createPayout).toHaveBeenCalledTimes(1);
  });
});

describe('antes de o dinheiro sair', () => {
  it('sem conta bancária: bloqueia e não transfere', async () => {
    seedPayout();
    const { service, whop } = makeService();
    whop.listSavedPayoutMethods.mockResolvedValue({ data: [] });

    await service.advance('pay_1');

    expect(whop.createTransfer).not.toHaveBeenCalled();
    expect(stage()).toBe('blocked');
    expect(row().status).toBe('approved'); // CRM ainda pode cancelar
  });

  it('master sem USD suficiente: bloqueia e não transfere', async () => {
    seedPayout();
    const { service, whop, balances } = makeService();
    balances[MASTER] = 5000;

    await service.advance('pay_1');

    expect(whop.createTransfer).not.toHaveBeenCalled();
    expect(stage()).toBe('blocked');
  });

  it('conta conectada trocada depois da aprovação: bloqueia', async () => {
    seedPayout();
    const { service, whop, connect } = makeService();
    connect.getRow.mockResolvedValue({ seller_id: SELLER, whop_account_id: 'biz_outra', status: 'active' });

    await service.advance('pay_1');

    expect(whop.createTransfer).not.toHaveBeenCalled();
    expect(stage()).toBe('blocked');
  });

  it('CRM cancelou antes do ciclo: o claim perde e nada é enviado', async () => {
    seedPayout();
    const { service, whop, connect } = makeService();
    // O CRM marca como falho enquanto o ciclo faz as checagens.
    connect.masterAccountId.mockImplementation(async () => {
      row().status = 'failed';
      return MASTER;
    });

    await service.advance('pay_1');

    expect(whop.createTransfer).not.toHaveBeenCalled();
    expect(credits()).toHaveLength(0); // quem devolveu foi o CRM, não o ciclo
  });
});

describe('transferência recusada', () => {
  it('recusa definitiva devolve o valor inteiro ao disponível', async () => {
    seedPayout();
    const { service, whop } = makeService();
    whop.createTransfer.mockRejectedValue(new WhopApiError('insufficient', 422, null, null));

    await service.advance('pay_1');

    expect(row().status).toBe('failed');
    expect(stage()).toBe('transfer_failed');
    // Valor bruto: nada saiu da master, nem a taxa.
    expect(credits()).toEqual([
      { fn: 'credit_balance', args: { p_seller_id: SELLER, p_bucket: 'available', p_amount_cents: 10000 } },
    ]);
    expect(whop.createPayout).not.toHaveBeenCalled();
  });

  it('timeout NÃO devolve saldo e repete com a mesma chave', async () => {
    seedPayout();
    const { service, whop } = makeService();
    whop.createTransfer.mockRejectedValueOnce(new WhopApiError('gateway timeout', 504, null, null));

    await service.advance('pay_1');

    expect(credits()).toHaveLength(0);
    expect(row().status).toBe('processing');
    expect(stage()).toBe('transferring');

    await service.advance('pay_1');
    expect(whop.createTransfer).toHaveBeenCalledTimes(2);
    expect(whop.createTransfer.mock.calls[0][1]).toBe(whop.createTransfer.mock.calls[1][1]);
  });

  it('falha ao CONSULTAR uma transferência existente nunca devolve saldo', async () => {
    seedPayout({
      status: 'processing',
      metadata: {
        net_cents: 9700,
        execution: { ...newPayoutExecution(BIZ), stage: 'transferring', payout_method_id: 'potk_1', transfer: { id: 'xfer_1' } },
      },
    });
    const { service, whop } = makeService();
    whop.getTransfer.mockRejectedValue(new WhopApiError('not found', 404, null, null));

    await service.advance('pay_1');

    expect(credits()).toHaveLength(0);
    expect(stage()).toBe('transferring');
  });
});

describe('saque recusado pelo banco', () => {
  it('não devolve saldo na Koopfy — o dinheiro já é do seller na conta dele', async () => {
    seedPayout();
    const { service, whop } = makeService();
    whop.getPayout.mockResolvedValue({ id: 'cofr_1', status: 'denied', failure: { message: 'conta encerrada' } });

    await service.advance('pay_1'); // transfere e cria o saque
    await service.advance('pay_1'); // banco recusa

    expect(stage()).toBe('payout_failed');
    expect(row().status).toBe('processing');
    expect(row().metadata.execution.last_error).toBe('conta encerrada');
    expect(credits()).toHaveLength(0);
  });

  it('payout estornado pelo banco (reversed) também para em payout_failed', async () => {
    seedPayout();
    const { service, whop } = makeService();
    whop.getPayout.mockResolvedValue({ id: 'cofr_1', status: 'reversed', failure: { code: 'account_closed' } });

    await service.advance('pay_1');
    await service.advance('pay_1');

    expect(stage()).toBe('payout_failed');
    expect(credits()).toHaveLength(0);
  });

  it('o ciclo não insiste sozinho num saque recusado', async () => {
    seedPayout();
    const { service, whop } = makeService();
    whop.createPayout.mockRejectedValue(new WhopApiError('invalid payout method', 400, null, null));

    await service.advance('pay_1');
    expect(stage()).toBe('payout_failed');

    await service.advance('pay_1');
    expect(whop.createPayout).toHaveBeenCalledTimes(1);
  });

  it('reenvio do CRM cria um saque novo, sem transferir de novo', async () => {
    seedPayout();
    const { service, whop } = makeService();
    whop.getPayout.mockResolvedValueOnce({ id: 'cofr_1', status: 'failed' });

    await service.advance('pay_1');
    await service.advance('pay_1');
    expect(stage()).toBe('payout_failed');

    whop.listSavedPayoutMethods.mockResolvedValue({ data: [{ id: 'potk_1' }, { id: 'potk_2' }] });
    whop.createPayout.mockResolvedValueOnce({ id: 'cofr_2', status: 'completed' });

    const state = await service.retryWithdrawal('pay_1', 'potk_2');

    expect(whop.createTransfer).toHaveBeenCalledTimes(1);
    expect(whop.createPayout).toHaveBeenLastCalledWith(
      expect.objectContaining({ payout_method_id: 'potk_2' }),
      payoutWithdrawalKey('pay_1', 2),
    );
    expect(row().status).toBe('completed');
    expect(state).toMatchObject({ stage: 'completed', attempt: 2, payoutId: 'cofr_2' });
  });

  it('reenvio para conta bancária inexistente é recusado na hora', async () => {
    seedPayout();
    const { service, whop } = makeService();
    whop.getPayout.mockResolvedValueOnce({ id: 'cofr_1', status: 'failed' });
    await service.advance('pay_1');
    await service.advance('pay_1');

    await expect(service.retryWithdrawal('pay_1', 'potk_fantasma')).rejects.toThrow(/não está mais cadastrada/);
    expect(stage()).toBe('payout_failed');
    expect(whop.createPayout).toHaveBeenCalledTimes(1);
  });

  it('bloqueado por várias contas: o CRM escolhe e o envio começa', async () => {
    seedPayout();
    const { service, whop } = makeService();
    whop.listSavedPayoutMethods.mockResolvedValue({ data: [{ id: 'potk_a' }, { id: 'potk_b' }] });

    await service.advance('pay_1');
    expect(stage()).toBe('blocked');
    expect(whop.createTransfer).not.toHaveBeenCalled();

    await service.retryWithdrawal('pay_1', 'potk_b');

    expect(whop.createTransfer).toHaveBeenCalledTimes(1);
    expect(whop.createPayout).toHaveBeenCalledWith(
      expect.objectContaining({ payout_method_id: 'potk_b' }),
      payoutWithdrawalKey('pay_1', 1),
    );
  });

  it('reenvio só vale para saque recusado', async () => {
    seedPayout();
    const { service } = makeService();
    await service.advance('pay_1'); // transfere e cria o saque: etapa paying_out
    await expect(service.retryWithdrawal('pay_1')).rejects.toThrow(/recusado pelo banco ou bloqueado/);
  });
});

describe('elegibilidade', () => {
  it('desligado por env: nenhum seller vai para o envio automático', async () => {
    delete process.env.WHOP_CONNECTED_PAYOUTS;
    const { service, connect } = makeService();
    await expect(service.eligibleAccount(SELLER)).resolves.toBeNull();
    expect(connect.getRow).not.toHaveBeenCalled();
  });

  it('conta conectada fora de active: saque manual', async () => {
    const { service, connect } = makeService();
    connect.getRow.mockResolvedValue({ seller_id: SELLER, whop_account_id: BIZ, status: 'restricted' });
    await expect(service.eligibleAccount(SELLER)).resolves.toBeNull();
  });

  it('seller só na master (sem conta conectada): saque manual', async () => {
    const { service, connect } = makeService();
    connect.getRow.mockResolvedValue(null);
    await expect(service.eligibleAccount(SELLER)).resolves.toBeNull();
  });

  it('conta conectada ativa: envio automático', async () => {
    const { service } = makeService();
    await expect(service.eligibleAccount(SELLER)).resolves.toBe(BIZ);
  });
});
