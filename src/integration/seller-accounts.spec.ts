const tables: Record<string, any[]> = {};

jest.mock('../lib/supabase.client', () => ({
  supabase: {
    from: (name: string) => {
      let rows = [...(tables[name] ?? [])];
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: unknown) => { rows = rows.filter(row => row[column] === value); return builder; },
        in: (column: string, values: unknown[]) => { rows = rows.filter(row => values.includes(row[column])); return builder; },
        or: (expression: string) => {
          const clauses = expression.split(',').map(clause => clause.split('.eq.'));
          rows = rows.filter(row => clauses.some(([column, value]) => String(row[column]) === value));
          return builder;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null }),
      };
      return builder;
    },
  },
}));

import { ForbiddenException } from '@nestjs/common';
import {
  accountAliasEmail,
  accountState,
  contactEmailFor,
  listSellerAccounts,
  resolveAccountUserId,
  sellerIdFromHeaders,
} from './seller-accounts';

beforeEach(() => {
  tables.users = [
    { id: 'u-owner', email: 'ana@loja.com', name: 'Ana', created_at: '2026-01-01', documents_completed: true, owner_user_id: null },
    { id: 'u-extra', email: 'ana+conta-1a2b@loja.com', name: 'Ana', created_at: '2026-09-01', documents_completed: false, owner_user_id: 'u-owner' },
    { id: 'u-other', email: 'bia@loja.com', name: 'Bia', created_at: '2026-02-01', documents_completed: true, owner_user_id: null },
  ];
  tables.seller_profiles = [
    { id: 's-extra', user_id: 'u-extra', name: 'Loja Europa', status: 'pending_review', created_at: '2026-09-01' },
    { id: 's-owner', user_id: 'u-owner', name: 'Loja Brasil', status: 'active', created_at: '2026-01-01' },
    { id: 's-other', user_id: 'u-other', name: 'Outra', status: 'active', created_at: '2026-02-01' },
  ];
});

describe('resolveAccountUserId', () => {
  it('sem conta escolhida usa a principal do e-mail', async () => {
    await expect(resolveAccountUserId('ANA@loja.com ', null)).resolves.toBe('u-owner');
    await expect(resolveAccountUserId('ninguem@loja.com', null)).resolves.toBeNull();
  });

  it('aceita a principal e as contas criadas pelo mesmo usuário', async () => {
    await expect(resolveAccountUserId('ana@loja.com', 's-owner')).resolves.toBe('u-owner');
    await expect(resolveAccountUserId('ana@loja.com', 's-extra')).resolves.toBe('u-extra');
  });

  it('recusa conta de outro usuário ou inexistente', async () => {
    await expect(resolveAccountUserId('ana@loja.com', 's-other')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(resolveAccountUserId('ana@loja.com', 's-nao-existe')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(resolveAccountUserId('ninguem@loja.com', 's-owner')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('listSellerAccounts', () => {
  it('lista a principal primeiro e só as contas do próprio usuário', async () => {
    const { accounts } = await listSellerAccounts('ana@loja.com');
    expect(accounts).toEqual([
      { sellerId: 's-owner', name: 'Loja Brasil', state: 'active', primary: true, createdAt: '2026-01-01' },
      { sellerId: 's-extra', name: 'Loja Europa', state: 'onboarding', primary: false, createdAt: '2026-09-01' },
    ]);
    await expect(listSellerAccounts('ninguem@loja.com')).resolves.toEqual({ accounts: [] });
  });
});

describe('helpers', () => {
  it('só aceita id de seller com formato de id no header', () => {
    expect(sellerIdFromHeaders({ 'x-koopfy-seller-id': ' 7f3c-uuid ' })).toBe('7f3c-uuid');
    expect(sellerIdFromHeaders({ 'x-koopfy-seller-id': 'a,b.eq.c' })).toBeNull();
    expect(sellerIdFromHeaders({})).toBeNull();
  });

  it('e-mail interno da conta a mais mantém o dono', () => {
    expect(accountAliasEmail('Ana@Loja.com', '1a2b')).toBe('ana+conta-1a2b@loja.com');
  });

  it('estado da conta segue a regra do status', () => {
    expect(accountState('active', false)).toBe('active');
    expect(accountState('pending_review', true)).toBe('pending');
    expect(accountState('pending_review', false)).toBe('onboarding');
    expect(accountState('suspended', true)).toBe('suspended');
  });

  it('e-mail de conta a mais vai para o dono', async () => {
    await expect(contactEmailFor({ email: 'ana+conta-1a2b@loja.com', owner_user_id: 'u-owner' })).resolves.toBe('ana@loja.com');
    await expect(contactEmailFor({ email: 'bia@loja.com', owner_user_id: null })).resolves.toBe('bia@loja.com');
  });
});
