// Conta bancária do saque para seller com conta conectada: escolher uma salva
// ou cadastrar uma nova no próprio pedido. Nada aqui toca em saldo.

jest.mock('../../lib/supabase.client', () => ({ supabase: { from: jest.fn(), rpc: jest.fn() } }));

import { BadRequestException } from '@nestjs/common';
import { WhopPayoutDestinationsService } from './whop-payout-destinations.service';
import { WhopApiError } from './whop-platform.client';
import { WalletService } from '../../dashboard/services/services';

const SELLER = 'seller_1';
const BIZ = 'biz_seller';

const ACH_SCHEMA = {
  id: 'podst_ach',
  name: 'ACH Bank Deposit',
  delivery_type: 'bank_deposit',
  required_fields: [
    { id: 'fld_bank_routing_number', label: 'Routing number', type: 'bank_routing_number', input_type: 'text', required: true, validation: '^[0-9]{9}$', sensitive: false },
    { id: 'fld_bank_account_number', label: 'Account number', type: 'bank_account_number', input_type: 'text', required: true, validation: '^[0-9]{4,17}$', sensitive: true },
    { id: 'fld_bank_account_type', label: 'Account type', type: 'bank_account_type', input_type: 'options', required: true, options: ['Checking', 'Savings'], validation: null },
  ],
};

function make(opts: { eligible?: string | null } = {}) {
  const whop = {
    listSavedPayoutMethods: jest.fn<Promise<any>, any[]>(async () => ({
      data: [{ id: 'potk_saved', is_default: true, account_reference: '••••0472', institution_name: 'Frost Bank', supported_payout_method: { name: 'ACH Bank Deposit' } }],
    })),
    listSupportedPayoutMethods: jest.fn<Promise<any>, any[]>(async (args: any) => ({
      data: args.supportedPayoutMethodId ? [ACH_SCHEMA] : [{ id: 'podst_ach', name: 'ACH Bank Deposit' }],
    })),
    createSavedPayoutMethod: jest.fn<Promise<any>, any[]>(async () => ({
      id: 'potk_new', account_reference: '••••1234', institution_name: 'Chase', destination_currency: 'usd',
      supported_payout_method: { name: 'ACH Bank Deposit' },
    })),
  };
  const payouts = { eligibleAccount: jest.fn(async () => (opts.eligible === undefined ? BIZ : opts.eligible)) };
  return { service: new WhopPayoutDestinationsService(whop as any, payouts as any), whop, payouts };
}

const newAch = {
  whopSupportedPayoutMethodId: 'podst_ach',
  whopCountry: 'us',
  whopFields: { fld_bank_routing_number: '021000021', fld_bank_account_number: '000123451234', fld_bank_account_type: 'Checking' },
};

