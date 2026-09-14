-- Assinaturas e planos recorrentes da Whop no Koopfy Pay.
--
-- whop_subscriptions: uma linha por membership da Whop, gravada pelos webhooks
-- membership.activated / membership.deactivated /
-- membership.cancel_at_period_end_changed (WebhookService.persistWhopMembership)
-- e lida pela carteira de assinaturas do painel (koopfy-integration →
-- subscription-report). Sem esta tabela o webhook falha a cada entrega e
-- nenhuma assinatura aparece, mesmo com o pagamento aprovado.
--
-- whop_plan_mappings: cache dos planos recorrentes criados na Whop
-- (WhopProvider.recordRecurringPlan). A cobrança tolera a ausência dela.
--
-- Origem: apps/pay/ops/whop-subscription-plans-migration.sql, que nunca foi
-- versionado nem aplicado. Duas correções em relação a ele:
--  1) SEM foreign key para public.whop_accounts. A conta principal vem do .env
--     ('whop_main') e não tem linha em whop_accounts; com a FK, todo upsert de
--     assinatura falharia por violação de chave.
--  2) koopfy_transaction_id como TEXT, o mesmo tipo de transactions.id.
--
-- Só cria; não altera nem apaga dado nenhum. Idempotente.

create table if not exists public.whop_plan_mappings (
  id uuid primary key default gen_random_uuid(),
  koopfy_product_id text not null,
  whop_account_id text not null,
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
  whop_account_id text not null,
  whop_plan_id text,
  koopfy_product_id text,
  koopfy_transaction_id text,
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

-- Exclusivamente server-to-server (service role): sem policy pública, e sem
-- grant para anon/authenticated.
revoke all on table public.whop_plan_mappings from anon, authenticated;
revoke all on table public.whop_subscriptions from anon, authenticated;
