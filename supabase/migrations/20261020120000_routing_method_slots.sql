-- Roteamento por SLOT de método: o pool de contas é um só e cada slot
-- ('card' = cartão + Apple Pay + Google Pay, 'paypal', 'pix', 'ideal'…) tem a
-- sua estratégia e a sua conta por sessão. As colunas antigas (card_strategy,
-- paypal_strategy, card_account_id, paypal_account_id) continuam como espelho
-- dos slots card/paypal para o código antigo durante a subida.

-- Estratégia por slot: { slot: estratégia }. Sem o slot vale paypal_strategy
-- (slot 'paypal') ou card_strategy (todos os outros).
alter table public.seller_routing_settings
  add column if not exists method_strategies jsonb not null default '{}'::jsonb;

-- Conta de cada slot na sessão do comprador: { slot: provider_account_id }.
alter table public.routing_assignments
  add column if not exists method_accounts jsonb not null default '{}'::jsonb;

-- Digistore24 como conta por link (`digistp_<uuid>`): um produto e um
-- formulário de pedido padrão por conta, só em oferta digital de pagamento único.
alter table public.seller_link_accounts drop constraint if exists seller_link_accounts_provider_check;
alter table public.seller_link_accounts add constraint seller_link_accounts_provider_check
  check (provider in ('shopify', 'digistore24'));

alter table public.seller_routing_accounts drop constraint if exists seller_routing_accounts_provider_check;
alter table public.seller_routing_accounts add constraint seller_routing_accounts_provider_check
  check (provider in ('whop', 'stripe', 'paypal', 'shopify', 'digistore24'));
