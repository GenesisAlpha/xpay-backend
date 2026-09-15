-- Custo do provider e lucro da Koopfy no painel de receita do CRM.
--
-- O custo do provider é calculado na venda pelo modelo fixo (processamento
-- 2,7% + US$ 0,30 + orquestração 0,8% + conversão 1,5% fora de USD) e gravado
-- em transactions.fee_breakdown->'provider_cost' (fee.calculator.ts). Vendas
-- anteriores a esse campo ficam sem custo e fora do lucro.
--
-- Só medição: nada é cobrado do seller.
--
-- O tipo de retorno de crm_revenue_breakdown mudou, então a função é recriada.
--   provider_fee_cents: soma do custo do provider.
--   provider_fee_sales: vendas com custo.
--   provider_fee_revenue_cents: receita da Koopfy (taxa + câmbio) SÓ dessas
--     vendas — o lucro compara receita e custo das mesmas vendas.
--   negative_margin_sales: vendas em que o custo passou da receita da Koopfy.
drop function if exists public.crm_revenue_breakdown(timestamptz, timestamptz, text[]);

create function public.crm_revenue_breakdown(
  p_from timestamptz,
  p_to timestamptz,
  p_excluded text[] default '{}'
)
returns table(
  sales_count bigint,
  fx_fee_cents bigint,
  checkout_fee_cents bigint,
  processing_fee_cents bigint,
  orchestration_fee_cents bigint,
  fixed_fee_cents bigint,
  anticipation_fee_cents bigint,
  chargeback_fee_cents bigint,
  payout_fee_cents bigint,
  provider_fee_cents bigint,
  provider_fee_sales bigint,
  provider_fee_revenue_cents bigint,
  negative_margin_sales bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with sales as (
    select
      count(*)::bigint as sales_count,
      coalesce(sum((t.fee_breakdown->>'fx_fee_cents')::bigint), 0)::bigint            as fx,
      coalesce(sum((t.fee_breakdown->>'checkout_fee_cents')::bigint), 0)::bigint      as checkout,
      coalesce(sum((t.fee_breakdown->>'processing_fee_cents')::bigint), 0)::bigint    as processing,
      coalesce(sum((t.fee_breakdown->>'orchestration_fee_cents')::bigint), 0)::bigint as orchestration,
      coalesce(sum((t.fee_breakdown->>'fixed_fee_cents')::bigint), 0)::bigint         as fixed
      from transactions t
     where t.status = 'approved'
       and t.fee_breakdown is not null
       and t.created_at >= p_from
       and t.created_at < p_to
       and not (t.seller_id = any(p_excluded))
  ),
  provider as (
    select
      coalesce(sum(x.cost), 0)::bigint    as cost,
      count(*)::bigint                    as sales,
      coalesce(sum(x.revenue), 0)::bigint as revenue,
      count(*) filter (where x.cost > x.revenue)::bigint as negative
      from (
        select
          (t.fee_breakdown->'provider_cost'->>'total_cents')::bigint as cost,
          coalesce(t.fee, 0) + coalesce((t.fee_breakdown->>'fx_fee_cents')::bigint, 0) as revenue
          from transactions t
         where t.status = 'approved'
           and t.fee_breakdown ? 'provider_cost'
           and t.created_at >= p_from
           and t.created_at < p_to
           and not (t.seller_id = any(p_excluded))
      ) x
  ),
  ledger as (
    select
      coalesce(sum(abs(wl.amount)) filter (where wl.type = 'anticipation_fee'), 0)::bigint as anticipation,
      coalesce(sum(abs(wl.amount)) filter (where wl.type in ('chargeback_fee', 'chargeback_alert_fee')), 0)::bigint as chargeback,
      coalesce(sum(wl.fee) filter (where wl.type = 'debit_payout' and wl.status = 'completed'), 0)::bigint as payout
      from wallet_ledger wl
     where wl.created_at >= p_from
       and wl.created_at < p_to
       and not (wl.seller_id = any(p_excluded))
  )
  select s.sales_count, s.fx, s.checkout, s.processing, s.orchestration, s.fixed,
         l.anticipation, l.chargeback, l.payout,
         p.cost, p.sales, p.revenue, p.negative
    from sales s, ledger l, provider p;
$$;
