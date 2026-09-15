// integration/seller-accounts.ts
//
// Várias contas Koopfy Payments por usuário do checkout.
//
// A conta principal é a do e-mail (users.email). Cada conta a mais é um
// usuário interno próprio (users.owner_user_id = usuário do e-mail) com o seu
// seller_profiles. Assim KYC, documentos, operação, arquivos, CRM e conta
// conectada da Whop — tudo que é gravado por user_id — ficam separados por
// conta sem migrar dados.
//
// O checkout diz qual conta o workspace usa no header X-Koopfy-Seller-Id. Sem
// header vale a principal (comportamento anterior).

import { ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { supabase } from '../lib/supabase.client';

export const SELLER_ACCOUNT_HEADER = 'x-koopfy-seller-id';

const NOT_YOURS = 'Esta conta Koopfy Payments não pertence ao seu usuário.';

export type AccountState = 'onboarding' | 'pending' | 'active' | 'rejected' | 'suspended';

export interface SellerAccountOption {
  sellerId: string;
  name: string | null;
  state: AccountState;
  primary: boolean;
  createdAt: string | null;
}

export function normalizeEmail(email: unknown): string {
  return String(email ?? '').toLowerCase().trim();
}

/** Id do seller no header, só se tiver cara de id (evita filtro com texto arbitrário). */
export function sellerIdFromHeaders(headers: Record<string, unknown> | undefined): string | null {
  const raw = headers?.[SELLER_ACCOUNT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/** Estado da conta para o checkout (mesma regra do status). */
export function accountState(sellerStatus: string | null, documentsSubmitted: boolean): AccountState {
  if (sellerStatus === 'active') return 'active';
  if (sellerStatus === 'rejected') return 'rejected';
  if (sellerStatus === 'suspended') return 'suspended';
  // Provisionada sem documentos ainda não está "em análise".
  return documentsSubmitted ? 'pending' : 'onboarding';
}

/**
 * E-mail interno da conta a mais: o do dono com sufixo (`nome+conta-1a2b@dominio`).
 * Único em users.email e, se algum envio escapar, ainda chega ao dono.
 */
export function accountAliasEmail(ownerEmail: string, suffix = randomBytes(4).toString('hex')): string {
  const email = normalizeEmail(ownerEmail);
  const at = email.lastIndexOf('@');
  if (at <= 0) return `${email}+conta-${suffix}`;
  return `${email.slice(0, at)}+conta-${suffix}${email.slice(at)}`;
}

/**
 * Usuário do pay dono dos dados da conta.
 *   • sem sellerId: o usuário do e-mail (null se o e-mail não tem conta);
 *   • com sellerId: o usuário daquele seller, se for o do e-mail ou uma conta
 *     criada por ele. Conta de outro usuário é 403.
 */
export async function resolveAccountUserId(email: string, sellerId: string | null): Promise<string | null> {
  const { data: tokenUser } = await supabase
    .from('users')
    .select('id')
    .eq('email', normalizeEmail(email))
    .maybeSingle();

  if (!sellerId) return tokenUser?.id ?? null;
  if (!tokenUser) throw new ForbiddenException(NOT_YOURS);

  const { data: seller } = await supabase
    .from('seller_profiles')
    .select('user_id')
    .eq('id', sellerId)
    .maybeSingle();
  if (!seller?.user_id) throw new ForbiddenException(NOT_YOURS);
  if (seller.user_id === tokenUser.id) return tokenUser.id;

  const { data: accountUser } = await supabase
    .from('users')
    .select('id, owner_user_id')
    .eq('id', seller.user_id)
    .maybeSingle();
  if (!accountUser || accountUser.owner_user_id !== tokenUser.id) throw new ForbiddenException(NOT_YOURS);
  return accountUser.id;
}

/** Contas do usuário do e-mail: a principal primeiro, depois as criadas a mais (mais antigas antes). */
export async function listSellerAccounts(email: string): Promise<{ accounts: SellerAccountOption[] }> {
  const { data: owner } = await supabase
    .from('users')
    .select('id')
    .eq('email', normalizeEmail(email))
    .maybeSingle();
  if (!owner) return { accounts: [] };

  const { data: users } = await supabase
    .from('users')
    .select('id, name, created_at, documents_completed')
    .or(`id.eq.${owner.id},owner_user_id.eq.${owner.id}`);
  const userRows: any[] = users ?? [];
  if (userRows.length === 0) return { accounts: [] };

  const { data: sellers } = await supabase
    .from('seller_profiles')
    .select('id, user_id, name, status, created_at')
    .in('user_id', userRows.map(user => user.id));
  const byUser = new Map<string, any>(userRows.map(user => [user.id, user] as [string, any]));

  const accounts = ((sellers ?? []) as any[])
    .map(seller => {
      const user = byUser.get(seller.user_id);
      return {
        sellerId: String(seller.id),
        name: seller.name ?? user?.name ?? null,
        state: accountState(seller.status ?? null, Boolean(user?.documents_completed)),
        primary: seller.user_id === owner.id,
        createdAt: seller.created_at ?? user?.created_at ?? null,
      } as SellerAccountOption;
    })
    .sort((a, b) => Number(b.primary) - Number(a.primary) || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));

  return { accounts };
}

/** Para onde mandar e-mail de um usuário do pay: conta a mais usa o e-mail do dono. */
export async function contactEmailFor(user: { email?: string | null; owner_user_id?: string | null } | null): Promise<string | null> {
  if (!user) return null;
  if (!user.owner_user_id) return user.email ?? null;
  const { data: owner } = await supabase.from('users').select('email').eq('id', user.owner_user_id).maybeSingle();
  return owner?.email ?? user.email ?? null;
}
