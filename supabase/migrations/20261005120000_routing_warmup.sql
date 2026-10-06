-- Aquecimento de contas no roteamento (2026-10-05).
--
-- Conta nova recebendo o volume cheio no primeiro dia é o que mais derruba
-- conta na Stripe/Whop/PayPal. Com o aquecimento ligado, os limites do dia
-- sobem aos poucos:
--   limite do dia N = início × (1 + crescimento/100)^(N − 1)
-- nunca acima do teto diário da conta (daily_cap_*), com ticket máximo
-- opcional enquanto durar. Os dias contam no fuso de Brasília.
--
-- Só adiciona colunas (null = sem aquecimento). Idempotente. Depende de
-- 20260928160000_seller_routing.

alter table public.seller_routing_accounts
  add column if not exists warmup_started_at timestamptz,
  add column if not exists warmup_days int
    check (warmup_days is null or (warmup_days >= 1 and warmup_days <= 90)),
  add column if not exists warmup_start_orders int
    check (warmup_start_orders is null or warmup_start_orders >= 1),
  add column if not exists warmup_start_usd_cents bigint
    check (warmup_start_usd_cents is null or warmup_start_usd_cents >= 100),
  add column if not exists warmup_growth_pct numeric
    check (warmup_growth_pct is null or (warmup_growth_pct >= 0 and warmup_growth_pct <= 200)),
  add column if not exists warmup_max_ticket_usd_cents bigint
    check (warmup_max_ticket_usd_cents is null or warmup_max_ticket_usd_cents >= 100);

comment on column public.seller_routing_accounts.warmup_started_at is
  'Início do aquecimento (null = desligado). Ver warmupState em seller-routing.ts.';
