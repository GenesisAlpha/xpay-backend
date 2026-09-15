-- Várias contas Koopfy Payments por usuário do checkout.
--
-- A conta principal é o usuário do e-mail. Cada conta a mais é um usuário
-- interno com owner_user_id apontando para o dono: KYC, documentos, operação e
-- arquivos (gravados por user_id) ficam separados por conta sem migrar dados.
-- O checkout escolhe a conta do workspace pelo header X-Koopfy-Seller-Id e o
-- pay confere que ela é do mesmo usuário (integration/seller-accounts.ts).

-- Mesmo tipo de users.id (o schema base não está versionado aqui).
do $$
declare
  id_type text;
begin
  select format_type(a.atttypid, a.atttypmod)
    into id_type
    from pg_attribute a
   where a.attrelid = 'public.users'::regclass
     and a.attname = 'id';

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'users' and column_name = 'owner_user_id'
  ) then
    execute format(
      'alter table public.users add column owner_user_id %s references public.users(id) on delete restrict',
      id_type
    );
  end if;
end $$;

comment on column public.users.owner_user_id is
  'Conta Koopfy Payments a mais: usuário do checkout (e-mail) dono desta conta. Nulo na conta principal.';

create index if not exists users_owner_user_id_idx
  on public.users (owner_user_id)
  where owner_user_id is not null;
