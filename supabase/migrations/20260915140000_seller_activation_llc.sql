-- Onboarding padrão por LLC americana + exceções decididas no CRM.
--
-- seller_activation_requests: o seller sem LLC pede (a) ativação por CNPJ ou
--   (b) orientação para abrir uma empresa americana. O CRM decide:
--   approve_cnpj → status 'approved' (libera o cadastro com CNPJ, que vende
--   pela conta master); direct_to_llc → 'directed_to_llc'; reject → 'rejected'.
--   Uma solicitação pendente por usuário (índice parcial).
--
-- seller_documents.company_*: dados da LLC usados na verificação de empresa
--   (KYB) da conta conectada na Whop, mais Articles of Organization e
--   Operating Agreement.
--
-- whop_connected_accounts.rfi_*: pedidos de informação da Whop já respondidos
--   automaticamente e os que ficaram para o CRM.
--
-- whop_connected_transfers: coberturas de saldo negativo (master → conta do
--   seller). Idempotency-Key única: reentrega do mesmo evento não cobre duas
--   vezes.
--
-- Só cria/adiciona; não altera nem apaga dado existente. Idempotente.
-- Depende de 20260915120000_whop_connected_accounts.sql.

create table if not exists public.seller_activation_requests (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  seller_id text,
  kind text not null check (kind in ('cnpj', 'us_company')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'directed_to_llc', 'rejected', 'cancelled')),
  seller_message text,
  decision_notes text,
  seller_facing_message text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists seller_activation_requests_one_pending
  on public.seller_activation_requests (user_id) where status = 'pending';

create index if not exists seller_activation_requests_status_idx
  on public.seller_activation_requests (status, created_at desc);

alter table public.seller_documents
  add column if not exists company_legal_name text,
  add column if not exists company_ein text,
  add column if not exists company_structure text,
  add column if not exists company_formation_state text,
  add column if not exists company_address jsonb,
  add column if not exists company_website text,
  add column if not exists articles_of_organization_path text,
  add column if not exists operating_agreement_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'seller_documents_company_structure_check'
  ) then
    alter table public.seller_documents
      add constraint seller_documents_company_structure_check
      check (company_structure is null or company_structure in ('single_member_llc', 'multi_member_llc'));
  end if;
end $$;

alter table public.whop_connected_accounts
  add column if not exists rfi_answered jsonb not null default '[]'::jsonb,
  add column if not exists rfi_unanswered jsonb not null default '[]'::jsonb;

create table if not exists public.whop_connected_transfers (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null,
  whop_account_id text not null,
  kind text not null check (kind in ('negative_cover')),
  currency text not null,
  amount numeric(18, 2) not null check (amount > 0),
  status text not null default 'processing' check (status in ('processing', 'succeeded', 'failed')),
  whop_transfer_id text,
  idempotency_key text not null unique,
  reason text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whop_connected_transfers_open_idx
  on public.whop_connected_transfers (seller_id, currency) where status = 'processing';

alter table public.seller_activation_requests enable row level security;
alter table public.whop_connected_transfers enable row level security;

-- Exclusivamente server-to-server (service role).
revoke all on table public.seller_activation_requests from public, anon, authenticated;
revoke all on table public.whop_connected_transfers from public, anon, authenticated;
grant select, insert, update on table public.seller_activation_requests to service_role;
grant select, insert, update on table public.whop_connected_transfers to service_role;