describe('WhopPayoutDestinationsService', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('seller sem conta conectada: modo manual, sem ir à Whop', async () => {
    const { service, whop } = make({ eligible: null });
    await expect(service.overview(SELLER)).resolves.toMatchObject({ mode: 'manual', saved: [] });
    expect(whop.listSavedPayoutMethods).not.toHaveBeenCalled();
  });

  it('conta conectada: lista contas salvas mascaradas e trilhos do país', async () => {
    const { service, whop } = make();
    const view = await service.overview(SELLER, 'br');
    expect(view.mode).toBe('whop');
    expect(view.saved).toEqual([expect.objectContaining({ id: 'potk_saved', reference: '••••0472', isDefault: true })]);
    expect(whop.listSupportedPayoutMethods).toHaveBeenCalledWith({ accountId: BIZ, country: 'BR' });
  });

  it('conta salva escolhida: usa sem cadastrar nada', async () => {
    const { service, whop } = make();
    const destination = await service.resolveForRequest(SELLER, { whopPayoutMethodId: 'potk_saved' });
    expect(destination).toMatchObject({ whopPayoutMethodId: 'potk_saved', accountReference: '••••0472', bankName: 'Frost Bank' });
    expect(whop.createSavedPayoutMethod).not.toHaveBeenCalled();
  });

  it('conta salva que sumiu: recusa', async () => {
    const { service } = make();
    await expect(service.resolveForRequest(SELLER, { whopPayoutMethodId: 'potk_outra' })).rejects.toThrow(/não está mais disponível/);
  });

  it('conta nova: valida no schema, cadastra na Whop e guarda só o mascarado', async () => {
    const { service, whop } = make();
    const destination = await service.resolveForRequest(SELLER, newAch, 'key-12345678');

    expect(whop.createSavedPayoutMethod).toHaveBeenCalledWith(
      {
        account_id: BIZ,
        supported_payout_method_id: 'podst_ach',
        destination_currency: 'usd',
        fields: newAch.whopFields,
      },
      `koopfy_pm_${SELLER}_key-12345678`,
    );
    expect(destination).toEqual({
      whopPayoutMethodId: 'potk_new',
      whopMethodName: 'ACH Bank Deposit',
      bankName: 'Chase',
      accountReference: '••••1234',
      destinationCurrency: 'usd',
    });
    // Número da conta nunca volta para ser gravado.
    expect(JSON.stringify(destination)).not.toContain('000123451234');
  });

  it('mesmo pedido repetido: mesma chave na Whop', async () => {
    const { service, whop } = make();
    await service.resolveForRequest(SELLER, newAch, 'key-12345678');
    await service.resolveForRequest(SELLER, newAch, 'key-12345678');
    expect(whop.createSavedPayoutMethod.mock.calls[0][1]).toBe(whop.createSavedPayoutMethod.mock.calls[1][1]);
  });

  it('dado inválido: erro por campo, sem chamar a Whop', async () => {
    const { service, whop } = make();
    const bad = { ...newAch, whopFields: { ...newAch.whopFields, fld_bank_routing_number: '123' } };
    const error = await service.resolveForRequest(SELLER, bad, 'key-12345678').catch(e => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ fieldErrors: { fld_bank_routing_number: expect.any(String) } });
    expect(whop.createSavedPayoutMethod).not.toHaveBeenCalled();
  });

  it('Whop recusa a conta: mensagem dela chega ao seller', async () => {
    const { service, whop } = make();
    whop.createSavedPayoutMethod.mockRejectedValue(new WhopApiError('routing number failed ABA checksum', 422, null, null));
    await expect(service.resolveForRequest(SELLER, newAch, 'key-12345678')).rejects.toThrow(/ABA checksum/);
  });

  it('sem conta salva nem trilho: pede uma das duas', async () => {
    const { service } = make();
    await expect(service.resolveForRequest(SELLER, {})).rejects.toThrow(/conta salva ou informe uma nova/);
  });
});

describe('WalletService — modo do saque', () => {
  const dto = (method: string, extra: Record<string, unknown> = {}) => ({ amount: 300, method, accountHolder: 'Ana', achRoutingNumber: '021000021', achAccountNumber: '12345678', ...extra }) as any;

  it('seller conectado não saca por ACH digitado', async () => {
    const { service } = make();
    const wallet = new WalletService(service);
    await expect((wallet as any).resolvePayoutDestination(SELLER, dto('ach'))).rejects.toThrow(/recebe saques pela Whop/);
  });

  it('seller na master não saca pela Whop', async () => {
    const { service } = make({ eligible: null });
    const wallet = new WalletService(service);
    await expect((wallet as any).resolvePayoutDestination(SELLER, dto('whop', { whopPayoutMethodId: 'potk_saved' }))).rejects.toThrow(/não recebe saques pela Whop/);
  });

  it('seller na master segue no ACH', async () => {
    const { service } = make({ eligible: null });
    const wallet = new WalletService(service);
    await expect((wallet as any).resolvePayoutDestination(SELLER, dto('ach'))).resolves.toMatchObject({ achRoutingNumber: '021000021' });
  });

  it('seller conectado com conta salva: destino é o potk', async () => {
    const { service } = make();
    const wallet = new WalletService(service);
    await expect((wallet as any).resolvePayoutDestination(SELLER, dto('whop', { whopPayoutMethodId: 'potk_saved' })))
      .resolves.toMatchObject({ whopPayoutMethodId: 'potk_saved' });
  });

  it('sem o módulo da Whop montado: sempre manual', async () => {
    const wallet = new WalletService();
    await expect((wallet as any).resolvePayoutDestination(SELLER, dto('whop'))).rejects.toThrow(/não recebe saques pela Whop/);
    await expect(wallet.getPayoutDestinations(SELLER)).resolves.toMatchObject({ mode: 'manual' });
  });
});
