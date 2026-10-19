-- Roteamento por LINK: contas em que o comprador paga fora do checkout da
-- Koopfy (hoje: lojas Shopify com Shopify Payments, no checkout da própria
-- Shopify). A credencial mora no backend do checkout (shopify_payment_accounts);
-- aqui fica só a referência, para a conta entrar no mesmo pool do roteamento
-- (estratégia, tetos, aquecimento, score e pausa por disputa) que Whop/Stripe.
create table if not exists public.seller_link_accounts (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null references public.seller_profiles (id) on delete cascade,
  provider text not null check (provider in ('shopify')),
  -- Id da conta no backend do checkout (shopify_payment_accounts.id).
  external_ref text not null,
  display_name text,
  shop_domain text,
  -- Moedas que a loja aceita (Shopify Markets). Vazio = não informado.
  currencies text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (seller_id, provider, external_ref)
);
create index if not exists seller_link_accounts_seller_idx on public.seller_link_accounts (seller_id);

-- Vendas das contas por link: o pay não cobra nelas, então a estatística de
-- 7 dias e o "hoje" (tetos e aquecimento) vêm daqui. Uma linha por venda,
-- atualizada no estorno e na disputa.
create table if not exists public.routing_link_sales (
  provider_account_id text not null,
  seller_id text not null references public.seller_profiles (id) on delete cascade,
  sale_ref text not null,
  status text not null check (status in ('approved', 'refunded', 'partially_refunded', 'chargeback')),
  amount_usd_gross_cents bigint not null default 0 check (amount_usd_gross_cents >= 0),
  disputed boolean not null default false,
  -- Quando a venda foi aprovada (o dia do teto conta por aqui).
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider_account_id, sale_ref)
);
create index if not exists routing_link_sales_seller_created_idx on public.routing_link_sales (seller_id, created_at);

alter table public.seller_routing_accounts drop constraint if exists seller_routing_accounts_provider_check;
alter table public.seller_routing_accounts add constraint seller_routing_accounts_provider_check
  check (provider in ('whop', 'stripe', 'paypal', 'shopify'));

alter table public.seller_link_accounts enable row level security;
alter table public.routing_link_sales enable row level security;
revoke all on public.seller_link_accounts, public.routing_link_sales from anon, authenticated;
grant all on public.seller_link_accounts, public.routing_link_sales to service_role;
