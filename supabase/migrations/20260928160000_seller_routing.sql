-- Roteamento de contas (provedores externos do seller) — decisão do dono, 2026-09-28.
--
-- O seller liga o roteamento no painel (aceitando a taxa de roteamento, padrão
-- 0,8% sobre o bruto em USD) e passa a ter VÁRIAS contas por provedor:
--   • grupo cartão  → contas Whop (principal `whopl_…` e extras `whopa_…`) e
--                     Stripe (`stripel_…`) misturadas;
--   • grupo PayPal  → contas PayPal (`paypall_…`).
-- Cada grupo tem uma estratégia (orders_split, revenue_split, priority_cap,
-- score) e cada conta tem peso, prioridade, tetos, filtros e pausa.
--
-- A conta é escolhida POR SESSÃO do comprador (routing_assignments): com Whop
-- e Stripe misturadas o checkout precisa saber o provedor antes de desenhar o
-- formulário do cartão, e o pagamento tem que cair na MESMA conta.
--
-- Só cria tabelas. Idempotente. Não aplicar sem combinar o deploy do pay.

create table if not exists public.seller_routing_settings (
  seller_id text primary key references public.seller_profiles (id) on delete cascade,
  enabled boolean not null default false,
  enabled_at timestamptz,
  -- Aceite da taxa de roteamento no painel (exigido na primeira vez que liga).
  fee_accepted_at timestamptz,
  card_strategy text not null default 'orders_split'
    check (card_strategy in ('orders_split', 'revenue_split', 'priority_cap', 'score')),
  paypal_strategy text not null default 'orders_split'
    check (paypal_strategy in ('orders_split', 'revenue_split', 'priority_cap', 'score')),
  -- Percentual da taxa de roteamento definido no CRM. null = padrão
  -- (env ROUTING_FEE_PCT_DEFAULT, 0,8).
  routing_fee_pct numeric check (routing_fee_pct is null or (routing_fee_pct >= 0 and routing_fee_pct <= 10)),
  -- Limite da taxa de disputa (7 dias) que pausa a conta. null = padrão 0,75.
  dispute_pause_pct numeric check (dispute_pause_pct is null or (dispute_pause_pct > 0 and dispute_pause_pct <= 10)),
  updated_by text,
  updated_at timestamptz not null default now()
);

comment on table public.seller_routing_settings is
  'Roteamento de contas próprias do seller: liga/desliga, estratégias e taxa (CRM).';

-- Configuração de roteamento de QUALQUER conta própria: `whopl_…` (principal),
-- `whopa_…` (Whop extra), `stripel_…` e `paypall_…`. As credenciais continuam
-- em whop_linked_accounts / seller_provider_accounts; aqui só o que decide
-- para onde vai a venda. Conta sem linha usa o padrão (peso 100, prioridade 100).
create table if not exists public.seller_routing_accounts (
  provider_account_id text primary key,
  seller_id text not null references public.seller_profiles (id) on delete cascade,
  provider text not null check (provider in ('whop', 'stripe', 'paypal')),
  label text,
  weight int not null default 100 check (weight >= 0),
  -- Menor número = maior prioridade (1 é a primeira da cascata).
  priority int not null default 100 check (priority >= 1),
  daily_cap_usd_cents bigint check (daily_cap_usd_cents is null or daily_cap_usd_cents >= 0),
  daily_cap_orders int check (daily_cap_orders is null or daily_cap_orders >= 0),
  min_ticket_usd_cents bigint check (min_ticket_usd_cents is null or min_ticket_usd_cents >= 0),
  max_ticket_usd_cents bigint check (max_ticket_usd_cents is null or max_ticket_usd_cents >= 0),
  -- ISO-2 do comprador / ISO-4217 da venda. null ou vazio = sem restrição.
  countries text[],
  currencies text[],
  paused_at timestamptz,
  -- 'manual' (seller), 'disputes' (taxa de disputa acima do limite) ou
  -- 'errors' (circuit breaker: erros técnicos seguidos; volta sozinha).
  pause_reason text check (pause_reason is null or pause_reason in ('manual', 'disputes', 'errors')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists seller_routing_accounts_seller_idx
  on public.seller_routing_accounts (seller_id);

comment on table public.seller_routing_accounts is
  'Peso, prioridade, tetos, filtros e pausa de cada conta própria no roteamento.';

-- Conta atribuída a cada sessão de checkout (chave = checkout_sessions.id no
-- checkout). TTL de 24 h: sessão velha escolhe de novo.
create table if not exists public.routing_assignments (
  routing_key text primary key,
  seller_id text not null references public.seller_profiles (id) on delete cascade,
  card_account_id text,
  paypal_account_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create index if not exists routing_assignments_expires_idx
  on public.routing_assignments (expires_at);

alter table public.seller_routing_settings enable row level security;
alter table public.seller_routing_accounts enable row level security;
alter table public.routing_assignments enable row level security;

-- Exclusivamente server-to-server (service role).
revoke all on table public.seller_routing_settings from public, anon, authenticated;
revoke all on table public.seller_routing_accounts from public, anon, authenticated;
revoke all on table public.routing_assignments from public, anon, authenticated;
grant select, insert, update on table public.seller_routing_settings to service_role;
grant select, insert, update, delete on table public.seller_routing_accounts to service_role;
grant select, insert, update, delete on table public.routing_assignments to service_role;
