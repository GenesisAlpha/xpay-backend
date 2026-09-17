-- Data em que a comissão cai na carteira do afiliado.
--
-- O afiliado recebe em dia fixo do mês e cada ciclo fecha um período: só entra
-- o que já passou da carência naquela data. Com dia 30 e carência 15, o
-- pagamento do dia 30 cobre as vendas do dia 1 ao 15.
--
-- Isso é liberação para a CARTEIRA (pending → available), não envio ao banco.
-- O saque continua sendo do afiliado, pelo fluxo normal, com o mínimo de
-- US$ 200 — que por isso não se aplica aqui.
--
-- Sem linha nesta tabela vale o padrão da plataforma (dia 30, carência 15),
-- então ninguém precisa ser cadastrado para receber.

create table if not exists public.affiliate_payout_cycles (
  affiliate_seller_id text primary key,
  -- Dia do mês. 31 num mês curto cai no último dia (ver payout-cycle.ts).
  payout_day integer not null default 30,
  -- Dias mínimos entre a venda e o pagamento.
  hold_days  integer not null default 15,
  -- Quem mexeu, porque isto é decisão de dinheiro tomada no CRM.
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint affiliate_payout_cycles_day_range
    check (payout_day between 1 and 31),
  -- Acima de 90 dias não é carência, é retenção — precisa de decisão humana,
  -- não de um número no banco.
  constraint affiliate_payout_cycles_hold_range
    check (hold_days between 0 and 90)
);

alter table public.affiliate_payout_cycles enable row level security;

-- Painel do CRM: um afiliado por linha, com o que ele gerou e o que já saiu.
create or replace view public.v_crm_affiliates as
select
  c.affiliate_seller_id,
  count(*)                                          as commission_count,
  count(distinct c.source_seller_id)                as earning_sellers,
  coalesce(sum(c.commission_cents), 0)              as total_cents,
  coalesce(sum(c.commission_cents) filter (where c.status = 'pending'), 0)   as pending_cents,
  coalesce(sum(c.commission_cents) filter (where c.status = 'available'), 0) as available_cents,
  coalesce(sum(c.commission_cents) filter (where c.status = 'paid'), 0)      as paid_cents,
  min(c.created_at)                                 as first_commission_at,
  max(c.created_at)                                 as last_commission_at
from public.affiliate_commissions c
group by c.affiliate_seller_id;
