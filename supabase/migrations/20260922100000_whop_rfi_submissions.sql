-- Pedidos de informação da Whop sobre o NEGÓCIO do seller (o que ele vende,
-- como entrega, descrição, site, políticas) não vão direto para a Whop: a
-- resposta — do seller ou tirada do cadastro — fica aqui até o CRM aprovar.
-- Aprovada, é enviada à(s) verificação(ões) da Whop que pediram.

create table if not exists public.whop_rfi_submissions (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null,
  whop_account_id text null,
  -- inrqi_… — o mesmo pedido pode vir nas verificações da empresa e da pessoa.
  request_id text not null,
  verification_ids text[] not null default '{}',
  requirement text not null,
  label text null,
  -- Resposta: texto e/ou arquivo (bucket privado seller-documents, rfi/…).
  value text null,
  file_path text null,
  file_name text null,
  file_mime text null,
  -- 'seller' (painel do checkout) | 'cadastro' (resposta automática do onboarding)
  source text not null default 'seller' check (source in ('seller', 'cadastro')),
  status text not null default 'pending_review'
    check (status in ('pending_review', 'sent', 'rejected', 'send_failed', 'superseded')),
  review_note text null,
  whop_error text null,
  reviewed_by text null,
  reviewed_at timestamptz null,
  sent_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whop_rfi_submissions_answer check (value is not null or file_path is not null)
);

create index if not exists whop_rfi_submissions_seller_idx
  on public.whop_rfi_submissions (seller_id, created_at desc);
create index if not exists whop_rfi_submissions_pending_idx
  on public.whop_rfi_submissions (created_at) where status = 'pending_review';
-- Uma resposta aguardando revisão por pedido: reenviar substitui a anterior.
create unique index if not exists whop_rfi_submissions_one_pending
  on public.whop_rfi_submissions (seller_id, request_id) where status = 'pending_review';

alter table public.whop_rfi_submissions enable row level security;
revoke all on public.whop_rfi_submissions from public, anon, authenticated;
grant select, insert, update on public.whop_rfi_submissions to service_role;

comment on table public.whop_rfi_submissions is
  'Respostas a pedidos de informação da Whop sobre o negócio do seller, aguardando/aprovadas pelo CRM.';
