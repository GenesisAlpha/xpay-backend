-- Upsell de um clique na Clip (2026-10-07).
--
-- A Clip não guarda cartão: o card token do SDK é de UM uso e vale 15 minutos
-- (developer.clip.mx/reference/generatecardtoken). Não existe "cobrar de novo o
-- cartão da compra" como na Whop/Stripe.
--
-- O que existe é o mesmo truque do tkt-page: enquanto o formulário da Clip está
-- vivo no checkout, `cardToken()` pode ser chamado de novo e devolve um token
-- NOVO do mesmo cartão, sem o comprador redigitar. O checkout gera alguns tokens
-- extras no momento da compra e manda junto; eles ficam aqui, cifrados, e cada
-- oferta aceita no funil pós-compra consome um.
--
-- Consequências que o desenho aceita:
--   • a janela do upsell Clip é a vida do token (~15 min desde a compra);
--   • cada tentativa consome um token, aprovada ou recusada;
--   • o token só é cobrável pela conta cuja public key montou o iframe — a
--     mesma da compra-mãe, que é para onde o upsell vai.
--
-- Idempotente.

create table if not exists public.gw_clip_upsell_tokens (
  id              bigserial   primary key,
  -- Transação da compra-mãe (pay.transactions.id).
  transaction_id  text        not null,
  seller_id       text        not null,
  -- gw_card_accounts.id: a conta que montou o iframe.
  account_id      text        not null,
  -- Reserva da compra-mãe: os upsells capturam contra ela (folga de upsell).
  reservation_id  uuid,
  -- Token no formato iv:tag:content do CryptoService. Nunca em claro.
  token_enc       text        not null,
  session_id      text,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  -- Transação do upsell que consumiu o token.
  used_by         text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_gw_clip_upsell_tokens_open
  on public.gw_clip_upsell_tokens (transaction_id, id) where used_at is null;

-- Pega UM token livre, atômico: dois cliques simultâneos não levam o mesmo.
-- A folga de 20 s evita entregar um token que vence durante a chamada à Clip.
create or replace function public.gw_take_clip_upsell_token(p_transaction_id text, p_used_by text)
returns table (account_id text, reservation_id uuid, token_enc text, session_id text)
language plpgsql security definer
set search_path = public
as $$
begin
  -- Faxina barata: tokens vencidos há mais de um dia não servem nem de histórico.
  delete from public.gw_clip_upsell_tokens t where t.expires_at < now() - interval '1 day';

  return query
  update public.gw_clip_upsell_tokens t
     set used_at = now(), used_by = p_used_by
   where t.id = (
     select x.id from public.gw_clip_upsell_tokens x
      where x.transaction_id = p_transaction_id
        and x.used_at is null
        and x.expires_at > now() + interval '20 seconds'
      order by x.id
      limit 1
      for update skip locked)
  returning t.account_id, t.reservation_id, t.token_enc, t.session_id;
end $$;

alter table public.gw_clip_upsell_tokens enable row level security;
revoke all on public.gw_clip_upsell_tokens from anon, authenticated;
revoke all on function public.gw_take_clip_upsell_token(text, text) from public, anon, authenticated;
grant execute on function public.gw_take_clip_upsell_token(text, text) to service_role;
