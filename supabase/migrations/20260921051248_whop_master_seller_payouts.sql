-- Koopfy master-funded seller payouts through Whop connected accounts.
--
-- This migration stores only provider references and masked destination data.
-- Raw bank, Pix, crypto, tax, document, verification, and quote-token values
-- must never be written to these tables or RPC arguments.

do $$
begin
  if to_regclass('public.wallet_balance') is null
     or to_regclass('public.wallet_ledger') is null
     or to_regclass('public.seller_profiles') is null
     or to_regclass('public.payout_request_keys') is null then
    raise exception 'Whop payout prerequisites are missing.' using errcode = 'KP500';
  end if;
end;
$$;

create table public.seller_payout_accounts (
  seller_id text primary key references public.seller_profiles(id) on delete cascade,
  provider text not null default 'whop' check (provider = 'whop'),
  provider_account_id text unique,
  status text not null default 'provisioning' check (
    status in (
      'provisioning',
      'verification_required',
      'under_review',
      'ready',
      'restricted',
      'error'
    )
  ),
  verification_status text,
  payouts_enabled boolean not null default false,
  last_error_code text,
  last_error_message text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seller_payout_accounts_provider_id_check check (
    provider_account_id is null or provider_account_id ~ '^biz_[A-Za-z0-9_]+$'
  )
);

create table public.seller_payout_methods (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null references public.seller_payout_accounts(seller_id) on delete cascade,
  provider_method_id text not null unique,
  provider_supported_method_id text not null,
  method_key text not null check (
    method_key in (
      'pix',
      'bank_wire',
      'ach_instant',
      'ach_next_day',
      'ach_standard',
      'crypto'
    )
  ),
  delivery_speeds text[] not null default array[]::text[],
  network text,
  destination_country text,
  currency text,
  nickname text,
  institution_name text,
  masked_reference text not null,
  status text not null default 'active' check (
    status in ('active', 'inactive', 'restricted')
  ),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seller_payout_methods_provider_id_check check (
    provider_method_id ~ '^potk_[A-Za-z0-9_]+$'
  ),
  constraint seller_payout_methods_supported_id_check check (
    provider_supported_method_id ~ '^podst_[A-Za-z0-9_]+$'
  ),
  constraint seller_payout_methods_currency_check check (
    currency is null or currency ~ '^[A-Z]{3}$'
  )
);

create unique index seller_payout_methods_one_default_idx
  on public.seller_payout_methods (seller_id)
  where is_default and status = 'active';
create index seller_payout_methods_seller_status_idx
  on public.seller_payout_methods (seller_id, status);

