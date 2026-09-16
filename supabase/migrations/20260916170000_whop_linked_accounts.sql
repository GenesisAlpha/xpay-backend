-- Conta Whop PRÓPRIA do seller (modo conexão), diferente da conta conectada.
--
-- Conta conectada: nasce filha da Koopfy, o dinheiro entra na master e a
--   Koopfy divide, guarda reserva e cobre negativo.
-- Conta própria (esta tabela): o seller já tem conta na Whop e só autoriza a
--   Koopfy a cobrar nela, colando uma chave de API. O dinheiro NUNCA passa
--   pela Koopfy: saldo, saque, reembolso e disputa são dele. A Koopfy é só o
--   checkout, e a remuneração vem por comissão de afiliado na conta dele
--   (commission_pct / affiliate_id).
--
-- Por isso a venda nesse modo não credita carteira nem gera saque no pay.
--
-- api_key é cifrada com CRYPTO_MASTER_KEY (CryptoService), igual às contas
-- Stripe. Só cria tabela. Idempotente.

-- Fluxo: o seller pede, o CRM libera o modo conta externa (status 'allowed') e
-- só então o painel dele mostra "Conecte seu provedor externo". A conta e a
-- chave só existem depois que ELE conecta — por isso são nulas no começo.
create table if not exists public.whop_linked_accounts (
  seller_id text primary key,
  whop_account_id text unique,
  company_title text,
  api_key text,
  api_url text,
  -- Webhook criado por nós NA CONTA DELE: sem isso a venda nunca confirma,
  -- porque o webhook da master não recebe eventos de conta que não é filha.
  webhook_id text,
  webhook_secret text,
  -- allowed: CRM liberou e o seller ainda não conectou.
  status text not null default 'allowed'
    check (status in ('allowed', 'active', 'invalid', 'disabled')),
  -- Comissão combinada com o seller, cobrada como afiliado na conta dele.
  -- 3% é o padrão; o CRM altera por seller.
  commission_pct numeric(5, 2) not null default 3,
  -- Afiliado da Koopfy na conta dele: quem recebe a comissão. `affiliate_code`
  -- vai em cada checkout que criamos, para a venda ser atribuída à Koopfy —
  -- as vendas que ele fizer por fora não entram.
  affiliate_id text,
  affiliate_code text,
  affiliate_override_id text,
  last_checked_at timestamptz,
  last_error text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.whop_linked_accounts is
  'Conta Whop do próprio seller autorizada por chave de API. A Koopfy só cobra; o dinheiro fica na conta dele.';
comment on column public.whop_linked_accounts.commission_pct is
  'Comissão da Koopfy nessa conta, cobrada como afiliado na Whop.';

create index if not exists whop_linked_accounts_status_idx
  on public.whop_linked_accounts (status);

alter table public.whop_linked_accounts enable row level security;

-- Exclusivamente server-to-server (service role). A chave nunca vai ao browser.
revoke all on table public.whop_linked_accounts from public, anon, authenticated;
grant select, insert, update on table public.whop_linked_accounts to service_role;
