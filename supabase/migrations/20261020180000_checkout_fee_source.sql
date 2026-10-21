-- Taxa de checkout com uma fonte só (2026-10-20).
--
-- seller_fees.checkout_fee_pct passa a ser A taxa de checkout do seller, em
-- toda venda — Koopfy Payments, conta própria (Whop/Stripe/PayPal) e as vendas
-- que só o checkout vê (Shopify Payments, Digistore24, gateways de fora). A
-- última escrita vale:
--   'plan'   o checkout gravou o padrão do plano (assinatura, troca, virada
--            do ciclo para outro plano, volta ao gratuito);
--   'crm'    a equipe editou "Checkout (%)" no CRM;
--   'legacy' quem já existia antes desta migration: continua pagando o que
--            paga hoje (Koopfy Payments com checkout_fee_pct; conta própria
--            com whop_linked_accounts.commission_pct ou 3%; checkout com
--            workspaces.plan.commission_fee ou 2,5%) até a primeira troca de
--            plano ou edição no CRM.
--
-- Idempotente: só marca 'legacy' o que ainda não tem origem.

alter table public.seller_fees
  add column if not exists checkout_fee_source text,
  add column if not exists checkout_fee_updated_at timestamptz;

update public.seller_fees
   set checkout_fee_source = 'legacy'
 where checkout_fee_source is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'seller_fees_checkout_fee_source_check'
       and conrelid = 'public.seller_fees'::regclass
  ) then
    alter table public.seller_fees
      add constraint seller_fees_checkout_fee_source_check
      check (checkout_fee_source is null or checkout_fee_source in ('legacy', 'plan', 'crm'));
  end if;
end $$;

comment on column public.seller_fees.checkout_fee_source is
  'Quem gravou checkout_fee_pct por último: plan (checkout), crm (equipe) ou legacy (antes de 2026-10-20). Nulo = legacy.';
