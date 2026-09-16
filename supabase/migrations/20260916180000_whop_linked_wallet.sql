-- Modo conta externa: o Financeiro do painel lê a conta Whop do próprio seller
-- (saldo por moeda, contas bancárias salvas e saque). O dinheiro nunca entra na
-- carteira da Koopfy — aqui só guardamos o que a Whop não devolve depois.
--
-- `wallet_ready`: a chave conectada tem as permissões de saldo/saque. Sem elas a
-- cobrança ainda sai, mas a tela de saldo fica cega e o painel precisa avisar.

alter table public.whop_linked_accounts
  add column if not exists wallet_ready boolean not null default false;

comment on column public.whop_linked_accounts.wallet_ready is
  'A chave conectada permite company:balance:read, payout:account:read, payout:destination:read e payout:withdraw_funds.';

-- Saques disparados pelo painel. A Whop não documenta listagem de saques, então
-- o histórico da tela sai daqui; `idempotency_key` é o que impede que um retry
-- (ou um duplo clique) vire dois saques na conta dele.
create table if not exists public.whop_linked_withdrawals (
  id uuid primary key default gen_random_uuid(),
  -- text, igual a whop_linked_accounts.seller_id (não uuid).
  seller_id text not null,
  whop_account_id text not null,
  whop_withdrawal_id text,
  idempotency_key text not null unique,
  amount_cents bigint not null check (amount_cents > 0),
  fee_cents bigint not null default 0,
  currency text not null,
  payout_method_id text not null,
  status text not null default 'requested',
  failure_reason text,
  estimated_at timestamptz,
  requested_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whop_linked_withdrawals_seller_idx
  on public.whop_linked_withdrawals (seller_id, created_at desc);

-- Saque em andamento é o que o painel reconsulta na Whop.
create index if not exists whop_linked_withdrawals_open_idx
  on public.whop_linked_withdrawals (status)
  where status not in ('completed', 'failed', 'canceled', 'denied');

alter table public.whop_linked_withdrawals enable row level security;

-- Só o backend (service_role) lê e escreve: nenhuma tela fala com esta tabela.
grant select, insert, update on public.whop_linked_withdrawals to service_role;
