-- Align the sandbox column contracts with the existing payout RPCs and CRM reports.
alter table public.wallet_ledger
  alter column id drop default,
  alter column id type text using id::text,
  alter column id set default gen_random_uuid()::text;

alter table public.wallet_balance
  add column withdrawing_balance bigint not null default 0;
