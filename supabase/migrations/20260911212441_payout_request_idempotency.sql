-- Saque idempotente para o fluxo unificado (dash-checkout → checkout → Pay).
--
-- `public.request_payout` continua dona da regra de saldo (ler, travar, debitar
-- available → pending, gravar no ledger). Esta migration só acrescenta uma
-- chave por (seller, Idempotency-Key): a mesma solicitação repetida — clique
-- duplo, retry de rede — devolve o saque já criado em vez de debitar de novo.
--
-- Tudo roda na transação da chamada RPC. Se `request_payout` falhar (saldo
-- insuficiente, valor mínimo…), a reserva da chave é desfeita junto e o seller
-- pode tentar de novo com a mesma chave.
--
-- Pré-requisito verificado pela API do PostgREST em 2026-09-11:
--   request_payout(p_seller_id text, p_amount_cents bigint, p_method text,
--                  p_destination jsonb) → linha(s) com `payout_id`.
-- Antes de aplicar, confirme que existe exatamente uma função com esse nome:
--   select pg_get_functiondef(p.oid)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'request_payout';

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

-- Só o backend (service_role) lê ou escreve. RLS fica ligada sem policies de
-- propósito: nenhum papel de browser deve enxergar a tabela.
alter table public.payout_request_keys enable row level security;

revoke all on table public.payout_request_keys from public, anon, authenticated;
grant select, insert, update on table public.payout_request_keys to service_role;

create or replace function public.request_payout_idempotent(
  p_seller_id text,
  p_idempotency_key text,
  p_request_hash text,
  p_amount_cents bigint,
  p_method text,
  p_destination jsonb
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

  -- Reserva a chave. Uma chamada concorrente com a mesma chave espera neste
  -- insert até a primeira transação terminar: se ela confirmou, cai no replay;
  -- se ela falhou, a reserva sumiu e esta segue criando o saque.
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
      p_destination => p_destination
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

revoke all on function public.request_payout_idempotent(text, text, text, bigint, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.request_payout_idempotent(text, text, text, bigint, text, jsonb)
  to service_role;

comment on table public.payout_request_keys is
  'Idempotency-Key de cada solicitação de saque do fluxo unificado. Repetir a chave devolve o saque original.';

comment on function public.request_payout_idempotent(text, text, text, bigint, text, jsonb) is
  'Wrapper idempotente de request_payout: reserva a chave, recusa reuso com outro conteúdo (KP409) e grava a resposta na mesma transação.';
