-- Contas Clip como uma entidade só (2026-10-07).
--
-- Até aqui, "conta Clip" eram duas linhas soltas: o cartão em gw_card_accounts
-- (public key + secret) e o SPEI em gw_spei_accounts (CLABE). Nada dizia que as
-- duas eram a MESMA conta na Clip, e ligar/desligar um método era UPDATE no
-- banco. Agora existe a conta-mãe:
--
--   gw_clip_accounts            status (active | paused | inactive)
--     ├─ card_enabled  →  gw_card_accounts.clip_account_id   (vazão, teto diário)
--     └─ spei_enabled  →  gw_spei_accounts.clip_account_id   (estoque, teto de saldo)
--
-- "Só cartão", "cartão + SPEI" e "só SPEI" são as combinações dos dois booleanos.
--
-- ⚠️ AS FUNÇÕES DE RESERVA (gw_hold_card / gw_hold_spei) NÃO MUDAM.
-- Elas continuam olhando só o `status` da linha filha. Quem decide esse status
-- passa a ser a conta-mãe, por trigger: filha ligada a uma mãe tem status
-- derivado = 'active' só quando a mãe está 'active' E o método está ligado.
-- Assim o caminho quente do pagamento fica intocado, e um UPDATE manual numa
-- filha não consegue religar um método que a mãe desligou.
--
-- Filha SEM mãe (clip_account_id null) segue como antes. O backfill abaixo
-- liga as existentes.
--
-- Idempotente. Depende de ops/migration-completa.sql (tabelas gw_*).