create table public.payout_fee_rules (
  method_key text primary key check (
    method_key in (
      'pix',
      'bank_wire',
      'ach_instant',
      'ach_next_day',
      'ach_standard',
      'crypto'
    )
  ),
  percentage_bps integer not null check (
    percentage_bps between 0 and 10000
  ),
  fixed_fee_usd_cents bigint not null check (fixed_fee_usd_cents >= 0),
  enabled boolean not null default true,
  effective_at timestamptz not null default now(),
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.payout_fee_rules (
  method_key,
  percentage_bps,
  fixed_fee_usd_cents,
  enabled
) values
  ('pix', 200, 300, true),
  ('bank_wire', 100, 300, true),
  ('ach_instant', 100, 300, true),
  ('ach_next_day', 50, 300, true),
  ('ach_standard', 50, 300, true),
  ('crypto', 150, 300, true)
on conflict (method_key) do nothing;

create table public.payout_executions (
  id uuid primary key default gen_random_uuid(),
  ledger_entry_id text not null unique references public.wallet_ledger(id),
  seller_id text not null references public.seller_profiles(id),
  seller_payout_method_id uuid not null references public.seller_payout_methods(id),
  provider_account_id text not null,
  method_key text not null check (
    method_key in (
      'pix',
      'bank_wire',
      'ach_instant',
      'ach_next_day',
      'ach_standard',
      'crypto'
    )
  ),
  delivery_speed text,
  source_currency text not null default 'USD' check (
    source_currency ~ '^[A-Z]{3}$'
  ),
  destination_currency text not null check (
    destination_currency ~ '^[A-Z]{3}$'
  ),
  gross_minor bigint not null check (gross_minor > 0),
  koopfy_fee_minor bigint not null check (koopfy_fee_minor >= 0),
  provider_fee_minor bigint not null check (provider_fee_minor >= 0),
  provider_payout_minor bigint not null check (provider_payout_minor > 0),
  net_minor bigint not null check (net_minor >= 0),
  destination_amount_minor bigint not null check (destination_amount_minor >= 0),
  confirmed_minimum_net_minor bigint not null check (
    confirmed_minimum_net_minor >= 0
  ),
  quote_id text,
  quote_expires_at timestamptz,
  exchange_rate numeric,
  estimated_arrival timestamptz,
  provider_idempotency_key text not null unique,
  provider_payout_id text unique,
  provider_status text,
  provider_status_detail text,
  local_state text not null default 'pending_review' check (
    local_state in (
      'pending_review',
      'dispatching',
      'processing',
      'completed',
      'failed',
      'canceled',
      'denied',
      'reversed',
      'rejected',
      'requote_required',
      'dispatch_failed'
    )
  ),
  error_code text,
  error_message text,
  claimed_by text,
  claimed_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,
  dispatched_at timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz,
  funds_returned_at timestamptz,
  wallet_restored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_executions_provider_account_check check (
    provider_account_id ~ '^biz_[A-Za-z0-9_]+$'
  ),
  constraint payout_executions_provider_payout_check check (
    provider_payout_id is null or provider_payout_id ~ '^wdrl_[A-Za-z0-9_]+$'
  ),
  constraint payout_executions_amounts_check check (
    koopfy_fee_minor < gross_minor
    and provider_payout_minor = gross_minor - koopfy_fee_minor
    and net_minor <= provider_payout_minor
  )
);

create index payout_executions_state_updated_idx
  on public.payout_executions (local_state, updated_at);
create index payout_executions_seller_created_idx
  on public.payout_executions (seller_id, created_at desc);

alter table public.seller_payout_accounts enable row level security;
alter table public.seller_payout_methods enable row level security;
alter table public.payout_fee_rules enable row level security;
alter table public.payout_executions enable row level security;

revoke all on table public.seller_payout_accounts from public, anon, authenticated;
revoke all on table public.seller_payout_methods from public, anon, authenticated;
revoke all on table public.payout_fee_rules from public, anon, authenticated;
revoke all on table public.payout_executions from public, anon, authenticated;

grant select, insert, update, delete on table public.seller_payout_accounts to service_role;
grant select, insert, update, delete on table public.seller_payout_methods to service_role;
grant select, insert, update on table public.payout_fee_rules to service_role;
grant select, insert, update on table public.payout_executions to service_role;

create or replace function public.request_provider_payout_idempotent(
  p_seller_id text,
  p_idempotency_key text,
  p_request_hash text,
  p_seller_payout_method_id uuid,
  p_method_key text,
  p_speed text,
  p_source_currency text,
  p_destination_currency text,
  p_gross_minor bigint,
  p_koopfy_fee_minor bigint,
  p_provider_fee_minor bigint,
  p_provider_payout_minor bigint,
  p_net_minor bigint,
  p_destination_amount_minor bigint,
  p_quote_id text,
  p_quote_expires_at timestamptz,
  p_exchange_rate numeric,
  p_estimated_arrival timestamptz,
  p_confirmed_minimum_net_minor bigint,
  p_provider_idempotency_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_key public.payout_request_keys;
  payout_account public.seller_payout_accounts;
  payout_method public.seller_payout_methods;
  available_amount bigint;
  created_ledger_id text := gen_random_uuid()::text;
  created_execution_id uuid := gen_random_uuid();
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
  if p_gross_minor <= 0
     or p_koopfy_fee_minor < 0
     or p_provider_fee_minor < 0
     or p_provider_payout_minor <> p_gross_minor - p_koopfy_fee_minor
     or p_net_minor < 0
     or p_net_minor > p_provider_payout_minor
     or p_destination_amount_minor < 0
     or p_confirmed_minimum_net_minor < 0
     or p_net_minor < p_confirmed_minimum_net_minor then
    raise exception 'Snapshot financeiro do payout inválido.' using errcode = '22023';
  end if;
  if p_source_currency !~ '^[A-Z]{3}$'
     or p_destination_currency !~ '^[A-Z]{3}$' then
    raise exception 'Moeda do payout inválida.' using errcode = '22023';
  end if;

  insert into public.payout_request_keys (
    seller_id,
    idempotency_key,
    request_hash
  ) values (
    p_seller_id,
    p_idempotency_key,
    p_request_hash
  )
  on conflict (seller_id, idempotency_key) do nothing;

  if not found then
    select key.*
      into existing_key
      from public.payout_request_keys key
     where key.seller_id = p_seller_id
       and key.idempotency_key = p_idempotency_key;

    if existing_key.request_hash <> p_request_hash then
      raise exception 'Esta chave de idempotência já foi usada em outro saque.'
        using errcode = 'KP409';
    end if;
    if existing_key.response is null then
      raise exception 'Um saque com esta chave ainda está em processamento.'
        using errcode = 'KP425';
    end if;
    return existing_key.response || jsonb_build_object('replayed', true);
  end if;

  select account.*
    into payout_account
    from public.seller_payout_accounts account
   where account.seller_id = p_seller_id
   for update;

  if not found
     or payout_account.status <> 'ready'
     or not payout_account.payouts_enabled
     or payout_account.provider_account_id is null then
    raise exception 'Conta de saque ainda não está pronta.' using errcode = 'KP409';
  end if;

  select method.*
    into payout_method
    from public.seller_payout_methods method
   where method.id = p_seller_payout_method_id
     and method.seller_id = p_seller_id
   for update;

  if not found
     or payout_method.status <> 'active'
     or payout_method.method_key <> p_method_key
     or (
       p_speed is not null
       and not (p_speed = any(payout_method.delivery_speeds))
     ) then
    raise exception 'Método de saque inválido para este seller.' using errcode = 'KP403';
  end if;

  select balance.available_balance
    into available_amount
    from public.wallet_balance balance
   where balance.seller_id = p_seller_id
   for update;

  if not found then
    raise exception 'Carteira do seller não encontrada.' using errcode = 'KP404';
  end if;
  if available_amount < p_gross_minor then
    raise exception 'Saldo disponível insuficiente.' using errcode = 'KP402';
  end if;

  update public.wallet_balance
     set available_balance = available_balance - p_gross_minor,
         withdrawing_balance = withdrawing_balance + p_gross_minor,
         updated_at = now()
   where seller_id = p_seller_id;

  insert into public.wallet_ledger (
    id,
    seller_id,
    type,
    amount,
    fee,
    currency,
    status,
    metadata,
    created_at,
    updated_at
  ) values (
    created_ledger_id,
    p_seller_id,
    'debit_payout',
    p_gross_minor,
    p_koopfy_fee_minor + p_provider_fee_minor,
    p_source_currency,
    'pending_review',
    jsonb_build_object(
      'flow', 'whop_master',
      'methodKey', p_method_key,
      'speed', p_speed
    ),
    now(),
    now()
  );

  insert into public.payout_executions (
    id,
    ledger_entry_id,
    seller_id,
    seller_payout_method_id,
    provider_account_id,
    method_key,
    delivery_speed,
    source_currency,
    destination_currency,
    gross_minor,
    koopfy_fee_minor,
    provider_fee_minor,
    provider_payout_minor,
    net_minor,
    destination_amount_minor,
    confirmed_minimum_net_minor,
    quote_id,
    quote_expires_at,
    exchange_rate,
    estimated_arrival,
    provider_idempotency_key,
    local_state
  ) values (
    created_execution_id,
    created_ledger_id,
    p_seller_id,
    p_seller_payout_method_id,
    payout_account.provider_account_id,
    p_method_key,
    p_speed,
    p_source_currency,
    p_destination_currency,
    p_gross_minor,
    p_koopfy_fee_minor,
    p_provider_fee_minor,
    p_provider_payout_minor,
    p_net_minor,
    p_destination_amount_minor,
    p_confirmed_minimum_net_minor,
    p_quote_id,
    p_quote_expires_at,
    p_exchange_rate,
    p_estimated_arrival,
    p_provider_idempotency_key,
    'pending_review'
  );

  result := jsonb_build_object(
    'payoutId', created_execution_id,
    'ledgerEntryId', created_ledger_id,
    'status', 'pending_review'
  );

  update public.payout_request_keys
     set response = result,
         completed_at = now()
   where seller_id = p_seller_id
     and idempotency_key = p_idempotency_key;

  return result || jsonb_build_object('replayed', false);
end;
$$;

create or replace function public.claim_payout_dispatch(
  p_payout_id uuid,
  p_manager_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  claimed public.payout_executions;
  current_state text;
begin
  if p_manager_id is null or btrim(p_manager_id) = '' then
    raise exception 'manager_id obrigatório.' using errcode = '22023';
  end if;

  update public.payout_executions execution
     set local_state = 'dispatching',
         claimed_by = p_manager_id,
         claimed_at = now(),
         reviewed_by = p_manager_id,
         reviewed_at = now(),
         updated_at = now(),
         error_code = null,
         error_message = null
   where execution.id = p_payout_id
     and execution.local_state = 'pending_review'
  returning execution.* into claimed;

  if found then
    update public.wallet_ledger
       set status = 'approved',
           reviewed_by = p_manager_id,
           reviewed_at = now(),
           updated_at = now()
     where id = claimed.ledger_entry_id;
    return jsonb_build_object(
      'claimed', true,
      'payoutId', claimed.id,
      'state', 'dispatching'
    );
  end if;

  select execution.local_state
    into current_state
    from public.payout_executions execution
   where execution.id = p_payout_id;
  if not found then
    raise exception 'Payout não encontrado.' using errcode = 'KP404';
  end if;
  return jsonb_build_object(
    'claimed', false,
    'payoutId', p_payout_id,
    'state', current_state
  );
end;
$$;

create or replace function public.release_payout_reservation(
  p_payout_id uuid,
  p_manager_id text,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  execution public.payout_executions;
  withdrawing_amount bigint;
begin
  select item.*
    into execution
    from public.payout_executions item
   where item.id = p_payout_id
   for update;

  if not found then
    raise exception 'Payout não encontrado.' using errcode = 'KP404';
  end if;
  if execution.local_state = 'rejected' then
    return jsonb_build_object('released', false, 'state', 'rejected');
  end if;
  if execution.accepted_at is not null or execution.provider_payout_id is not null then
    raise exception 'Payout já aceito pelo provider; a reserva não pode ser liberada.'
      using errcode = 'KP409';
  end if;
  if execution.local_state not in (
    'pending_review',
    'dispatching',
    'requote_required',
    'dispatch_failed'
  ) then
    raise exception 'Estado do payout não permite rejeição.' using errcode = 'KP409';
  end if;

  select balance.withdrawing_balance
    into withdrawing_amount
    from public.wallet_balance balance
   where balance.seller_id = execution.seller_id
   for update;
  if not found or withdrawing_amount < execution.gross_minor then
    raise exception 'Reserva de saldo inconsistente.' using errcode = 'KP500';
  end if;

  update public.wallet_balance
     set withdrawing_balance = withdrawing_balance - execution.gross_minor,
         available_balance = available_balance + execution.gross_minor,
         updated_at = now()
   where seller_id = execution.seller_id;

  update public.wallet_ledger
     set status = 'rejected',
         rejection_reason = nullif(btrim(p_reason), ''),
         reviewed_by = p_manager_id,
         reviewed_at = now(),
         updated_at = now()
   where id = execution.ledger_entry_id;

  update public.payout_executions
     set local_state = 'rejected',
         reviewed_by = p_manager_id,
         reviewed_at = now(),
         error_message = nullif(btrim(p_reason), ''),
         updated_at = now()
   where id = p_payout_id;

  return jsonb_build_object('released', true, 'state', 'rejected');
end;
$$;

create or replace function public.finalize_payout_outflow(
  p_payout_id uuid,
  p_provider_payout_id text,
  p_provider_status text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  execution public.payout_executions;
  withdrawing_amount bigint;
begin
  if p_provider_payout_id is null
     or p_provider_payout_id !~ '^wdrl_[A-Za-z0-9_]+$' then
    raise exception 'ID do payout do provider inválido.' using errcode = '22023';
  end if;

  select item.*
    into execution
    from public.payout_executions item
   where item.id = p_payout_id
   for update;

  if not found then
    raise exception 'Payout não encontrado.' using errcode = 'KP404';
  end if;
  if execution.accepted_at is not null then
    if execution.provider_payout_id <> p_provider_payout_id then
      raise exception 'Payout já vinculado a outro ID do provider.' using errcode = 'KP409';
    end if;
    return jsonb_build_object('finalized', false, 'state', execution.local_state);
  end if;
  if execution.local_state not in ('dispatching', 'processing') then
    raise exception 'Estado do payout não permite finalizar a saída.' using errcode = 'KP409';
  end if;

  select balance.withdrawing_balance
    into withdrawing_amount
    from public.wallet_balance balance
   where balance.seller_id = execution.seller_id
   for update;
  if not found or withdrawing_amount < execution.gross_minor then
    raise exception 'Reserva de saldo inconsistente.' using errcode = 'KP500';
  end if;

  update public.wallet_balance
     set withdrawing_balance = withdrawing_balance - execution.gross_minor,
         updated_at = now()
   where seller_id = execution.seller_id;

  update public.wallet_ledger
     set status = 'processing',
         provider_payout_id = p_provider_payout_id,
         processed_at = now(),
         updated_at = now()
   where id = execution.ledger_entry_id;

  update public.payout_executions
     set provider_payout_id = p_provider_payout_id,
         provider_status = p_provider_status,
         local_state = 'processing',
         dispatched_at = coalesce(dispatched_at, now()),
         accepted_at = now(),
         updated_at = now()
   where id = p_payout_id;

  return jsonb_build_object('finalized', true, 'state', 'processing');
end;
$$;

create or replace function public.restore_provider_payout_funds(
  p_payout_id uuid,
  p_terminal_state text,
  p_funds_returned_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  execution public.payout_executions;
begin
  if p_terminal_state not in ('failed', 'canceled', 'denied', 'reversed') then
    raise exception 'Estado terminal inválido.' using errcode = '22023';
  end if;

  select item.*
    into execution
    from public.payout_executions item
   where item.id = p_payout_id
   for update;
  if not found then
    raise exception 'Payout não encontrado.' using errcode = 'KP404';
  end if;

  if execution.wallet_restored_at is not null then
    return jsonb_build_object('restored', false, 'state', execution.local_state);
  end if;

  update public.payout_executions
     set local_state = p_terminal_state,
         provider_status = p_terminal_state,
         provider_status_detail = nullif(btrim(p_reason), ''),
         funds_returned_at = coalesce(p_funds_returned_at, funds_returned_at),
         completed_at = case
           when p_terminal_state = 'completed' then coalesce(completed_at, now())
           else completed_at
         end,
         updated_at = now()
   where id = p_payout_id;

  update public.wallet_ledger
     set status = p_terminal_state,
         failure_reason = case
           when p_terminal_state in ('failed', 'canceled', 'denied', 'reversed')
             then nullif(btrim(p_reason), '')
           else failure_reason
         end,
         updated_at = now()
   where id = execution.ledger_entry_id;

  if p_funds_returned_at is null then
    return jsonb_build_object('restored', false, 'state', p_terminal_state);
  end if;
  if execution.accepted_at is null then
    raise exception 'Payout não foi aceito pelo provider.' using errcode = 'KP409';
  end if;

  perform 1
    from public.wallet_balance balance
   where balance.seller_id = execution.seller_id
   for update;
  if not found then
    raise exception 'Carteira do seller não encontrada.' using errcode = 'KP404';
  end if;

  update public.wallet_balance
     set available_balance = available_balance + execution.gross_minor,
         updated_at = now()
   where seller_id = execution.seller_id;

  update public.payout_executions
     set wallet_restored_at = now(),
         funds_returned_at = p_funds_returned_at,
         updated_at = now()
   where id = p_payout_id
     and wallet_restored_at is null;

  return jsonb_build_object('restored', true, 'state', p_terminal_state);
end;
$$;

create or replace function public.requeue_requoted_payout(
  p_payout_id uuid,
  p_provider_fee_minor bigint,
  p_net_minor bigint,
  p_destination_amount_minor bigint,
  p_quote_id text,
  p_quote_expires_at timestamptz,
  p_exchange_rate numeric,
  p_estimated_arrival timestamptz,
  p_confirmed_minimum_net_minor bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  execution public.payout_executions;
begin
  select item.*
    into execution
    from public.payout_executions item
   where item.id = p_payout_id
   for update;
  if not found then
    raise exception 'Payout não encontrado.' using errcode = 'KP404';
  end if;
  if execution.local_state <> 'requote_required' then
    raise exception 'Payout não aguarda uma nova confirmação.' using errcode = 'KP409';
  end if;
  if execution.accepted_at is not null or execution.provider_payout_id is not null then
    raise exception 'Payout já aceito pelo provider não pode ser recotado.' using errcode = 'KP409';
  end if;
  if p_provider_fee_minor < 0
     or p_net_minor < 0
     or p_net_minor > execution.provider_payout_minor
     or p_net_minor < p_confirmed_minimum_net_minor
     or p_destination_amount_minor < 0 then
    raise exception 'Nova cotação inválida.' using errcode = '22023';
  end if;

  update public.payout_executions
     set provider_fee_minor = p_provider_fee_minor,
         net_minor = p_net_minor,
         destination_amount_minor = p_destination_amount_minor,
         quote_id = p_quote_id,
         quote_expires_at = p_quote_expires_at,
         exchange_rate = p_exchange_rate,
         estimated_arrival = p_estimated_arrival,
         confirmed_minimum_net_minor = p_confirmed_minimum_net_minor,
         local_state = 'pending_review',
         claimed_by = null,
         claimed_at = null,
         error_code = null,
         error_message = null,
         updated_at = now()
   where id = p_payout_id;

  update public.wallet_ledger
     set status = 'pending_review',
         updated_at = now()
   where id = execution.ledger_entry_id;

  return jsonb_build_object('requeued', true, 'state', 'pending_review');
end;
$$;

revoke all on function public.request_provider_payout_idempotent(
  text, text, text, uuid, text, text, text, text, bigint, bigint, bigint,
  bigint, bigint, bigint, text, timestamptz, numeric, timestamptz, bigint, text
) from public, anon, authenticated;
revoke all on function public.claim_payout_dispatch(uuid, text)
  from public, anon, authenticated;
revoke all on function public.release_payout_reservation(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.finalize_payout_outflow(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.restore_provider_payout_funds(uuid, text, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.requeue_requoted_payout(
  uuid, bigint, bigint, bigint, text, timestamptz, numeric, timestamptz, bigint
) from public, anon, authenticated;

grant execute on function public.request_provider_payout_idempotent(
  text, text, text, uuid, text, text, text, text, bigint, bigint, bigint,
  bigint, bigint, bigint, text, timestamptz, numeric, timestamptz, bigint, text
) to service_role;
grant execute on function public.claim_payout_dispatch(uuid, text)
  to service_role;
grant execute on function public.release_payout_reservation(uuid, text, text)
  to service_role;
grant execute on function public.finalize_payout_outflow(uuid, text, text)
  to service_role;
grant execute on function public.restore_provider_payout_funds(uuid, text, timestamptz, text)
  to service_role;
grant execute on function public.requeue_requoted_payout(
  uuid, bigint, bigint, bigint, text, timestamptz, numeric, timestamptz, bigint
) to service_role;

comment on table public.seller_payout_accounts is
  'Safe seller-to-Whop connected-account references and payout readiness.';
comment on table public.seller_payout_methods is
  'Masked references to payout destinations vaulted by Whop; contains no raw destination fields.';
comment on table public.payout_fee_rules is
  'CRM-managed Koopfy payout markup rules in integer basis points and USD cents.';
comment on table public.payout_executions is
  'Provider payout lifecycle and immutable financial snapshots linked to wallet ledger entries.';
