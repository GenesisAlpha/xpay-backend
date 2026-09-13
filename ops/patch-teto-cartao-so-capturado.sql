-- ============================================================================
-- PATCH — o teto do cartão passa a contar SÓ o dinheiro CAPTURADO
-- ----------------------------------------------------------------------------
-- Antes, o teto somava `reserved` (dinheiro em voo). Como a reserva nasce no
-- momento em que o formulário de cartão RENDERIZA, o teto media abertura de
-- página e não venda: sete visitas ao checkout matavam o dia sem uma única
-- venda — foi exatamente o que aconteceu.
--
-- Agora ele mede o que entrou. `reserved` continua escriturado (o painel mostra
-- o que está em voo, e gw_capture segue migrando reserved→captured), mas não
-- barra mais ninguém.
--
-- ⚠️ O QUE ISSO CUSTA: cobranças simultâneas podem ultrapassar o teto. Todas
-- leem o mesmo `captured` na mesma janela de segundos e todas passam; o excesso
-- máximo é (N-1) × ticket. Com o volume atual é raro e pequeno.
--
-- ⚠️ NÃO MUDA O SPEI, de propósito — ver o aviso no fim do arquivo.
--
-- Idempotente: pode rodar de novo.
-- ============================================================================

drop function if exists gw_hold_card(bigint, text, text, integer);
create or replace function gw_hold_card(
  p_amount_minor       bigint,
  p_seller_id          text,
  p_country            text,
  p_risk_level         text,
  p_currency           text    default 'MXN',
  p_external_reference text    default null,
  p_ttl_minutes        integer default 180
)
returns table (reservation_id uuid, account_id text, public_key text, held_minor bigint)
language plpgsql security definer as $$
declare
  v_day  date := gw_mx_today();
  v_need bigint;
  v_res  uuid;
  r      record;
begin
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'gw_hold_card: amount_minor inválido (%)', p_amount_minor;
  end if;
  if p_seller_id is null or btrim(p_seller_id) = '' then
    raise exception 'gw_hold_card: seller_id obrigatório';
  end if;
  if upper(p_risk_level) not in ('WHITE', 'GRAY') then
    raise exception 'gw_hold_card: risk_level inválido (%)', p_risk_level;
  end if;

  perform gw_expire_stale_reservations();

  for r in
    select a.id, a.public_key, a.daily_cap_minor, a.upsell_headroom_minor
      from gw_card_accounts a
      left join gw_card_usage u on u.account_id = a.id and u.day = v_day
     where a.status = 'active'
       and a.currency = p_currency
       and upper(a.country) = upper(p_country)
       and gw_risco_compativel(a.risk_level, p_risk_level)
       and (a.cooldown_until is null or a.cooldown_until <= now())
       and (a.min_ticket_minor is null or p_amount_minor >= a.min_ticket_minor)
       and (a.max_ticket_minor is null or p_amount_minor <= a.max_ticket_minor)
     -- "Enche todas em paralelo": ordena por OCUPAÇÃO RELATIVA, então a conta
     -- proporcionalmente mais vazia recebe a próxima venda. Mantém as contas
     -- quentes, espalha risco e produz um padrão de volume mais suave que
     -- esgotar uma antes de tocar na seguinte.
     -- Para encher UMA POR VEZ, troque este ORDER BY por `a.priority asc`.
     -- É configuração, não estrutura: não exige migração.
     -- Risco EXATO primeiro: seller WHITE só cai numa conta GRAY quando não há
     -- conta WHITE com espaço. O fallback é rede de segurança, não distribuição.
     -- Balanceia pelo MESMO número que barra (capturado). Ordenar por
     -- reserved+captured mandaria tráfego para a conta com menos páginas
     -- abertas, não para a com menos vendas — que é o que o peso quer dizer.
     order by (upper(a.risk_level) = upper(p_risk_level)) desc,
              coalesce(u.captured_minor, 0)::numeric
              / greatest(a.daily_cap_minor * a.weight, 1),
              a.priority, a.id
  loop
    -- Venda base + folga dos upsells, que caem obrigatoriamente nesta conta.
    v_need := p_amount_minor + r.upsell_headroom_minor;

    insert into gw_card_usage (account_id, day) values (r.id, v_day)
      -- `account_id` também é nome de uma coluna do RETURNS TABLE desta
      -- função. Referenciá-lo no conflict target por nome faz o PL/pgSQL
      -- abortar com 42702 (variável de saída x coluna da tabela). Usar a PK
      -- nominal elimina a ambiguidade sem mudar a regra de concorrência.
      on conflict on constraint gw_card_usage_pkey do nothing;

    -- ⚠️ O TETO OLHA SÓ O CAPTURADO — decisão do dono, e é uma troca consciente.
    --
    -- Antes ele somava `reserved`, o dinheiro EM VOO. A intenção era cobrir a
    -- janela entre escolher a conta e cobrar (o token da Clip nasce preso à
    -- conta, então ela é escolhida antes de o comprador ver o campo de cartão).
    -- Na prática isso fazia o teto medir ABERTURA DE PÁGINA, não venda: como a
    -- maioria de quem abre um checkout não paga, sete visitas matavam o teto do
    -- dia sem uma única venda.
    --
    -- Agora o teto mede dinheiro que ENTROU. `reserved` continua sendo
    -- escriturado — o dash mostra o que está em voo, e gw_capture continua
    -- migrando reserved→captured — mas ele não barra mais ninguém.
    --
    -- O QUE ISSO CUSTA, EXPLICITAMENTE: pagamentos simultâneos podem ultrapassar
    -- o teto. Se N cobranças caem na mesma janela de segundos, todas leem o
    -- mesmo `captured` e todas passam; o excesso máximo é (N-1) × ticket. Com o
    -- volume atual isso é raro e pequeno; com volume alto, volte a somar
    -- `reserved` e resolva a origem movendo a reserva do mount para o submit.
    update gw_card_usage
       set reserved_minor = reserved_minor + v_need, updated_at = now()
     where gw_card_usage.account_id = r.id
       and gw_card_usage.day = v_day
       and captured_minor + v_need <= r.daily_cap_minor;

    if found then
      insert into gw_reservations (
        seller_id, method, account_id, currency, country, risk_level, amount_minor, charge_minor,
        held_minor, usage_day, external_reference, expires_at)
      values (
        p_seller_id, 'card', r.id, p_currency, upper(p_country), upper(p_risk_level),
        p_amount_minor, p_amount_minor,
        v_need, v_day, p_external_reference,
        now() + make_interval(mins => p_ttl_minutes))
      returning id into v_res;

      return query select v_res, r.id, r.public_key, v_need;
      return;
    end if;
  end loop;

  return;  -- sem capacidade
