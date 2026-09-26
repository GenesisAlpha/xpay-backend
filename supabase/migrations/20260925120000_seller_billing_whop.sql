-- Cobrança das comissões da Koopfy no cartão do SELLER, pela conta Whop da
-- própria Koopfy (a master, WHOP_API_KEY).
--
-- O seller salva o cartão numa checkout configuration em modo `setup` (nada é
-- cobrado) e o checkout, dono do débito de comissões, pede a cobrança aqui.
-- A chave é o workspace do checkout: é nele que o débito acumula.

create table if not exists public.seller_billing_methods (
  workspace_id text primary key,
  seller_email text null,
  -- pending: sessão de setup aberta, cartão ainda não confirmado
  -- active:  cartão salvo e cobrável sem o seller presente
  -- removed: o seller trocou/removeu (a linha fica para auditoria)
  status text not null default 'pending'
    check (status in ('pending', 'active', 'removed')),
  setup_session_id text null,
  setup_started_at timestamptz null,
  whop_member_id text null,
  whop_payment_method_id text null,
  card_brand text null,
  card_last4 text null,
  card_exp_month int null,
  card_exp_year int null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.seller_billing_charges (
  id uuid primary key default gen_random_uuid(),
  -- Referência do checkout: é também a Idempotency-Key na Whop, então pedir a
  -- mesma cobrança duas vezes não cobra duas vezes.
  charge_ref text not null unique,
  workspace_id text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed')),
  whop_payment_id text null,
  failure_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists seller_billing_charges_workspace_idx
  on public.seller_billing_charges (workspace_id, created_at desc);
create index if not exists seller_billing_charges_whop_payment_idx
  on public.seller_billing_charges (whop_payment_id) where whop_payment_id is not null;