create table if not exists public.gw_clip_accounts (
  -- Mesma convenção das filhas: <provider>_<país>_<risco>_<seq>.
  id            text primary key,
  label         text,
  country       text        not null default 'MX',
  currency      text        not null default 'MXN',
  risk_level    text        not null default 'GRAY'
                             check (risk_level in ('WHITE', 'GRAY')),
  -- active   = recebe venda nos métodos ligados
  -- paused   = fora do roteamento, temporário (incidente, revisão da Clip)
  -- inactive = desligada / encerrada
  status        text        not null default 'inactive'
                             check (status in ('active', 'paused', 'inactive')),
  card_enabled  boolean     not null default false,
  spei_enabled  boolean     not null default false,
  notes         text,
  updated_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.gw_card_accounts
  add column if not exists clip_account_id text
    references public.gw_clip_accounts(id) on delete set null;
alter table public.gw_spei_accounts
  add column if not exists clip_account_id text
    references public.gw_clip_accounts(id) on delete set null;

-- Uma configuração de cartão e uma de SPEI por conta Clip.
create unique index if not exists uq_gw_card_accounts_clip
  on public.gw_card_accounts (clip_account_id) where clip_account_id is not null;
create unique index if not exists uq_gw_spei_accounts_clip
  on public.gw_spei_accounts (clip_account_id) where clip_account_id is not null;


-- ── Status derivado das filhas ──────────────────────────────────────────────

create or replace function public.gw_clip_child_status(p_clip_account_id text, p_method text)
returns text
language sql stable security definer
set search_path = public
as $$
  select case
    when p.status = 'active'
     and ((p_method = 'card' and p.card_enabled) or (p_method = 'spei' and p.spei_enabled))
    then 'active' else 'inactive' end
  from public.gw_clip_accounts p
  where p.id = p_clip_account_id
$$;

-- Filha: ao inserir/editar uma filha ligada, o status vem da mãe.
create or replace function public.gw_clip_child_before()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_method text := case when tg_table_name = 'gw_card_accounts' then 'card' else 'spei' end;
  v_status text;
begin
  if new.clip_account_id is not null then
    v_status := public.gw_clip_child_status(new.clip_account_id, v_method);
    if v_status is not null then
      new.status := v_status;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_gw_card_clip_status on public.gw_card_accounts;
create trigger trg_gw_card_clip_status
  before insert or update on public.gw_card_accounts
  for each row execute function public.gw_clip_child_before();

drop trigger if exists trg_gw_spei_clip_status on public.gw_spei_accounts;
create trigger trg_gw_spei_clip_status
  before insert or update on public.gw_spei_accounts
  for each row execute function public.gw_clip_child_before();

-- Mãe: mudou status ou método → recalcula as filhas (o trigger delas aplica).
create or replace function public.gw_clip_parent_after()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  update public.gw_card_accounts set updated_at = now() where clip_account_id = new.id;
  update public.gw_spei_accounts set updated_at = now() where clip_account_id = new.id;
  return null;
end $$;

drop trigger if exists trg_gw_clip_parent on public.gw_clip_accounts;
create trigger trg_gw_clip_parent
  after insert or update of status, card_enabled, spei_enabled on public.gw_clip_accounts
  for each row execute function public.gw_clip_parent_after();


-- ── Secret do cartão sem reescrever a conta ─────────────────────────────────
-- gw_upsert_card_account exige public_key + secret juntos; o CRM troca só o
-- secret quando a Clip gera uma chave nova.
create or replace function public.gw_set_card_secret(p_account_id text, p_secret_enc text)
returns void
language plpgsql security definer
set search_path = public, private
as $$
begin
  if p_secret_enc !~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' then
    raise exception 'secret_enc não está no padrão cifrado iv:tag:content';
  end if;
  if not exists (select 1 from public.gw_card_accounts where id = p_account_id) then
    raise exception 'conta de cartão % inexistente', p_account_id;
  end if;
  insert into private.gw_card_secrets (account_id, secret_enc, updated_at)
  values (p_account_id, p_secret_enc, now())
  on conflict (account_id) do update set secret_enc = excluded.secret_enc, updated_at = now();
end $$;

-- Só diz SE existe secret (o CRM mostra "chave cadastrada"), nunca o valor.
create or replace function public.gw_card_has_secret(p_account_id text)
returns boolean
language sql stable security definer
set search_path = public, private
as $$
  select exists (select 1 from private.gw_card_secrets where account_id = p_account_id)
$$;


-- ── Backfill: cada conta existente ganha a sua mãe ──────────────────────────
-- Cartão: uma mãe por conta de cartão, com o mesmo id e o status atual.
-- SPEI: entra na mãe do mesmo país/risco que ainda não tem SPEI, quando há
-- exatamente UMA candidata (é o caso de clip_mx_gray_01 + spei_mx_gray_01).
-- Sem candidata única, o SPEI ganha mãe própria (só SPEI). Confira no CRM.
do $backfill$
declare
  c record;
  s record;
  v_parent text;
  v_count  int;
begin
  for c in select * from public.gw_card_accounts where clip_account_id is null loop
    insert into public.gw_clip_accounts (id, label, country, currency, risk_level, status, card_enabled)
    values (c.id, c.label, upper(c.country), upper(c.currency), upper(c.risk_level),
            case when c.status = 'active' then 'active' else 'inactive' end, true)
    on conflict (id) do nothing;
    update public.gw_card_accounts set clip_account_id = c.id where id = c.id;
  end loop;

  for s in select * from public.gw_spei_accounts where clip_account_id is null loop
    select count(*), min(p.id) into v_count, v_parent
      from public.gw_clip_accounts p
     where upper(p.country) = upper(s.country)
       and upper(p.risk_level) = upper(s.risk_level)
       and not exists (select 1 from public.gw_spei_accounts x where x.clip_account_id = p.id);

    if v_count = 1 then
      -- Mãe inativa com SPEI ativo: o SPEI estava vendendo e continua; o cartão,
      -- que não vendia, fica desligado (senão a mãe ativa o religaria).
      update public.gw_clip_accounts
         set spei_enabled = (s.status = 'active'),
             card_enabled = case when status <> 'active' and s.status = 'active'
                                 then false else card_enabled end,
             status = case when s.status = 'active' then 'active' else status end,
             updated_at = now()
       where id = v_parent;
      update public.gw_spei_accounts set clip_account_id = v_parent where id = s.id;
    else
      insert into public.gw_clip_accounts (id, label, country, currency, risk_level, status, spei_enabled)
      values (s.id, s.label, upper(s.country), upper(s.currency), upper(s.risk_level),
              case when s.status = 'active' then 'active' else 'inactive' end, true)
      on conflict (id) do nothing;
      update public.gw_spei_accounts set clip_account_id = s.id where id = s.id;
    end if;
  end loop;
end
$backfill$;


-- ── Permissões: igual ao resto do gw_* ──────────────────────────────────────
alter table public.gw_clip_accounts enable row level security;
revoke all on public.gw_clip_accounts from anon, authenticated;

revoke all on function public.gw_clip_child_status(text, text) from public, anon, authenticated;
revoke all on function public.gw_set_card_secret(text, text) from public, anon, authenticated;
revoke all on function public.gw_card_has_secret(text) from public, anon, authenticated;
grant execute on function public.gw_clip_child_status(text, text) to service_role;
grant execute on function public.gw_set_card_secret(text, text) to service_role;
grant execute on function public.gw_card_has_secret(text) to service_role;