end $$;

-- ── A view mostra o livre real ──────────────────────────────────────────────
-- `em_voo_minor` continua na coluna ao lado: o operador vê o que está em
-- trânsito, mas isso não reduz mais o disponível.
create or replace view gw_capacity as
  select
    a.id, a.label, 'card'::text as method, a.currency, a.status,
    a.daily_cap_minor                                   as cap_minor,
    coalesce(u.reserved_minor, 0)                       as em_voo_minor,
    coalesce(u.captured_minor, 0)                       as confirmado_minor,
    greatest(a.daily_cap_minor - coalesce(u.captured_minor, 0), 0) as livre_minor,
    'auditavel'::text                                   as confianca,
    'diario'::text                                      as reposicao,
    a.country, a.risk_level
  from gw_card_accounts a
  left join gw_card_usage u on u.account_id = a.id and u.day = gw_mx_today()
union all
  select
    s.id, s.label, 'spei'::text, s.currency, s.status,
    floor(s.balance_cap_minor * (1 - s.buffer_pct))::bigint,
    coalesce(h.held, 0),
    greatest(s.occupied_minor - coalesce(h.held, 0), 0),
    greatest(floor(s.balance_cap_minor * (1 - s.buffer_pct))::bigint
             - s.occupied_minor, 0),
    'auto-declarado'::text,
    'saque'::text,
    s.country, s.risk_level
  from gw_spei_accounts s
  left join lateral (
    select coalesce(sum(r.held_minor), 0)::bigint as held
      from gw_reservations r
     where r.account_id = s.id and r.method = 'spei' and r.held_minor > 0
  ) h on true;

revoke all on gw_capacity from anon, authenticated;

do $perm$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'gw_hold_card'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$perm$;

-- ── Por que o SPEI NÃO muda ─────────────────────────────────────────────────
--
-- O teto do cartão é de VAZÃO: um limite de quanto o gateway processa por dia.
-- Estourá-lo por alguns pesos numa corrida é chato e reversível.
--
-- O do SPEI é de ESTOQUE: ele mede dinheiro PARADO numa conta bancária real. Se
-- ignorasse o que está em voo, dez pedidos de 6.000 poderiam ser aceitos ao
-- mesmo tempo e as dez transferências cairiam numa conta de teto 10.000 — o
-- dinheiro chega de verdade e não tem como desfazer. Lá o `occupied` precisa
-- continuar somando reserva em aberto.
