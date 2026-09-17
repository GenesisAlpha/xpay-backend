-- Comissão de afiliado sobre o platform_fee.
--
-- Quem indicou um seller recebe uma fatia da receita da Koopfy em cada
-- transação dele, por uma janela de tempo. Sai da fatia da plataforma, nunca do
-- net do seller — o seller indicado paga exatamente o mesmo que pagaria sem ter
-- sido indicado.
--
-- A identidade do afiliado vive no checkout (bancos separados). O que chega
-- aqui é só o vínculo resolvido: "o seller X é do afiliado Y até a data Z".

-- ── vínculo seller → afiliado ────────────────────────────────────────────────
-- Empurrado pelo checkout quando o workspace ativa o Koopfy Payments, que é
-- quando o seller_id passa a existir dos dois lados.

create table if not exists public.seller_referrals (
  seller_id           text primary key,
  -- Conta que RECEBE a comissão. É um seller como qualquer outro: a comissão
  -- cai na wallet que ele já usa, e o saque é o mesmo fluxo.
  affiliate_seller_id text not null,
  -- Referências do lado do checkout, só para rastreio e suporte.
  affiliate_id        text,
  affiliate_code      text,
  commission_rate_pct numeric(5,2) not null default 20.00,
  -- Fim da janela de comissionamento. Depois disso não acumula mais.
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Ninguém é afiliado de si mesmo.
  constraint seller_referrals_not_self check (seller_id <> affiliate_seller_id)
);

create index if not exists seller_referrals_affiliate_idx
  on public.seller_referrals (affiliate_seller_id);

-- ── comissões apuradas ───────────────────────────────────────────────────────
-- Espelho consultável do wallet_ledger, com a base de cálculo preservada para
-- o extrato do afiliado e para auditoria ("por que recebi este valor").

create table if not exists public.affiliate_commissions (
  id                  uuid primary key default gen_random_uuid(),
  -- Uma comissão por transação — a mesma trava que o wallet_ledger usa.
  transaction_id      text not null unique,
  affiliate_seller_id text not null,
  source_seller_id    text not null,
  -- Base de cálculo, guardada porque a alíquota do afiliado pode mudar depois.
  platform_fee_cents  bigint not null,
  commission_rate_pct numeric(5,2) not null,
  commission_cents    bigint not null,
  currency            text not null default 'USD',
  -- pending → available (pelo cron) → paid (no saque).
  status              text not null default 'pending',
  available_at        timestamptz not null,
  created_at          timestamptz not null default now()
);

create index if not exists affiliate_commissions_affiliate_idx
  on public.affiliate_commissions (affiliate_seller_id, created_at desc);

create index if not exists affiliate_commissions_pending_idx
  on public.affiliate_commissions (status, available_at)
  where status = 'pending';

-- ── maturação ────────────────────────────────────────────────────────────────
-- Espelha run_settlement_batch, sem a condição de rastreio: a comissão é
-- receita da Koopfy, não uma mercadoria que precisa ser enviada.

create or replace function public.run_affiliate_settlement_batch(p_limit integer default 100)
 returns table(released_count integer, total_amount bigint)
 language plpgsql
as $function$
declare
  v_entry    record;
  v_released int    := 0;
  v_total    bigint := 0;
begin
  for v_entry in
    select wl.*
      from wallet_ledger wl
     where wl.type   = 'credit_affiliate_commission'
       and wl.status = 'pending'
       and wl.available_at <= now()
     order by wl.available_at asc
     limit p_limit
     for update of wl skip locked
  loop
    update wallet_balance
       set pending_balance   = pending_balance   - v_entry.amount,
           available_balance = available_balance + v_entry.amount,
           updated_at = now()
     where seller_id = v_entry.seller_id;

    insert into wallet_ledger
      (seller_id, transaction_id, type, amount, currency, status, created_at)
    values
      (v_entry.seller_id, v_entry.transaction_id, 'release_affiliate_commission',
       v_entry.amount, v_entry.currency, 'completed', now())
    on conflict (transaction_id, type) do nothing;

    update wallet_ledger
       set status = 'completed', updated_at = now()
     where id = v_entry.id;

    update affiliate_commissions
       set status = 'available'
     where transaction_id = v_entry.transaction_id
       and status = 'pending';

    v_released := v_released + 1;
    v_total    := v_total + v_entry.amount;
  end loop;

  released_count := v_released;
  total_amount   := v_total;
  return next;
end $function$;

alter table public.seller_referrals enable row level security;
alter table public.affiliate_commissions enable row level security;
