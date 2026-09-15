-- Fase 2 do modelo de taxas (2026-09-15): a reserva volta para o seller e o
-- saque cobra as taxas do seller.
--
-- Pré-requisito: 20260915120000_seller_fee_model.sql.
-- Substitui 20260911212441_payout_request_idempotency.sql (nunca aplicada):
-- NÃO aplique aquela depois desta.

-- ═══ Reserva ════════════════════════════════════════════════════════════════
-- Até aqui a reserva de cada venda (wallet_ledger.reserve_hold, status 'hold')
-- não entrava em wallet_balance.reserved_balance e nenhuma função a liberava.

-- Soma a reserva de uma venda no saldo "em reserva". Idempotente: marca a linha
-- com reserve_counted e não soma de novo.
create or replace function public.count_reserve_hold(p_transaction_id text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  select id, seller_id, amount into v_row
    from public.wallet_ledger
   where transaction_id = p_transaction_id and type = 'reserve_hold' and status = 'hold'
     and coalesce((metadata->>'reserve_counted')::boolean, false) = false
   for update;
  if not found then return 0; end if;

  update public.wallet_balance
     set reserved_balance = reserved_balance + v_row.amount, updated_at = now()
   where seller_id = v_row.seller_id;
  if not found then return 0; end if;

  update public.wallet_ledger
     set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('reserve_counted', true),
         updated_at = now()
   where id = v_row.id;
  return v_row.amount;
end;
$$;

-- Cancela a reserva de uma venda estornada ou com chargeback: ela não volta ao
-- seller (fica com a plataforma, que cobriu o estorno).
create or replace function public.cancel_reserve_hold(p_transaction_id text, p_reason text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  select id, seller_id, amount, metadata into v_row
    from public.wallet_ledger
   where transaction_id = p_transaction_id and type = 'reserve_hold' and status = 'hold'
   for update;
  if not found then return 0; end if;

  if coalesce((v_row.metadata->>'reserve_counted')::boolean, false) then
    update public.wallet_balance
       set reserved_balance = greatest(reserved_balance - v_row.amount, 0), updated_at = now()
     where seller_id = v_row.seller_id;
  end if;

  update public.wallet_ledger
     set status = 'cancelled',
         updated_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb)
           || jsonb_build_object('cancelled_reason', p_reason, 'cancelled_at', now())
   where id = v_row.id;
  return v_row.amount;
end;
$$;

-- Libera as reservas vencidas para o disponível (chamada pelo cron de
-- liquidação). Mesma ordem de trava do run_settlement_batch: ledger, depois saldo.
create or replace function public.run_reserve_release_batch(p_limit integer default 100)
returns table(released_count integer, total_amount bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry record;
  v_released int := 0;
  v_total bigint := 0;
  v_tx_status text;
  v_counted boolean;
begin
  for v_entry in
    select wl.*
      from public.wallet_ledger wl
     where wl.type = 'reserve_hold'
       and wl.status = 'hold'
       and wl.available_at <= now()
     order by wl.available_at asc
     limit p_limit
     for update of wl skip locked
  loop
    select t.status into v_tx_status from public.transactions t where t.id = v_entry.transaction_id;
    v_counted := coalesce((v_entry.metadata->>'reserve_counted')::boolean, false);

    if v_tx_status in ('refunded', 'chargeback') then
      if v_counted then
        update public.wallet_balance
           set reserved_balance = greatest(reserved_balance - v_entry.amount, 0), updated_at = now()
         where seller_id = v_entry.seller_id;
      end if;
      update public.wallet_ledger
         set status = 'cancelled', updated_at = now(),
             metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('cancelled_reason', v_tx_status)
       where id = v_entry.id;
      continue;
    end if;

    update public.wallet_balance
       set available_balance = available_balance + v_entry.amount,
           reserved_balance = case when v_counted then greatest(reserved_balance - v_entry.amount, 0) else reserved_balance end,
           updated_at = now()
     where seller_id = v_entry.seller_id;
    if not found then continue; end if;

    insert into public.wallet_ledger (seller_id, transaction_id, type, amount, currency, status, created_at)
    values (v_entry.seller_id, v_entry.transaction_id, 'reserve_release', v_entry.amount, v_entry.currency, 'completed', now())
    on conflict (transaction_id, type) do nothing;

    update public.wallet_ledger
       set status = 'completed', completed_at = now(), updated_at = now()
     where id = v_entry.id;

    v_released := v_released + 1;
    v_total := v_total + v_entry.amount;
  end loop;

  released_count := v_released;
  total_amount := v_total;
  return next;
end;
$$;

-- Reservas já retidas: as de vendas estornadas/chargeback são canceladas; as
-- demais passam a contar no saldo "em reserva" (e serão liberadas no prazo).
update public.wallet_ledger wl
   set status = 'cancelled',
       updated_at = now(),
       metadata = coalesce(wl.metadata, '{}'::jsonb) || jsonb_build_object('cancelled_reason', t.status)
  from public.transactions t
 where t.id = wl.transaction_id
   and wl.type = 'reserve_hold' and wl.status = 'hold'
   and t.status in ('refunded', 'chargeback');

with holds as (
  select wl.id, wl.seller_id, wl.amount
    from public.wallet_ledger wl
    join public.wallet_balance b on b.seller_id = wl.seller_id
   where wl.type = 'reserve_hold' and wl.status = 'hold'
     and coalesce((wl.metadata->>'reserve_counted')::boolean, false) = false
), totals as (
  select seller_id, sum(amount) as total from holds group by seller_id
), balances as (
  update public.wallet_balance b
     set reserved_balance = b.reserved_balance + t.total, updated_at = now()
    from totals t
   where b.seller_id = t.seller_id
  returning b.seller_id
)
update public.wallet_ledger wl
   set metadata = coalesce(wl.metadata, '{}'::jsonb) || jsonb_build_object('reserve_counted', true),
       updated_at = now()
  from holds h
 where wl.id = h.id;

-- ═══ Taxas de saque ═════════════════════════════════════════════════════════
-- O Pay calcula (seller_fees: % , fixa e spread quando o saque sai em outra
-- moeda) e passa para cá. O saldo sai inteiro (amount); o seller recebe
-- amount − fee. wallet_ledger.fee guarda o total das taxas.

drop function if exists public.request_payout_idempotent(text, text, text, bigint, text, jsonb);
drop function if exists public.request_payout(text, bigint, text, jsonb);

create or replace function public.request_payout(
  p_seller_id text,
  p_amount_cents bigint,
  p_method text,
  p_destination jsonb,
  p_fee_cents bigint default 0,
  p_fx_fee_cents bigint default 0,
  p_payout_currency text default 'USD',
  p_fee_details jsonb default '{}'::jsonb
)
returns table(payout_id text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_avail    bigint;
  v_payout   text := gen_random_uuid()::text;
  v_provider text;
  v_network  text;
  v_address  text;
  v_fee      bigint := coalesce(p_fee_cents, 0) + coalesce(p_fx_fee_cents, 0);
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Valor de saque inválido';
  end if;
  if coalesce(p_fee_cents, 0) < 0 or coalesce(p_fx_fee_cents, 0) < 0 or v_fee >= p_amount_cents then
    raise exception 'O valor não cobre as taxas de saque';
  end if;

  select lower(regexp_replace(coalesce(provider_default, ''), 'provider$', ''))
    into v_provider
    from seller_profiles
   where id = p_seller_id;

  if not found then
    raise exception 'Seller não encontrado';
  end if;

  if v_provider = 'clip' and lower(coalesce(p_method, '')) <> 'crypto' then
    raise exception 'Sellers Clip só podem solicitar saque em criptomoeda';
  end if;
  if v_provider <> 'clip' and lower(coalesce(p_method, '')) = 'crypto' then
    raise exception 'Saque em criptomoeda está disponível apenas para sellers Clip';
  end if;

  if v_provider = 'clip' then
    v_network := upper(coalesce(p_destination->>'cryptoNetwork', ''));
    v_address := btrim(coalesce(p_destination->>'cryptoAddress', ''));
    if v_network not in ('TRC20', 'ERC20', 'BEP20') then
      raise exception 'Rede cripto inválida';
    end if;
    if length(v_address) < 10 or length(v_address) > 200 then
      raise exception 'Endereço da carteira cripto inválido';
    end if;
  end if;

  perform _ensure_wallet(p_seller_id);

  select available_balance into v_avail
    from wallet_balance where seller_id = p_seller_id for update;
  if v_avail is null or v_avail < p_amount_cents then
    raise exception 'Saldo insuficiente';
  end if;

  update wallet_balance
     set available_balance   = available_balance - p_amount_cents,
         withdrawing_balance = withdrawing_balance + p_amount_cents,
         updated_at = now()
   where seller_id = p_seller_id;

  insert into wallet_ledger (
    id, seller_id, transaction_id, type, amount, fee, currency, status, metadata, created_at)
  values (
    v_payout, p_seller_id, v_payout, 'debit_payout', p_amount_cents, v_fee, 'USD', 'pending',
    jsonb_build_object(
      'method', lower(p_method),
      'destination', p_destination,
      'payout_currency', upper(coalesce(p_payout_currency, 'USD')),
      'fee_cents', coalesce(p_fee_cents, 0),
      'fx_fee_cents', coalesce(p_fx_fee_cents, 0),
      'net_cents', p_amount_cents - v_fee,
      'fees', coalesce(p_fee_details, '{}'::jsonb)
    ),
    now());

  payout_id := v_payout;
  return next;
end $function$;

revoke all on function public.request_payout(text, bigint, text, jsonb, bigint, bigint, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.request_payout(text, bigint, text, jsonb, bigint, bigint, text, jsonb)
  to service_role;

-- Saque idempotente (fluxo dash-checkout → checkout → Pay): mesma regra da
-- migration de 2026-09-11, agora repassando as taxas.
create table if not exists public.payout_request_keys (
  seller_id text not null,
  idempotency_key text not null,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint payout_request_keys_pkey primary key (seller_id, idempotency_key),
  constraint payout_request_keys_key_format_check
    check (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  constraint payout_request_keys_hash_format_check
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint payout_request_keys_response_object_check
    check (response is null or jsonb_typeof(response) = 'object')
);

alter table public.payout_request_keys enable row level security;
revoke all on table public.payout_request_keys from public, anon, authenticated;
grant select, insert, update on table public.payout_request_keys to service_role;

create or replace function public.request_payout_idempotent(
  p_seller_id text,
  p_idempotency_key text,
  p_request_hash text,
  p_amount_cents bigint,
  p_method text,
  p_destination jsonb,
  p_fee_cents bigint default 0,
  p_fx_fee_cents bigint default 0,
  p_payout_currency text default 'USD',
  p_fee_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.payout_request_keys;
  created_payout_id text;
  result jsonb;
begin
  if p_seller_id is null or btrim(p_seller_id) = '' then
    raise exception 'seller_id obrigatório.' using errcode = '22023';
  end if;
  if p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,128}$' then
    raise exception 'Idempotency-Key inválido.' using errcode = '22023';
  end if;
  if p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Hash da solicitação inválido.' using errcode = '22023';
  end if;

  insert into public.payout_request_keys (seller_id, idempotency_key, request_hash)
  values (p_seller_id, p_idempotency_key, p_request_hash)
  on conflict (seller_id, idempotency_key) do nothing;

  if not found then
    select k.*
      into existing
      from public.payout_request_keys k
     where k.seller_id = p_seller_id
       and k.idempotency_key = p_idempotency_key;

    if existing.request_hash <> p_request_hash then
      raise exception 'Esta chave de idempotência já foi usada em outro saque.'
        using errcode = 'KP409';
    end if;
    if existing.response is null then
      raise exception 'Um saque com esta chave ainda está em processamento.'
        using errcode = 'KP425';
    end if;

    return existing.response || jsonb_build_object('replayed', true);
  end if;

  select r.payout_id::text
    into created_payout_id
    from public.request_payout(
      p_seller_id => p_seller_id,
      p_amount_cents => p_amount_cents,
      p_method => p_method,
      p_destination => p_destination,
      p_fee_cents => p_fee_cents,
      p_fx_fee_cents => p_fx_fee_cents,
      p_payout_currency => p_payout_currency,
      p_fee_details => p_fee_details
    ) as r
   limit 1;

  if created_payout_id is null then
    raise exception 'request_payout não retornou payout_id.' using errcode = 'KP500';
  end if;

  result := jsonb_build_object('payoutId', created_payout_id, 'status', 'processing');

  update public.payout_request_keys k
     set response = result,
         completed_at = now()
   where k.seller_id = p_seller_id
     and k.idempotency_key = p_idempotency_key;

  return result || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.request_payout_idempotent(text, text, text, bigint, text, jsonb, bigint, bigint, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.request_payout_idempotent(text, text, text, bigint, text, jsonb, bigint, bigint, text, jsonb)
  to service_role;

revoke all on function public.count_reserve_hold from public, anon, authenticated;
revoke all on function public.cancel_reserve_hold from public, anon, authenticated;
revoke all on function public.run_reserve_release_batch from public, anon, authenticated;
grant execute on function public.count_reserve_hold to service_role;
grant execute on function public.cancel_reserve_hold to service_role;
grant execute on function public.run_reserve_release_batch to service_role;

-- Recarrega o schema do PostgREST (funções com assinatura nova).
notify pgrst, 'reload schema';
