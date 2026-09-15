-- Contas conectadas da Whop (Whop for Platforms): uma por seller.
--
-- Por que existe: com todas as vendas na conta master, a disputa de UM seller
-- entra na taxa de disputa da master e a Whop aplica reserva/bloqueio na conta
-- inteira — todos os sellers pagam pelo pior deles. Na cobrança direta a venda
-- nasce na conta do seller e a disputa conta lá. O dinheiro vem para a master
-- pela application fee e vai para a conta do seller quando o saldo é liberado.
--
-- whop_connected_accounts: estado da conta conectada de cada seller.
--   charges_enabled = o seller está em MODO CONECTADO.
--   risk_tier RESERVE = chargeback acima de 1% → reserva de 10% na Koopfy
--     (seller_fees.reserve_percentage). base_reserve_percentage guarda a
--     reserva de antes do modo conectado, para voltar se ele for desligado.
--   fallback_started_at / fallback_disabled: com a conta conectada fora do
--     ar, as vendas vão para a master por até 72h (sem reserva acionada e sem
--     o corte do CRM).
-- whop_connected_risk_events: disputas, alertas de disputa e reembolsos por
--   seller (PK = id do objeto na Whop, reentrega não conta duas vezes).
-- whop_connected_risk_window(): numerador e denominador da taxa por seller.
--
-- kyc_info.phone e seller_documents.{identity_*, selfie_path}: a verificação
-- por API (documento + selfie) exige telefone E.164, frente/verso do
-- documento e selfie, que o onboarding não coletava.
--
-- Liberação para a conta conectada: wallet_ledger type 'debit_whop_transfer'
-- (sem coluna nova).
--
-- Só cria/adiciona; não altera nem apaga dado existente. Idempotente.

create table if not exists public.whop_connected_accounts (
  seller_id text primary key,
  whop_account_id text unique,
  status text not null default 'provisioning'
    check (status in (
      'provisioning', 'pending_verification', 'action_required',
      'active', 'restricted', 'suspended', 'rejected'
    )),
  charges_enabled boolean not null default false,
  verification_id text,
  verification_status text,
  requested_information jsonb not null default '[]'::jsonb,
  whop_status text,
  status_reason text,
  capabilities jsonb not null default '{}'::jsonb,
  payment_controls jsonb not null default '{}'::jsonb,
  required_actions jsonb not null default '[]'::jsonb,
  risk_tier text not null default 'OK'
    check (risk_tier in ('OK', 'WATCH', 'RESERVE')),
  risk_reason text,
  risk_evaluated_at timestamptz,
  base_reserve_percentage numeric(5, 2),
  fallback_started_at timestamptz,
  fallback_disabled boolean not null default false,
  last_error text,
  last_synced_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whop_connected_accounts_status_idx
  on public.whop_connected_accounts (status, charges_enabled);

create table if not exists public.whop_connected_risk_events (
  id text primary key,
  seller_id text not null,
  whop_account_id text not null,
  kind text not null check (kind in ('dispute', 'dispute_alert', 'refund')),
  transaction_id text,
  amount_cents bigint,
  currency text,
  reason text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists whop_connected_risk_events_seller_idx
  on public.whop_connected_risk_events (seller_id, kind, created_at desc);

alter table public.kyc_info add column if not exists phone text;

alter table public.seller_documents
  add column if not exists identity_document_type text,
  add column if not exists identity_front_path text,
  add column if not exists identity_back_path text,
  add column if not exists selfie_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'seller_documents_identity_document_type_check'
  ) then
    alter table public.seller_documents
      add constraint seller_documents_identity_document_type_check
      check (identity_document_type is null
        or identity_document_type in ('ID_CARD', 'DRIVERS', 'RESIDENCE_PERMIT', 'PASSPORT'));
  end if;
end $$;

-- Janela de risco por seller em modo conectado. O denominador conta só vendas
-- das contas conectadas (provider_account_id 'whopc_…'): o histórico na master
-- não diz nada sobre a conta que a Whop está medindo agora.
create or replace function public.whop_connected_risk_window(p_seller_id text, p_days integer)
returns table (paid_count bigint, dispute_count bigint, alert_count bigint, refund_count bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (select count(*)
       from public.transactions t
      where t.seller_id::text = p_seller_id
        and t.provider_account_id like 'whopc\_%'
        and t.status in ('approved', 'refunded')
        and t.approved_at >= now() - make_interval(days => p_days)),
    (select count(*)
       from public.whop_connected_risk_events e
      where e.seller_id = p_seller_id and e.kind = 'dispute'
        and e.created_at >= now() - make_interval(days => p_days)),
    (select count(*)
       from public.whop_connected_risk_events e
      where e.seller_id = p_seller_id and e.kind = 'dispute_alert'
        and e.created_at >= now() - make_interval(days => p_days)),
    (select count(*)
       from public.whop_connected_risk_events e
      where e.seller_id = p_seller_id and e.kind = 'refund'
        and e.created_at >= now() - make_interval(days => p_days))
$$;

alter table public.whop_connected_accounts enable row level security;
alter table public.whop_connected_risk_events enable row level security;

-- Exclusivamente server-to-server (service role).
revoke all on table public.whop_connected_accounts from public, anon, authenticated;
revoke all on table public.whop_connected_risk_events from public, anon, authenticated;
grant select, insert, update on table public.whop_connected_accounts to service_role;
grant select, insert on table public.whop_connected_risk_events to service_role;

revoke all on function public.whop_connected_risk_window(text, integer) from public, anon, authenticated;
grant execute on function public.whop_connected_risk_window(text, integer) to service_role;
