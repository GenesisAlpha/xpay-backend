-- PROVEDOR POR MÉTODO (10/11/2026).
--
-- A plataforma decide quem cobra cada método ("Pix e SPEI no Kontino, cartão na
-- Kaja Payments"), no lugar do provedor por seller (sellers.provider_default).
-- Regra pura em src/orchestrator/method-routing/method-routing.ts.
--
--   method    : card | apple_pay | google_pay | pix | spei | boleto | mbway | crypto | paypal | link
--   country   : ISO-2 do comprador (null = qualquer)
--   currency  : ISO-4217 (null = qualquer)
--   seller_id : exceção de um seller (null = regra da plataforma)
--   providers : cadeia na ordem (primário, reservas). Provedor indisponível é
--               pulado na hora da cobrança; sem regra vale o comportamento antigo.
--
-- Só o backend (service role) lê e grava.

create table if not exists public.payment_method_routes (
  id uuid primary key default gen_random_uuid(),
  method text not null,
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  seller_id uuid,
  providers text[] not null check (cardinality(providers) between 1 and 5),
  enabled boolean not null default true,
  notes text check (notes is null or char_length(notes) <= 500),
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Uma regra por combinação (null conta como valor: coalesce).
create unique index if not exists payment_method_routes_scope_uq
  on public.payment_method_routes (method, coalesce(country, ''), coalesce(currency, ''), coalesce(seller_id::text, ''));

alter table public.payment_method_routes enable row level security;

-- Histórico de toda alteração (quem, quando, antes e depois).
create table if not exists public.payment_method_route_history (
  id uuid primary key default gen_random_uuid(),
  route_id uuid,
  action text not null check (action in ('created', 'updated', 'deleted')),
  before jsonb,
  after jsonb,
  actor text not null,
  created_at timestamptz not null default now()
);

create index if not exists payment_method_route_history_route_idx
  on public.payment_method_route_history (route_id, created_at desc);

alter table public.payment_method_route_history enable row level security;

-- Política inicial (decisão de 10/11): Pix e SPEI no Kontino, cartão na Kaja
-- Payments.
--
-- Ligadas já: Pix e SPEI (Kontino; sem chave de produção, caem nas reservas).
-- Desligadas (prontas, um clique no CRM): cartão e carteiras na Kaja — a Kaja
-- ainda não tem integração, e ligar agora mudaria o cartão de TODO seller para a
-- reserva da cadeia — e os demais métodos, que seguem no provider_default até
-- alguém ligar. Regra desligada = comportamento antigo.
insert into public.payment_method_routes (method, providers, enabled, notes, updated_by) values
  ('pix',        array['kontino', 'approvebly', 'whop'], true,  'Pix no Kontino', 'migration'),
  ('spei',       array['kontino', 'clip'],               true,  'SPEI no Kontino; Clip de reserva', 'migration'),
  ('card',       array['kaja', 'stripe', 'whop'],        false, 'Cartão na Kaja Payments — ligar quando a integração da Kaja estiver no ar', 'migration'),
  ('apple_pay',  array['kaja', 'stripe', 'whop'],        false, 'Carteira no mesmo provedor do cartão', 'migration'),
  ('google_pay', array['kaja', 'stripe', 'whop'],        false, 'Carteira no mesmo provedor do cartão', 'migration'),
  ('boleto',     array['approvebly'],                    false, 'Cadeia de antes', 'migration'),
  ('mbway',      array['setinel_gate'],                  false, 'Cadeia de antes', 'migration'),
  ('crypto',     array['coinflow', 'whop'],              false, 'Cadeia de antes', 'migration'),
  ('paypal',     array['paypal'],                        false, 'Só a conta PayPal do próprio seller', 'migration'),
  ('link',       array['stripe'],                        false, 'Cadeia de antes', 'migration')
on conflict do nothing;
