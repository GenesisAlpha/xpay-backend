-- Modo conta externa: o painel da Koopfy mostra saldo, extrato e saque da conta
-- Whop do próprio seller (Wallet Elements, com um token curto emitido pela
-- chave dele). `wallet_ready` guarda se aquela chave libera isso — sem os
-- escopos de saldo/saque a conexão ainda cobra, mas o Financeiro fica cego, e o
-- painel precisa avisar em vez de mostrar uma tela vazia.

alter table public.whop_linked_accounts
  add column if not exists wallet_ready boolean not null default false;

comment on column public.whop_linked_accounts.wallet_ready is
  'A chave conectada permite company:balance:read + payout:withdraw_funds/destination:read/create_destination.';
