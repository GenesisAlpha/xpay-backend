-- Contas PRÓPRIAS do seller na Stripe e no PayPal (provedor externo).
--
-- Mesmo modelo da conta Whop própria (whop_linked_accounts): o seller cola as
-- credenciais da conta DELE, a Koopfy cobra nela e o dinheiro nunca passa pela
-- Koopfy — sem carteira, sem reserva, sem saque no pay. A remuneração é a
-- comissão do CRM (whop_linked_accounts.commission_pct ou 3%), lançada como
-- débito em dólar e cobrada no cartão que o seller salvou na Whop da Koopfy.
--
-- Regras de combinação (decisão do dono, 2026-09-28):
--   • Whop e Stripe cobram cartão: são mutuamente exclusivas (o pay recusa
--     conectar uma com a outra ativa);
--   • PayPal combina com qualquer uma — só atende o método `paypal`.
--
-- Os ids no roteador/webhook são `stripel_<id>` e `paypall_<id>`.
--
-- Roteamento de contas (2026-09-28): com o roteamento ligado o seller tem
-- VÁRIAS contas por provedor. As contas Whop EXTRAS também moram aqui
-- (provider 'whop', id `whopa_<id>`, webhook `/webhook/whop/whopa_<id>`); a Whop
-- principal continua em whop_linked_accounts (carteira e saque são só dela).
-- 'standby' = conta guardada enquanto o roteamento está desligado (volta a
-- 'active' quando o seller liga de novo). A mesma conta externa não entra
-- duas vezes para o mesmo seller: unique (seller_id, provider, account_ref).
--
-- Segredos (secret_enc, webhook_secret_enc) são cifrados com CRYPTO_MASTER_KEY
-- (CryptoService), igual a whop_linked_accounts. Só cria tabelas. Idempotente.

create table if not exists public.seller_provider_accounts (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.seller_profiles (id) on delete cascade,
  provider text not null check (provider in ('stripe', 'paypal', 'whop')),
  status text not null default 'active' check (status in ('active', 'invalid', 'disabled', 'standby')),
  -- Stripe em modo de teste (sk_test_) / PayPal sandbox = 'test'.
  mode text not null default 'live' check (mode in ('live', 'test')),
  -- Stripe acct_… / PayPal app id (quando dá para ler com a credencial) /
  -- Whop biz_… (conta extra).
  account_ref text,
  -- Nome da conta para o painel.
  display_name text,
  -- Stripe pk_… / PayPal client_id / Whop biz_…: públicos, vão para o navegador.
  public_key text,
  -- Stripe sk_/rk_ / PayPal client_secret / chave de API da Whop — cifrado.
  secret_enc text,
  -- Só Whop: base da API usada na conexão (a mesma da conta principal).
  api_url text,
  -- Stripe we_… / PayPal webhook id (o PayPal usa na verificação da assinatura).
  webhook_id text,
  -- Stripe whsec_ / segredo do webhook da Whop (cifrados). O PayPal não usa.
  webhook_secret_enc text,
  last_error text,
  last_checked_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (seller_id, provider, account_ref)
);

comment on table public.seller_provider_accounts is
  'Conta Stripe/PayPal do próprio seller. A Koopfy só cobra; o dinheiro fica na conta dele.';

create index if not exists seller_provider_accounts_account_ref_idx
  on public.seller_provider_accounts (provider, account_ref);

create index if not exists seller_provider_accounts_seller_idx
  on public.seller_provider_accounts (seller_id, provider);

alter table public.seller_provider_accounts enable row level security;

-- Exclusivamente server-to-server (service role). O segredo nunca vai ao browser.
revoke all on table public.seller_provider_accounts from public, anon, authenticated;
grant select, insert, update on table public.seller_provider_accounts to service_role;

-- Dedupe dos webhooks do PayPal (entrega at-least-once, como a Stripe). A PK é
-- a trava: duas entregas simultâneas do mesmo evento morrem no conflito.
create table if not exists public.paypal_webhook_events (
  event_id text primary key,
  account_id text not null,
  event_type text,
  created_at timestamptz not null default now()
);

alter table public.paypal_webhook_events enable row level security;
revoke all on table public.paypal_webhook_events from public, anon, authenticated;
grant select, insert, delete on table public.paypal_webhook_events to service_role;
