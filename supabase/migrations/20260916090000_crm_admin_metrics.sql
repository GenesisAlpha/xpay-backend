-- Métricas do painel de administração do CRM calculadas no banco.
--
-- O service somava linha por linha no Node, e o PostgREST devolve no máximo
-- 1000 linhas: com mais sellers ou vendas, os totais saíam errados sem aviso.

-- Receita da Koopfy no período, por tipo de taxa.
--   Venda: componentes de transactions.fee_breakdown (vendas aprovadas no novo
--   modelo de taxas; vendas antigas não têm o detalhe).
--   Carteira: antecipação, chargeback e taxa de saque vêm do wallet_ledger.
create or replace function public.crm_revenue_breakdown(
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
  payout_fee_cents bigint
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
         l.anticipation, l.chargeback, l.payout
    from sales s, ledger l;
$$;

-- Saldos somados de toda a plataforma.
create or replace function public.crm_balance_totals(p_excluded text[] default '{}')
returns table(
  sellers bigint,
  available_cents bigint,
  pending_cents bigint,
  reserved_cents bigint,
  withdrawing_cents bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::bigint,
         coalesce(sum(available_balance), 0)::bigint,
         coalesce(sum(pending_balance), 0)::bigint,
         coalesce(sum(reserved_balance), 0)::bigint,
         coalesce(sum(withdrawing_balance), 0)::bigint
    from wallet_balance
   where not (seller_id = any(p_excluded));
$$;

revoke all on function public.crm_revenue_breakdown(timestamptz, timestamptz, text[]) from public, anon, authenticated;
revoke all on function public.crm_balance_totals(text[]) from public, anon, authenticated;
grant execute on function public.crm_revenue_breakdown(timestamptz, timestamptz, text[]) to service_role;
grant execute on function public.crm_balance_totals(text[]) to service_role;

notify pgrst, 'reload schema';
