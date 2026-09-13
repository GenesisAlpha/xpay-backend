-- Cache imutável/versionado de planos recorrentes Whop.
-- Um produto Koopfy NÃO vira um produto Whop. Cada conta possui um único
-- produto-container; somente os planos necessários para aquela conta existem.
create table if not exists public.whop_plan_mappings (
  id uuid primary key default gen_random_uuid(),
  koopfy_product_id text not null,
  whop_account_id text not null references public.whop_accounts(id) on delete cascade,
  terms_fingerprint text not null,
  whop_product_id text,
  whop_plan_id text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  terms jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (koopfy_product_id, whop_account_id, terms_fingerprint)
);

create index if not exists whop_plan_mappings_lookup_idx
  on public.whop_plan_mappings (koopfy_product_id, whop_account_id, status);

alter table public.whop_plan_mappings enable row level security;

create table if not exists public.whop_subscriptions (
  whop_membership_id text primary key,
  whop_account_id text not null references public.whop_accounts(id) on delete restrict,
  whop_plan_id text,
  koopfy_product_id text,
  koopfy_transaction_id uuid,
  customer_email text,
  status text not null default 'active',
  cancel_at_period_end boolean not null default false,
  current_period_end timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whop_subscriptions_product_idx
  on public.whop_subscriptions (koopfy_product_id, status);

create index if not exists whop_subscriptions_transaction_idx
  on public.whop_subscriptions (koopfy_transaction_id);

alter table public.whop_subscriptions enable row level security;

-- Esta tabela é exclusivamente server-to-server (service role). Não criamos
-- policy pública: com RLS habilitado, clientes anon/auth não conseguem lê-la.
