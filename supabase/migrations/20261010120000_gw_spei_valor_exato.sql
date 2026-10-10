-- SPEI cobra o valor exato do pedido, sem centavos de identificação (2026-10-10).
--
-- Até aqui o gw_hold_spei trocava os centavos do pedido por um centavo único
-- ("$601.01"): era a chave para casar cada transferência com o seu pedido no
-- extrato. Para o comprador isso parecia valor errado, e o dono da operação
-- decidiu cobrar o valor cheio ("$601").
--
-- O QUE SE PERDE, E O QUE ENTRA NO LUGAR.
-- Dois pedidos de $601 na mesma CLABE passam a ser indistinguíveis no extrato,
-- e UMA transferência poderia aprovar DOIS pedidos (duas capturas diferentes do
-- mesmo comprovante passam pelo dedupe de arquivo). A trava passa a ser do
-- validador (SpeiReceiptService): comprovante com a mesma clave de rastreo, ou
-- com a mesma data/hora e valor de outro pedido já aprovado, vai para revisão
-- humana em vez de aprovar sozinho.
--
-- A coluna `unique_cents` deixa voltar ao comportamento antigo por conta, sem
-- nova migration:  update gw_spei_accounts set unique_cents = true where id = '…';
--
-- Só muda como o valor cobrado é calculado. Seleção de conta, teto com colchão
-- e reserva seguem iguais. Idempotente. Depende de ops/migration-completa.sql.

alter table public.gw_spei_accounts
  add column if not exists unique_cents boolean not null default false;

comment on column public.gw_spei_accounts.unique_cents is
  'true = o valor cobrado troca os centavos por um centavo único por pedido (conciliação pelo extrato). false = valor exato do pedido.';

create or replace function public.gw_hold_spei(
  p_amount_minor       bigint,
  p_seller_id          text,
  p_country            text,
  p_risk_level         text,
  p_currency           text    default 'MXN',
  p_external_reference text    default null,
  p_ttl_minutes        integer default 180
)
returns table (
  reservation_id uuid, account_id text, clabe text, banco text,
  beneficiario text, charge_minor bigint)
language plpgsql security definer as $$
declare
  v_pesos  bigint;
  v_cents  integer;
  v_charge bigint;
  v_res    uuid;
  r        record;
begin
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'gw_hold_spei: amount_minor inválido (%)', p_amount_minor;
  end if;
  if p_seller_id is null or btrim(p_seller_id) = '' then
    raise exception 'gw_hold_spei: seller_id obrigatório';
  end if;
  if upper(p_risk_level) not in ('WHITE', 'GRAY') then
    raise exception 'gw_hold_spei: risk_level inválido (%)', p_risk_level;
  end if;

  perform gw_expire_stale_reservations();

  v_pesos := p_amount_minor / 100;

  for r in
    select a.id, a.clabe, a.banco, a.beneficiario,
           a.balance_cap_minor, a.buffer_pct, a.unique_cents
      from gw_spei_accounts a
     where a.status = 'active' and a.currency = p_currency
       and upper(a.country) = upper(p_country)
       and gw_risco_compativel(a.risk_level, p_risk_level)
     -- Mesma preferência do cartão: exato antes do fallback.
     order by (upper(a.risk_level) = upper(p_risk_level)) desc,
              a.occupied_minor::numeric
              / greatest(a.balance_cap_minor * a.weight, 1),
              a.priority, a.id
  loop
    if r.unique_cents then
      -- Modo antigo: menor centavo livre para (conta, valor em pesos) nos
      -- últimos 30 dias. Sem centavo livre, pula a conta.
      select gs.c into v_cents
        from generate_series(1, 99) gs(c)
       where not exists (
         select 1 from gw_reservations x
          where x.method = 'spei'
            and x.account_id = r.id
            and x.charge_minor = v_pesos * 100 + gs.c
            and x.created_at > now() - interval '30 days')
       order by gs.c
       limit 1;

      if v_cents is null then
        continue;
      end if;

      v_charge := v_pesos * 100 + v_cents;
    else
      -- Valor exato do pedido: é o que o comprador viu no checkout.
      v_charge := p_amount_minor;
    end if;

    update gw_spei_accounts
       set occupied_minor = occupied_minor + v_charge, updated_at = now()
     where id = r.id
       and occupied_minor + v_charge
           <= floor(r.balance_cap_minor * (1 - r.buffer_pct));

    if found then
      insert into gw_reservations (
        seller_id, method, account_id, currency, country, risk_level, amount_minor, charge_minor,
        held_minor, external_reference, expires_at)
      values (
        p_seller_id, 'spei', r.id, p_currency, upper(p_country), upper(p_risk_level),
        p_amount_minor, v_charge,
        v_charge, p_external_reference,
        now() + make_interval(mins => p_ttl_minutes))
      returning id into v_res;

      return query select v_res, r.id, r.clabe, r.banco, r.beneficiario, v_charge;
      return;
    end if;
  end loop;

  return;  -- sem capacidade
end $$;

revoke all on function public.gw_hold_spei(bigint, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.gw_hold_spei(bigint, text, text, text, text, text, integer) to service_role;
