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
  add column if not exists payout_fx_fee_pct numeric(6,2);

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
    anticipation_fee_pct  = 0,
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
    anticipation_fee_pct  = 0,
    updated_at            = now()
where overridden_by is null and processing_fee_pct is null;

-- Detalhe das taxas de cada venda (câmbio, checkout, processamento, orquestração,
-- fixa, reserva e as alíquotas usadas) — base da receita por tipo no CRM.
alter table public.transactions
  add column if not exists fee_breakdown jsonb;
