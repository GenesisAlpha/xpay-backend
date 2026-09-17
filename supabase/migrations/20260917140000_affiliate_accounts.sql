-- Contas com o programa de indicação ativado pelo CRM.
--
-- O programa é por convite: o time escolhe a conta, ativa e entrega o link.
-- A identidade usada na atribuição (código, cadastro) mora no checkout; esta
-- tabela é a lista que o CRM administra, sem uma chamada ao checkout por linha.

create table if not exists public.affiliate_accounts (
  seller_id      text primary key,
  -- Espelho do checkout, para a lista mostrar o link sem ir lá.
  affiliate_id   text,
  code           text,
  link           text,
  status         text not null default 'active'
    check (status in ('active', 'inactive')),
  commission_rate_pct numeric(5,2) not null default 20.00
    check (commission_rate_pct > 0 and commission_rate_pct < 100),
  activated_by   text,
  activated_at   timestamptz not null default now(),
  deactivated_by text,
  deactivated_at timestamptz,
  updated_at     timestamptz not null default now()
);

create index if not exists affiliate_accounts_status_idx
  on public.affiliate_accounts (status);

alter table public.affiliate_accounts enable row level security;
