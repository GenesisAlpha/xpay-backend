-- Novo modelo de taxas do seller (2026-09-15).
--
-- Venda: conversão de moeda (só quando a venda não é em USD), checkout,
-- processamento, orquestração e taxa fixa — todas sobre o valor bruto em USD —
-- e reserva sobre o que sobra. Chargeback (e alerta de chargeback) com taxa
-- fixa. Saque com mínimo, % , fixa e spread quando sai em outra moeda.
-- Padrões em src/shared/fee.calculator.ts (DEFAULT_FEE_SETTINGS); tudo editável
-- por seller no CRM.

alter table public.seller_fees
  add column if not exists fx_fee_pct numeric(6,2),
  add column if not exists checkout_fee_pct numeric(6,2),
  add column if not exists processing_fee_pct numeric(6,2),
  add column if not exists orchestration_fee_pct numeric(6,2),
  add column if not exists chargeback_fee_usd numeric(10,2),
  add column if not exists payout_min_usd numeric(12,2),
  add column if not exists payout_fee_pct numeric(6,2),
  add column if not exists payout_fee_fixed_usd numeric(10,2),
  add column if not exists payout_fx_fee_pct numeric(6,2),
  add column if not exists anticipation_enabled boolean not null default false;

-- Quem teve as taxas ajustadas à mão no CRM mantém o que paga hoje:
-- o percentual antigo vira processamento, sem checkout/orquestração.
update public.seller_fees
set fx_fee_pct            = coalesce(fx_fee_pct, 2),
    checkout_fee_pct      = coalesce(checkout_fee_pct, 0),
    processing_fee_pct    = coalesce(processing_fee_pct, fee_percentage),
    orchestration_fee_pct = coalesce(orchestration_fee_pct, 0),
    chargeback_fee_usd    = coalesce(chargeback_fee_usd, 30),
    payout_min_usd        = coalesce(payout_min_usd, 200),
    payout_fee_pct        = coalesce(payout_fee_pct, 0),
    payout_fee_fixed_usd  = coalesce(payout_fee_fixed_usd, 0),
    payout_fx_fee_pct     = coalesce(payout_fx_fee_pct, 2),
    anticipation_fee_pct  = coalesce(anticipation_fee_pct, 4.99),
    updated_at            = now()
where overridden_by is not null and processing_fee_pct is null;

-- Os demais passam para o padrão novo.
update public.seller_fees
set fx_fee_pct            = 2,
    checkout_fee_pct      = 1.9,
    processing_fee_pct    = 8.9,
    orchestration_fee_pct = 0.9,
    fee_fixed_usd         = 0.59,
    fee_percentage        = 11.7,
    reserve_percentage    = 10,
    reserve_hold_days     = 90,
    settlement_days       = 3,
    chargeback_fee_usd    = 30,
    payout_min_usd        = 200,
    payout_fee_pct        = 0,
    payout_fee_fixed_usd  = 0,
    payout_fx_fee_pct     = 2,
    anticipation_fee_pct  = coalesce(anticipation_fee_pct, 4.99),
    updated_at            = now()
where overridden_by is null and processing_fee_pct is null;

-- Detalhe das taxas de cada venda (câmbio, checkout, processamento, orquestração,
-- fixa, reserva e as alíquotas usadas) — base da receita por tipo no CRM.
alter table public.transactions
  add column if not exists fee_breakdown jsonb;

-- ─── Antecipação do saldo a liquidar ─────────────────────────────────────────
-- Libera de uma vez todos os créditos pendentes do seller (credit_pending ainda
-- em 'pending') para o disponível, descontando a taxa de antecipação. Roda numa
-- transação com o saldo e as linhas travados: a liberação automática não pega
-- as mesmas linhas (ficam 'completed', como na liquidação normal) e uma segunda
-- chamada não encontra nada. `p_expected_cents` é o valor que o seller viu na
-- tela: se mudou (venda nova, estorno, liberação), a antecipação é recusada.
create or replace function public.anticipate_pending_balance(
  p_seller_id public.wallet_ledger.seller_id%type,
  p_fee_pct numeric,
  p_expected_cents bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending bigint;
  v_count integer;
  v_fee bigint;
  v_balance_pending bigint;
  v_ref uuid := gen_random_uuid();
  v_now timestamptz := now();
begin
  if p_fee_pct is null or p_fee_pct < 0 or p_fee_pct > 50 then
    raise exception 'anticipation fee out of range';
  end if;

  -- Mesma ordem de trava do run_settlement_batch (linhas do ledger, depois o
  -- saldo): em ordem invertida as duas se bloqueariam e o Postgres abortaria uma.
  -- Linha que a liquidação já pegou espera o commit dela e sai da soma abaixo.
  perform 1 from public.wallet_ledger
  where seller_id = p_seller_id and type = 'credit_pending' and status = 'pending'
  for update;

  select pending_balance into v_balance_pending
  from public.wallet_balance where seller_id = p_seller_id for update;
  if not found then
    raise exception 'wallet not found';
  end if;

  select coalesce(sum(amount), 0), count(*) into v_pending, v_count
  from public.wallet_ledger
  where seller_id = p_seller_id and type = 'credit_pending' and status = 'pending';

  if v_count = 0 or v_pending <= 0 then
    raise exception 'nothing to anticipate';
  end if;
  if p_expected_cents is not null and v_pending <> p_expected_cents then
    raise exception 'pending changed';
  end if;
  if coalesce(v_balance_pending, 0) < v_pending then
    raise exception 'pending balance mismatch';
  end if;

  v_fee := round(v_pending * p_fee_pct / 100.0);

  update public.wallet_ledger
     set status = 'completed',
         available_at = v_now,
         updated_at = v_now,
         metadata = coalesce(metadata, '{}'::jsonb)
           || jsonb_build_object('anticipated_at', v_now, 'anticipation_ref', v_ref::text)
   where seller_id = p_seller_id and type = 'credit_pending' and status = 'pending';

  update public.wallet_balance
     set pending_balance = pending_balance - v_pending,
         available_balance = available_balance + v_pending - v_fee,
         updated_at = v_now
   where seller_id = p_seller_id;

  insert into public.wallet_ledger (seller_id, transaction_id, type, amount, currency, status, created_at, metadata)
  values (p_seller_id, v_ref::text, 'anticipation_release', v_pending, 'USD', 'completed', v_now,
          jsonb_build_object('entries', v_count));

  if v_fee > 0 then
    insert into public.wallet_ledger (seller_id, transaction_id, type, amount, currency, status, created_at, metadata)
    values (p_seller_id, v_ref::text, 'anticipation_fee', v_fee, 'USD', 'completed', v_now,
            jsonb_build_object('fee_pct', p_fee_pct));
  end if;

  return jsonb_build_object(
    'reference', v_ref,
    'entries', v_count,
    'pending_cents', v_pending,
    'fee_cents', v_fee,
    'net_cents', v_pending - v_fee
  );
end;
$$;

-- Nome único: dispensa a lista de argumentos (e o %type, que o GRANT não aceita).
revoke all on function public.anticipate_pending_balance from public, anon, authenticated;
grant execute on function public.anticipate_pending_balance to service_role;
