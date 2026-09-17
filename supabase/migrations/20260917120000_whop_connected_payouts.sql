-- Saque de seller com conta conectada (feat/saque-conta-conectada).
--
-- A execução do envio (master → conta conectada → banco) vive em
-- wallet_ledger.metadata.execution da linha debit_payout: não há tabela nova.
-- Esta migration só garante o que o fluxo grava e deixa rápidas as duas
-- consultas do ciclo (saques em andamento e varredura de estornos).
--
-- Pré-requisitos: 20260915140000_reserve_release_payout_fees.sql (request_payout
-- com taxas) e 20260915120000_whop_connected_accounts.sql.
--
-- Idempotente. Não altera nem apaga dado existente.

-- Colunas gravadas pelo envio. Já existem nos bancos que rodaram
-- reserve_release_payout_fees; aqui por garantia.
alter table public.wallet_ledger
  add column if not exists completed_at timestamptz,
  add column if not exists updated_at timestamptz,
  add column if not exists provider_payout_id text,
  add column if not exists failure_reason text;

-- O envio usa os status approved → processing → completed | failed. Uma
-- restrição de status que não aceite 'processing' quebraria o saque em
-- produção, no meio do envio. Melhor a migration parar aqui, dizendo o porquê.
do $$
declare
  v_def text;
begin
  for v_def in
    select pg_get_constraintdef(c.oid)
      from pg_constraint c
     where c.conrelid = 'public.wallet_ledger'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%status%'
  loop
    if v_def not ilike '%processing%' or v_def not ilike '%approved%' then
      raise exception 'wallet_ledger tem restrição de status sem approved/processing: %', v_def;
    end if;
  end loop;
end $$;

-- Ciclo de 5 min: saques pela conta conectada ainda em andamento.
create index if not exists wallet_ledger_whop_payout_active_idx
  on public.wallet_ledger (created_at)
  where type = 'debit_payout'
    and status in ('approved', 'processing')
    and (metadata -> 'execution' ->> 'mode') = 'whop_connected';

-- Varredura de estornos: saques pela conta conectada pagos nos últimos dias.
create index if not exists wallet_ledger_whop_payout_completed_idx
  on public.wallet_ledger (completed_at)
  where type = 'debit_payout'
    and status = 'completed'
    and (metadata -> 'execution' ->> 'mode') = 'whop_connected';
