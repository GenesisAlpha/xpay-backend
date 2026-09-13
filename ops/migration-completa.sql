-- ============================================================================
-- MIGRATION COMPLETA — roteamento de gateway Clip/SPEI + comprovante por IA
-- ----------------------------------------------------------------------------
-- Rode ESTE arquivo inteiro no SQL Editor do Supabase, de uma vez.
-- Depois o seed (supabase_gw_routing_seed.example.sql), separadamente.
--
-- Contas: <provider>_<país>_<risco>_<seq> — clip_mx_gray_01, spei_mx_gray_01
-- Risco:  seller GRAY → só conta GRAY · seller WHITE → WHITE, GRAY como fallback
--
-- ⚠️ ATIVE AS DUAS CONTAS. O seed insere ambas inativas:
--   update gw_card_accounts set status = 'active' where id = 'clip_mx_gray_01';
--   update gw_spei_accounts set status = 'active' where id = 'spei_mx_gray_01';
-- ============================================================================

-- ============================================================================
-- GATEWAY ROUTING (Clip MX) — roteamento multi-conta com teto por conta
-- ----------------------------------------------------------------------------
-- POR QUE ISTO EXISTE, E POR QUE NÃO REUSA account_daily_metrics.
--
-- O pool que já existe (PROVIDER_ACCOUNTS + account_daily_metrics + markPaid)
-- resolve o problema de UM jeito: conta o volume DEPOIS que o pagamento passou.
-- Para Stripe/Whop isso basta — a conta é escolhida, cobra-se, incrementa.
--
-- Clip não permite isso. O SDK monta o iframe do cartão com a PUBLIC KEY, e o
-- token que sai dali só é cobrável pelo SECRET DA MESMA CONTA. Ou seja: a conta
-- é escolhida ANTES de o comprador digitar o cartão, e não existe retry em
-- cascata (recusou na conta A → tenta na B) sem o cliente redigitar. Entre a
-- escolha e a cobrança passam minutos, e nesses minutos outros checkouts estão
-- escolhendo também. Um contador pós-fato não enxerga o que está em voo: dois
-- checkouts simultâneos furam o teto sem erro nenhum, silenciosamente.
--
-- Daí RESERVA em vez de contador. O espaço é debitado quando a conta é
-- entregue ao browser, não quando o dinheiro entra.
--
-- ⚠️ UNIDADES — A ARMADILHA MAIS CARA DESTE ARQUIVO.
-- account_daily_metrics.volume é em CENTAVOS DE USD. Tudo aqui é em CENTAVOS
-- DA MOEDA DA CONTA (gw_card_accounts.currency), que na operação MX é MXN.
-- Os dois NUNCA se misturam, e é por isso que estas tabelas são novas em vez
-- de colunas nas antigas. O motivo de o teto ser em MXN e não em USD: o limite
-- real é do gateway e é em peso; clip-pay trava currency='MXN'. Teto em dólar
-- convertido na hora flutua com o câmbio e produz recusa surpresa na borda.
--
-- ⚠️ CARTÃO E SPEI SÃO REGRAS OPOSTAS. Não unifique as tabelas.
--   cartão → VAZÃO.   Teto diário, repõe sozinho às 00:00 America/Mexico_City.
--                     Fonte de verdade: GET /payments da Clip.
--   SPEI   → ESTOQUE. Teto de saldo parado, só repõe quando alguém saca.
--                     Fonte de verdade: NENHUMA. Auto-declarado (ver §ledger).
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- CARTÃO — vazão
-- ════════════════════════════════════════════════════════════════════════════

-- Dia da operação. O teto do cartão vira à meia-noite de Cidade do México, não
-- de UTC: com UTC, o corte cairia às 18h local e a conta "zeraria" no meio do
-- horário de pico. Função e não expressão inline para que o corte seja um lugar
-- só — mudar de fuso depois, com histórico gravado, não tem conserto barato.
create or replace function gw_mx_today() returns date
language sql stable as $$
  select (now() at time zone 'America/Mexico_City')::date
$$;


create table if not exists gw_card_accounts (
  -- Convenção: <provider>_<país>_<risco>_<seq> — 'clip_mx_gray_01'.
  -- O risco entra no NOME porque risk_level é filtro DURO no roteamento: conta
  -- com risco errado some do pool de metade dos sellers em silêncio, e o
  -- sintoma que chega é "cartão indisponível", que não aponta para o cadastro.
  -- Vira gw_reservations.account_id e o campo de conciliação no dash — renomear
  -- depois quebra o histórico.
  id                    text primary key,
  label                 text,
  provider              text        not null default 'clip',

  -- Moeda da conta. Governa a unidade de TODOS os campos *_minor abaixo.
  currency              text        not null default 'MXN',
  country               text        not null default 'MX',
  risk_level            text        not null default 'WHITE'
                                     check (risk_level in ('WHITE', 'GRAY')),

  -- public_key vai pro browser montar o iframe — é pública por design, não cifra.
  -- O secret correspondente está em private.gw_card_secrets (fora do PostgREST).
  public_key            text        not null,

  -- ── Teto ──────────────────────────────────────────────────────────────────
  -- Em centavos da moeda acima. 20.000 MXN = 2000000.
  daily_cap_minor       bigint      not null default 1000000,

  -- ⚠️ O CAMPO QUE MAIS GENTE ESQUECE.
  -- Os upsells one-click re-tokenizam o MESMO SDK vivo, na mesma sessão — logo
  -- caem obrigatoriamente na conta da venda base. Hoje somam 299+197+157 = 653
  -- MXN de teto adicional que podem chegar DEPOIS da venda. Se a reserva não
  -- guardar essa folga, o upsell ou estoura o teto ou falha na borda, e falhar
  -- no upsell é perder receita que já estava ganha.
  upsell_headroom_minor bigint      not null default 65300,

  weight                numeric     not null default 1,
  priority              integer     not null default 100,
  min_ticket_minor      bigint,
  max_ticket_minor      bigint,

  status                text        not null default 'inactive',  -- active | inactive
  -- Pausa temporária sem mexer no status (rampa, incidente). Mesmo padrão do
  -- pool Stripe: status é decisão humana, cooldown é decisão do sistema.
  cooldown_until        timestamptz,

  metadata              jsonb       not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Compatibilidade para ambientes onde a primeira versão da migration já rodou.
-- O default de 10.000 MXN só vale no cadastro; cada conta pode ter seu próprio
-- teto. Estas colunas são filtros duros, nunca preferências com fallback.
alter table gw_card_accounts add column if not exists country text;
alter table gw_card_accounts add column if not exists risk_level text;
update gw_card_accounts set country = 'MX' where country is null;
update gw_card_accounts set risk_level = 'WHITE' where risk_level is null;
alter table gw_card_accounts alter column country set default 'MX';
alter table gw_card_accounts alter column country set not null;
alter table gw_card_accounts alter column risk_level set default 'WHITE';
alter table gw_card_accounts alter column risk_level set not null;
alter table gw_card_accounts alter column daily_cap_minor set default 1000000;

create index if not exists idx_gw_card_accounts_active
  on gw_card_accounts (status) where status = 'active';


-- ── Secrets, fora do schema public ──────────────────────────────────────────
--
-- POR QUE UM SCHEMA SEPARADO E NÃO UMA COLUNA CIFRADA EM gw_card_accounts.
-- O PostgREST só expõe os schemas configurados (public por padrão). Uma tabela
-- em `private` é inalcançável pela API REST INDEPENDENTE de RLS — ou seja,
-- continua protegida no dia em que alguém criar uma policy errada, que é
-- exatamente o dia em que ninguém está olhando. Cifra + schema privado são
-- defesas independentes; a cifra sozinha já basta se o master key não vazar,
-- e é justamente por isso que a segunda camada vale.
--
-- Conteúdo no formato iv:tag:content do CryptoService (AES-256-GCM). O secret
-- em claro NUNCA entra aqui, nem em env var, nem em código, nem em chat.
create schema if not exists private;

create table if not exists private.gw_card_secrets (
  account_id  text primary key references gw_card_accounts(id) on delete cascade,
  secret_enc  text        not null,
  key_version integer     not null default 1,
  updated_at  timestamptz not null default now()
);


-- ── Contador do dia — o alvo do lock ────────────────────────────────────────
--
-- reserved_minor = espaço debitado e ainda em voo (conta entregue ao browser,
--                  cobrança ainda não resolvida)
-- captured_minor = dinheiro que de fato entrou
--
-- A soma dos dois é o que compete com o teto. Um pagamento aprovado MIGRA de
-- reserved para captured (não soma nos dois) — ver gw_capture().
create table if not exists gw_card_usage (
  account_id     text        not null references gw_card_accounts(id) on delete cascade,
  day            date        not null,
  reserved_minor bigint      not null default 0,
  captured_minor bigint      not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (account_id, day)
);


-- ════════════════════════════════════════════════════════════════════════════
-- SPEI — estoque
-- ════════════════════════════════════════════════════════════════════════════
--
-- SPEI aqui NÃO passa pela API da Clip: é transferência direta para uma CLABE,
-- que o comprador faz pelo app do banco dele. Decisão deliberada — não
-- re-propor `payment_method: {id: "spei"}` da Clip.
--
-- Consequência: não existe confirmação automática, não existe leitura de saldo
-- (a Clip não tem endpoint de saldo; a API de Depósitos devolve array vazio
-- para Cuenta Digital; Belvo não cobre Clip no México; scraping do painel foi
-- descartado). O saldo é LANÇADO À MÃO no momento do saque.
create table if not exists gw_spei_accounts (
  id             text primary key,
  label          text,
  currency       text        not null default 'MXN',
  country        text        not null default 'MX',
  risk_level     text        not null default 'WHITE'
                              check (risk_level in ('WHITE', 'GRAY')),

  -- Dados que o comprador vê. Públicos por design — não são credencial, e é por
  -- isso que não há tabela `private` correspondente. Saem do HTML estático só
  -- para poderem rotacionar sem redeploy.
  clabe          text        not null,
  banco          text        not null,
  beneficiario   text        not null,

  -- Teto de SALDO PARADO, não de fluxo. Em centavos. 10.000 MXN = 1000000.
  balance_cap_minor bigint   not null default 1000000,

  -- ⚠️ COLCHÃO — OBRIGATÓRIO, E NÃO É PARANOIA.
  -- A CLABE é estática e fica salva no histórico do app do banco de todo mundo
  -- que já comprou. Alguém que comprou há meses consegue transferir de novo:
  -- sem reserva, sem passar pelo checkout, sem nós sabermos. PAGAMENTO FANTASMA
  -- É EVENTO ESPERADO, NÃO BUG. O teto operacional tem que ser menor que o real
  -- para absorvê-lo. 0.20 = o roteador para em 8.000 de um teto de 10.000.
  buffer_pct     numeric     not null default 0.20
                 check (buffer_pct >= 0 and buffer_pct < 1),

  -- Saldo que ACREDITAMOS estar parado na conta. É uma crença, não um fato —
  -- corrigida contra a realidade a cada saque (ver gw_spei_withdraw).
  occupied_minor bigint      not null default 0,

  weight         numeric     not null default 1,
  priority       integer     not null default 100,
  status         text        not null default 'inactive',
  metadata       jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table gw_spei_accounts add column if not exists country text;
alter table gw_spei_accounts add column if not exists risk_level text;
update gw_spei_accounts set country = 'MX' where country is null;
update gw_spei_accounts set risk_level = 'WHITE' where risk_level is null;
alter table gw_spei_accounts alter column country set default 'MX';
alter table gw_spei_accounts alter column country set not null;
alter table gw_spei_accounts alter column risk_level set default 'WHITE';
alter table gw_spei_accounts alter column risk_level set not null;
alter table gw_spei_accounts alter column balance_cap_minor set default 1000000;

create index if not exists idx_gw_spei_accounts_active
  on gw_spei_accounts (status) where status = 'active';


-- ── Razão de saques — onde a deriva aparece ─────────────────────────────────
--
-- ⚠️ ESTA TABELA EXISTE POR CAUSA DE UMA COLUNA: saldo_observado_minor.
--
-- Registrar só o valor sacado seria o óbvio, e seria inútil. Com o saldo REAL
-- que a pessoa vê no app no momento do saque, o dash compara previsto contra
-- observado e acusa o que entrou por fora:
--
--     previa 9.400, saldo real 9.850  →  450 entraram sem passar pelo checkout
--
-- Sem essa coluna a deriva é invisível e o colchão vira chute. Com ela, o
-- colchão passa a ser calibrável com dado real.
create table if not exists gw_spei_ledger (
  id                    bigserial primary key,
  account_id            text        not null references gw_spei_accounts(id) on delete cascade,

  -- O que o sistema achava que tinha CHEGADO na conta, no instante do saque.
  -- ⚠️ Não é occupied_minor puro: occupied inclui reservas ainda em aberto,
  -- cujo dinheiro por definição ainda não entrou. Comparar occupied cru contra
  -- o extrato acusaria deriva negativa a cada pedido não pago — ruído que
  -- esconderia o fantasma real, que é o sinal que esta tabela existe para ver.
  saldo_previsto_minor  bigint      not null,
  -- A parcela de occupied que era reserva em aberto e foi preservada no saque.
  held_aberto_minor     bigint      not null default 0,
  -- O que a pessoa efetivamente viu no app.
  saldo_observado_minor bigint      not null,
  -- observado - previsto. Positivo = entrou dinheiro que não passou pelo
  -- checkout (fantasma). Negativo = saímos do ar em algum ponto do fluxo.
  drift_minor           bigint      not null,

  valor_sacado_minor    bigint      not null,
  -- observado - sacado. Vira o novo occupied_minor da conta.
  saldo_apos_minor      bigint      not null,

  nota                  text,
  created_by            text,
  created_at            timestamptz not null default now()
);

create index if not exists idx_gw_spei_ledger_account
  on gw_spei_ledger (account_id, created_at desc);


-- ════════════════════════════════════════════════════════════════════════════
-- COMUM — o razão do roteamento
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists gw_reservations (
  id                 uuid        primary key default gen_random_uuid(),
  seller_id          text        not null,
  method             text        not null check (method in ('card', 'spei')),
  account_id         text        not null,
  currency           text        not null default 'MXN',
  country            text        not null default 'MX',
  risk_level         text        not null check (risk_level in ('WHITE', 'GRAY')),

  -- Valor da venda base pedido pelo checkout.
  amount_minor       bigint      not null,
  -- Valor que o comprador de fato paga. Para cartão = amount_minor. Para SPEI,
  -- amount_minor com os centavos únicos aplicados (ver gw_hold_spei).
  charge_minor       bigint      not null,

  -- Espaço AINDA debitado no contador. Começa em amount + headroom (cartão) e
  -- decresce a cada captura. Chega a zero, ou é devolvido na finalização.
  held_minor         bigint      not null,

  -- held | captured | released | expired
  state              text        not null default 'held',

  -- Dia de gw_card_usage que esta reserva debitou (null no SPEI, que é estoque
  -- e não tem dia). Guardado explicitamente porque uma reserva pode expirar
  -- DEPOIS da virada: sem isto, a devolução cairia no contador do dia errado —
  -- inflando o teto de hoje com espaço que pertencia a ontem.
  usage_day          date,

  external_reference text,
  clip_payment_id    text,

  -- Por que a reserva terminou: 'finalize' (fluxo acabou, sobrou folga),
  -- 'declined', 'expired', ou o motivo que quem chamou informar. Sem isto, uma
  -- reserva liberada e uma recusada ficam idênticas no histórico — e a pergunta
  -- que o dash precisa responder é justamente qual das duas aconteceu.
  resolution_reason  text,

  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz
);

-- Reservas antigas não tinham owner. Elas não podem ser consumidas pelo fluxo
-- novo; o sentinel abaixo mantém o histórico e impede associação acidental.
alter table gw_reservations add column if not exists seller_id text;
alter table gw_reservations add column if not exists country text;
alter table gw_reservations add column if not exists risk_level text;
update gw_reservations set seller_id = '__legacy__' where seller_id is null;
update gw_reservations set country = 'MX' where country is null;
update gw_reservations set risk_level = 'WHITE' where risk_level is null;
alter table gw_reservations alter column seller_id set not null;
alter table gw_reservations alter column country set default 'MX';
alter table gw_reservations alter column country set not null;
alter table gw_reservations alter column risk_level set not null;

create index if not exists idx_gw_reservations_open
  on gw_reservations (state, expires_at) where state = 'held';
create index if not exists idx_gw_reservations_account
  on gw_reservations (account_id, created_at desc);
create index if not exists idx_gw_reservations_seller
  on gw_reservations (seller_id, created_at desc);
create index if not exists idx_gw_reservations_extref
  on gw_reservations (external_reference) where external_reference is not null;
-- Chave de conciliação do SPEI: valor exato + conta. Ver gw_hold_spei.
create index if not exists idx_gw_reservations_spei_charge
  on gw_reservations (account_id, charge_minor, created_at desc) where method = 'spei';


-- ── Capturas ────────────────────────────────────────────────────────────────
--
-- Uma reserva rende N capturas: a venda base mais até três upsells, todas na
-- mesma conta. Tabela separada para que cada uma tenha o seu payment id.
--
-- ⚠️ clip_payment_id É UNIQUE, E ISSO É A IDEMPOTÊNCIA INTEIRA.
-- O webhook da Clip entrega at-least-once. Sem esta constraint, uma reentrega
-- de COMPLETED credita o teto duas vezes e o contador passa a mentir. A corrida
-- entre duas entregas simultâneas morre no conflito do índice, não num `if` do
-- código — que é onde ela sempre escapa.
create table if not exists gw_captures (
  id              bigserial   primary key,
  reservation_id  uuid        not null references gw_reservations(id) on delete cascade,
  account_id      text        not null,
  method          text        not null,
  amount_minor    bigint      not null,
  currency        text        not null default 'MXN',
  -- 'base' | 'upsell:<id>'
  kind            text        not null default 'base',
  clip_payment_id text        unique,
  receipt_no      text,
  installments    integer,
  source          text,        -- clip-pay | clip-webhook | clip-status | manual
  created_at      timestamptz not null default now()
);

create index if not exists idx_gw_captures_reservation
  on gw_captures (reservation_id, created_at);
-- SPEI só pode ser confirmado uma vez por reserva. O agente pode reenviar a
-- mesma decisão (retry/timeout); esta constraint impede crédito duplicado.
create unique index if not exists uq_gw_captures_spei_reservation
  on gw_captures (reservation_id) where method = 'spei';


-- ════════════════════════════════════════════════════════════════════════════
-- FUNÇÕES
-- ────────────────────────────────────────────────────────────────────────────
-- Todas SECURITY DEFINER: o roteamento decide sozinho, e nem o browser nem o
-- dash precisam de permissão de escrita nestas tabelas para que ele funcione.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Varredura preguiçosa de reservas vencidas ───────────────────────────────
--
-- Chamada no começo de todo hold. Sem cron de propósito: o único momento em que
-- espaço vencido importa é quando alguém precisa de espaço — e é exatamente aí
-- que esta função roda. Um cron acrescentaria uma peça que falha calada.
-- ⚠️ A CONDIÇÃO NÃO É `state = 'held'`, E ISSO IMPORTA MUITO.
-- Uma venda aprovada vira state='captured' mas continua segurando a folga dos
-- upsells (held_minor > 0), porque os upsells ainda podem chegar. Se a varredura
-- só olhasse reservas em 'held', essa folga nunca voltaria: 653 MXN vazados por
-- venda, 30 vendas, e um teto de 20.000 fica inteiro preso em espaço que ninguém
-- vai usar. O que define o que precisa ser devolvido é held_minor, não o estado.
create or replace function gw_expire_stale_reservations()
returns integer
language plpgsql security definer as $$
declare r record; n integer := 0;
begin
  for r in
    select id, state, method, account_id, held_minor, usage_day
      from gw_reservations
     where held_minor > 0 and expires_at < now() and state <> 'released'
     for update skip locked
  loop
    if r.method = 'card' then
      update gw_card_usage
         set reserved_minor = greatest(reserved_minor - r.held_minor, 0),
             updated_at = now()
       where account_id = r.account_id and day = r.usage_day;
    else
      -- SPEI capturado já teve held_minor zerado em gw_capture sem devolver
      -- occupied (o dinheiro chegou de verdade, e ocupa a conta até o saque).
      -- Só cai aqui o que continua sem pagar — esse sim devolve espaço.
      update gw_spei_accounts
         set occupied_minor = greatest(occupied_minor - r.held_minor, 0),
             updated_at = now()
       where id = r.account_id;
    end if;

    update gw_reservations
       -- Nunca rebaixa uma reserva capturada para 'expired': o dinheiro entrou,
       -- e sobrescrever isso apagaria receita real do relatório.
       set state = case when r.state = 'held' then 'expired' else r.state end,
           held_minor = 0,
           resolution_reason = coalesce(resolution_reason, 'ttl'),
           resolved_at = coalesce(resolved_at, now())
     where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;


-- ── Compatibilidade de risco entre seller e conta ───────────────────────────
--
-- ⚠️ A REGRA É ASSIMÉTRICA DE PROPÓSITO. Não "simplifique" para igualdade.
--
--   seller GRAY  → SÓ conta GRAY.
--   seller WHITE → conta WHITE, e GRAY como fallback.
--
-- O motivo está numa direção só: volume GRAY numa conta WHITE CONTAMINA o
-- histórico limpo — quando o gateway olhar aquela conta, ele vê uma conta só,
-- com a taxa de disputa das duas somada. É a mesma lição do `segments` no pool
-- Stripe: isolar o que é arriscado existe para PROTEGER o volume limpo.
--
-- O contrário é inofensivo e até favorável: volume WHITE numa conta GRAY dilui
-- a proporção ruim dela. Por isso o fallback só vale nesse sentido.
--
-- Uma função e não a expressão repetida nos dois holds: duas cópias da mesma
-- regra divergem, e aqui divergir significa mandar venda limpa para a conta
-- errada sem ninguém perceber.
create or replace function gw_risco_compativel(p_conta text, p_seller text)
returns boolean
language sql immutable as $$
  select upper(p_conta) = upper(p_seller)
      or (upper(p_seller) = 'WHITE' and upper(p_conta) = 'GRAY')
$$;


-- ── HOLD: cartão ────────────────────────────────────────────────────────────
--
-- Escolhe a conta E debita o espaço num único statement por candidata. Ler o
-- contador em JS, decidir e só então gravar abriria a janela clássica: dois
-- checkouts leem 19.000/20.000, ambos concluem que cabe 1.500, ambos gravam,
-- e o teto foi furado sem uma linha de erro.
--
-- Aqui o teto está no WHERE do UPDATE. Em READ COMMITTED, a segunda transação
-- bloqueia na linha, e ao desbloquear REAVALIA o WHERE contra a versão nova —
-- então ela simplesmente não encontra linha e cai para a próxima candidata.
-- Zero linhas ao fim do loop = não há espaço em lugar nenhum. Sem corrida.
--
-- Retorna zero linhas quando não há capacidade. Quem chama TEM que tratar isso
-- como "sem espaço", nunca como erro transitório para dar retry.
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
     order by (upper(a.risk_level) = upper(p_risk_level)) desc,
              (coalesce(u.reserved_minor, 0) + coalesce(u.captured_minor, 0))::numeric
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

    update gw_card_usage
       set reserved_minor = reserved_minor + v_need, updated_at = now()
     where gw_card_usage.account_id = r.id
       and gw_card_usage.day = v_day
       and reserved_minor + captured_minor + v_need <= r.daily_cap_minor;

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


-- ── HOLD: SPEI ──────────────────────────────────────────────────────────────
--
-- Duas coisas ao mesmo tempo: reserva contra o SALDO (com colchão) e atribui os
-- CENTAVOS ÚNICOS.
--
-- ⚠️ POR QUE OS CENTAVOS ÚNICOS SÃO INEGOCIÁVEIS.
-- Sem API, a única chave de conciliação disponível é o VALOR que aparece no
-- extrato. Dois pedidos de $1.247,00 na mesma CLABE no mesmo dia são
-- indistinguíveis para sempre — não existe conserto depois. Derivando um
-- centavo distinto por pedido ($1.247,63) cada transferência vira única, e o
-- extrato passa a casar com o pedido linha a linha.
--
-- Os pesos são preservados por floor: a loja precifica em peso cheio, então na
-- prática isto não mexe no preço. Quando o valor já traz centavos, a diferença
-- é de no máximo $0,99 e sempre contra nós — preferível a arredondar para cima
-- e cobrar do comprador mais do que ele viu na tela.
drop function if exists gw_hold_spei(bigint, text, text, integer);
create or replace function gw_hold_spei(
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
           a.balance_cap_minor, a.buffer_pct
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
    -- Menor centavo livre para (conta, valor em pesos). A janela de 30 dias é
    -- maior que o TTL de propósito: o comprador que transfere com atraso ainda
    -- precisa ser distinguível, e reaproveitar o centavo de uma reserva vencida
    -- criaria justamente a ambiguidade que esta função existe para eliminar.
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

    -- 99 pedidos do mesmo valor exato, na mesma conta, em 30 dias. Pular a
    -- conta é a resposta certa: cobrar um valor ambíguo é pior que não cobrar,
    -- porque o prejuízo só aparece na conciliação, semanas depois.
    if v_cents is null then
      continue;
    end if;

    v_charge := v_pesos * 100 + v_cents;

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


-- ── CAPTURE ─────────────────────────────────────────────────────────────────
--
-- Migra espaço de reserved para captured. Chamada pelo clip-pay (síncrono) E
-- pelo clip-webhook (assíncrono) — as duas rotas para o mesmo fato, o que é o
-- ponto: se o browser do comprador morrer entre a cobrança e o registro, o
-- webhook ainda fecha a conta.
--
-- A idempotência é a constraint unique em gw_captures.clip_payment_id, não um
-- `if` aqui. Duas entregas simultâneas do mesmo evento colidem no índice; a
-- perdedora sai por FOUND=false sem tocar em contador nenhum.
--
-- Retorna true se ESTA chamada foi a que contabilizou; false se já estava.
create or replace function gw_capture(
  p_reservation_id  uuid,
  p_amount_minor    bigint,
  p_clip_payment_id text    default null,
  p_kind            text    default 'base',
  p_receipt_no      text    default null,
  p_installments    integer default null,
  p_source          text    default null
)
returns boolean
language plpgsql security definer as $$
declare
  r      record;
  v_take bigint;
  v_ins  bigint;
begin
  select * into r from gw_reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'gw_capture: reserva % inexistente', p_reservation_id;
  end if;

  insert into gw_captures (
    reservation_id, account_id, method, amount_minor, currency,
    kind, clip_payment_id, receipt_no, installments, source)
  values (
    p_reservation_id, r.account_id, r.method, p_amount_minor, r.currency,
    coalesce(p_kind, 'base'), p_clip_payment_id, p_receipt_no, p_installments, p_source)
  -- Sem target: cobre tanto clip_payment_id (cartão/webhook) quanto a unicidade
  -- por reserva do SPEI (agente de comprovante).
  on conflict do nothing
  returning id into v_ins;

  if v_ins is null then
    return false;   -- reentrega: já contabilizado
  end if;

  if r.method = 'card' then
    -- Devolve no máximo o que ainda está segurado. Um upsell que chegue depois
    -- da folga acabar aumenta captured sem zerar reserved abaixo de zero — o
    -- teto fica apertado, que é o comportamento correto, e não corrompido.
    v_take := least(p_amount_minor, r.held_minor);
    update gw_card_usage
       set reserved_minor = greatest(reserved_minor - v_take, 0),
           captured_minor = captured_minor + p_amount_minor,
           updated_at = now()
     where account_id = r.account_id and day = r.usage_day;

    update gw_reservations
       set held_minor = greatest(held_minor - v_take, 0),
           state = 'captured',
           clip_payment_id = coalesce(clip_payment_id, p_clip_payment_id),
           resolved_at = coalesce(resolved_at, now())
     where id = p_reservation_id;
  else
    -- SPEI: occupied NÃO se mexe. A reserva virou dinheiro de verdade parado na
    -- conta, e ele continua ocupando espaço até alguém sacar. Zerar held aqui é
    -- o que impede a varredura de "devolver" um espaço que está ocupado.
    update gw_reservations
       set held_minor = 0,
           state = 'captured',
           resolved_at = coalesce(resolved_at, now())
     where id = p_reservation_id;
  end if;

  return true;
end $$;


-- ── RELEASE / FINALIZE ──────────────────────────────────────────────────────
--
-- release  = a cobrança foi recusada, devolve tudo.
-- finalize = a venda passou e o fluxo de upsell acabou; devolve só a folga que
--            sobrou. É o caminho rápido: sem ele a folga só volta no TTL, e até
--            lá é teto parado sem motivo.
create or replace function gw_release(p_reservation_id uuid, p_reason text default null)
returns boolean
language plpgsql security definer as $$
declare r record;
begin
  select * into r from gw_reservations where id = p_reservation_id for update;
  if not found or r.held_minor = 0 then return false; end if;

  if r.method = 'card' then
    update gw_card_usage
       set reserved_minor = greatest(reserved_minor - r.held_minor, 0), updated_at = now()
     where account_id = r.account_id and day = r.usage_day;
  else
    update gw_spei_accounts
       set occupied_minor = greatest(occupied_minor - r.held_minor, 0), updated_at = now()
     where id = r.account_id;
  end if;

  update gw_reservations
     set held_minor = 0,
         state = case when r.state = 'held' then 'released' else r.state end,
         resolution_reason = coalesce(p_reason, resolution_reason),
         resolved_at = coalesce(resolved_at, now())
   where id = p_reservation_id;
  return true;
end $$;

-- Mesmo efeito de gw_release, nome separado porque a intenção é outra e o dash
-- precisa distinguir "recusado" de "fluxo terminou" ao ler o histórico.
create or replace function gw_finalize(p_reservation_id uuid)
returns boolean
language plpgsql security definer as $$
begin
  return gw_release(p_reservation_id, 'finalize');
end $$;


-- ── SAQUE DO SPEI — onde a verdade entra no sistema ─────────────────────────
--
-- Este é o único momento em que um humano informa o SALDO REAL. Tudo que o
-- sistema acha sobre a conta SPEI é crença acumulada; aqui a crença é
-- confrontada com o extrato e corrigida.
--
-- ⚠️ O PREVISTO NÃO É occupied_minor CRU.
-- occupied inclui reservas em aberto, cujo dinheiro ainda não chegou. Comparar
-- occupied contra o extrato acusaria deriva negativa a cada pedido não pago —
-- ruído constante que esconderia o sinal que interessa: o FANTASMA, dinheiro
-- que entrou sem passar pelo checkout, via CLABE salva no app de um comprador
-- antigo. Por isso o held em aberto é descontado do previsto e PRESERVADO no
-- occupied novo: aquelas reservas continuam válidas depois do saque.
--
-- O occupied depois do saque vem do OBSERVADO, não de aritmética sobre a
-- crença anterior. É isso que faz o contador se auto-corrigir: qualquer deriva
-- acumulada morre aqui, em vez de se somar mês a mês até o teto virar ficção.
create or replace function gw_spei_withdraw(
  p_account_id            text,
  p_saldo_observado_minor bigint,
  p_valor_sacado_minor    bigint,
  p_created_by            text default null,
  p_nota                  text default null
)
returns table (
  drift_minor bigint, saldo_previsto_minor bigint,
  saldo_apos_minor bigint, occupied_minor bigint)
language plpgsql security definer as $$
declare
  a           record;
  v_held      bigint;
  v_previsto  bigint;
  v_drift     bigint;
  v_apos      bigint;
  v_occupied  bigint;
begin
  select * into a from gw_spei_accounts where id = p_account_id for update;
  if not found then
    raise exception 'gw_spei_withdraw: conta % inexistente', p_account_id;
  end if;
  if p_saldo_observado_minor < 0 or p_valor_sacado_minor < 0 then
    raise exception 'gw_spei_withdraw: valores negativos não fazem sentido';
  end if;
  if p_valor_sacado_minor > p_saldo_observado_minor then
    raise exception 'gw_spei_withdraw: sacado (%) maior que observado (%)',
      p_valor_sacado_minor, p_saldo_observado_minor;
  end if;

  select coalesce(sum(held_minor), 0) into v_held
    from gw_reservations
   where account_id = p_account_id and method = 'spei' and held_minor > 0;

  v_previsto := greatest(a.occupied_minor - v_held, 0);
  v_drift    := p_saldo_observado_minor - v_previsto;
  v_apos     := p_saldo_observado_minor - p_valor_sacado_minor;
  v_occupied := v_apos + v_held;

  update gw_spei_accounts
     set occupied_minor = v_occupied, updated_at = now()
   where id = p_account_id;

  insert into gw_spei_ledger (
    account_id, saldo_previsto_minor, held_aberto_minor, saldo_observado_minor,
    drift_minor, valor_sacado_minor, saldo_apos_minor, nota, created_by)
  values (
    p_account_id, v_previsto, v_held, p_saldo_observado_minor,
    v_drift, p_valor_sacado_minor, v_apos, p_nota, p_created_by);

  return query select v_drift, v_previsto, v_apos, v_occupied;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- CAPACIDADE — o que o dash lê
-- ════════════════════════════════════════════════════════════════════════════
--
-- Uma linha por conta, as duas famílias no mesmo formato, para o painel não
-- precisar saber a diferença entre vazão e estoque para desenhar uma barra.
--
-- ⚠️ `confianca` NÃO É DECORAÇÃO.
-- Cartão é conferível contra GET /payments da Clip. SPEI é auto-declarado: o
-- comprovante anexado é INDÍCIO, não confirmação. Se os dois aparecerem com a
-- mesma cara no painel, a conciliação vira teatro — alguém decide com base num
-- número de SPEI achando que ele tem o mesmo lastro do número do cartão.
create or replace view gw_capacity as
  select
    a.id, a.label, 'card'::text as method, a.currency, a.status,
    a.daily_cap_minor                                   as cap_minor,
    coalesce(u.reserved_minor, 0)                       as em_voo_minor,
    coalesce(u.captured_minor, 0)                       as confirmado_minor,
    greatest(a.daily_cap_minor
             - coalesce(u.reserved_minor, 0)
             - coalesce(u.captured_minor, 0), 0)        as livre_minor,
    'auditavel'::text                                   as confianca,
    -- Repõe sozinho na virada do dia em Cidade do México.
    'diario'::text                                      as reposicao,
    a.country, a.risk_level
  from gw_card_accounts a
  left join gw_card_usage u on u.account_id = a.id and u.day = gw_mx_today()
union all
  select
    s.id, s.label, 'spei'::text, s.currency, s.status,
    -- O teto que o roteador respeita é o COM colchão, e é ele que o painel tem
    -- que mostrar. Exibir o teto cheio faria a barra parecer ter espaço que o
    -- roteador nunca vai usar — e alguém tomaria decisão de tráfego com base
    -- num número que não existe.
    floor(s.balance_cap_minor * (1 - s.buffer_pct))::bigint,
    coalesce(h.held, 0),
    greatest(s.occupied_minor - coalesce(h.held, 0), 0),
    greatest(floor(s.balance_cap_minor * (1 - s.buffer_pct))::bigint
             - s.occupied_minor, 0),
    'auto-declarado'::text,
    -- Só volta quando alguém saca. Se esta conta encher, ela para — não tem
    -- meia-noite que a salve.
    'saque'::text,
    s.country, s.risk_level
  from gw_spei_accounts s
  left join lateral (
    select coalesce(sum(r.held_minor), 0)::bigint as held
      from gw_reservations r
     where r.account_id = s.id and r.method = 'spei' and r.held_minor > 0
  ) h on true;


-- ════════════════════════════════════════════════════════════════════════════
-- PERMISSÕES — quem pode tocar em quê
-- ────────────────────────────────────────────────────────────────────────────
-- ⚠️ SEM ESTA SEÇÃO, TODO O RESTO DO ARQUIVO É DECORAÇÃO.
--
-- Duas coisas que o Supabase faz por padrão e que aqui são fatais:
--
--   1. O PostgREST expõe o schema `public`. Sem RLS, qualquer um com a
--      publishable key lê gw_reservations inteira — nomes de conta, valores,
--      referências de pedido.
--   2. Funções criadas em `public` recebem EXECUTE para `public` (ou seja,
--      anon e authenticated). Uma gw_hold_card aberta significa que qualquer
--      pessoa esgota o teto do dia com um loop de curl, sem cobrar nada. O
--      roteador não teria como distinguir isso de venda real.
--
-- O modelo aqui é simples: NADA é acessível pela API REST. Todo acesso passa
-- pelo backend do pay, que usa a service_role — e a service_role ignora RLS.
-- ════════════════════════════════════════════════════════════════════════════

-- ── RLS: ligado e SEM policy nenhuma = negação total via PostgREST ──────────
--
-- Não criamos policy de propósito. RLS ligado sem policy nega tudo para anon e
-- authenticated, e a service_role passa por cima de RLS por definição. Uma
-- policy "permissiva para leitura" aqui seria a porta que esta seção fecha.
alter table gw_card_accounts  enable row level security;
alter table gw_card_usage     enable row level security;
alter table gw_spei_accounts  enable row level security;
alter table gw_spei_ledger    enable row level security;
alter table gw_reservations   enable row level security;
alter table gw_captures       enable row level security;

-- Cinto e suspensório: revoga o grant de tabela também. RLS protege as linhas;
-- isto tira o direito de sequer consultar a relação.
revoke all on gw_card_accounts, gw_card_usage, gw_spei_accounts,
              gw_spei_ledger, gw_reservations, gw_captures
  from anon, authenticated;

-- O schema private nunca é exposto ao PostgREST, mas se alguém o adicionar em
-- `db-schema` um dia, o grant abaixo é o que impede o estrago.
revoke all on all tables in schema private from anon, authenticated;
revoke usage on schema private from anon, authenticated;

-- ── Funções: só a service_role executa ──────────────────────────────────────
--
-- Todas são SECURITY DEFINER, então executam com os privilégios do dono. Deixar
-- EXECUTE aberto para anon transformaria cada uma numa API pública de
-- manipulação de teto. gw_spei_withdraw aberta seria pior ainda: qualquer um
-- reescreveria o saldo declarado da conta.
do $perm$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'gw\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$perm$;

-- A view herda a proteção das tabelas de base, mas o grant explícito evita
-- surpresa se um dia ela virar materialized view (que NÃO herda RLS).
revoke all on gw_capacity from anon, authenticated;


-- ── Secret cifrado: leitura por RPC, nunca por tabela ───────────────────────
--
-- `private.gw_card_secrets` é invisível para o supabase-js, que fala PostgREST
-- e só enxerga schemas expostos. Isso é intencional (ver o comentário da
-- tabela) — e significa que o ClipAccountsService NÃO consegue ler o secret com
-- `.from('gw_card_secrets')`. Esta função é a ponte, e é a única.
--
-- Devolve o BLOB CIFRADO, não o secret. Quem decifra é o CryptoService, com a
-- CRYPTO_MASTER_KEY que só existe no ambiente do pay. Mesmo que esta função
-- vazasse, o blob sozinho não cobra nada.
create or replace function gw_card_secret(p_account_id text)
returns text
language sql security definer
set search_path = private, public
as $$
  select secret_enc from private.gw_card_secrets where account_id = p_account_id
$$;

revoke all on function gw_card_secret(text) from public, anon, authenticated;
grant execute on function gw_card_secret(text) to service_role;

-- Comprovantes SPEI ficam privados. O browser envia ao backend e o CRM recebe
-- apenas uma signed URL curta; não existe URL pública permanente do documento.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'spei-receipts', 'spei-receipts', false, 8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;


-- ════════════════════════════════════════════════════════════════════════════
-- CADASTRO ADMINISTRATIVO DE CONTAS
-- ════════════════════════════════════════════════════════════════════════════
-- O secret da Clip entra JÁ CIFRADO no padrão iv:tag:content. Gere o valor com:
--   node ops/gw-encrypt.js 'sk_live_...'
-- usando a mesma CRYPTO_MASTER_KEY do backend pay.
create or replace function gw_upsert_card_account(
  p_id                    text,
  p_public_key            text,
  p_secret_enc            text,
  p_label                 text    default null,
  p_country               text    default 'MX',
  p_currency              text    default 'MXN',
  p_risk_level            text    default 'WHITE',
  p_daily_cap_minor       bigint  default 1000000,
  p_upsell_headroom_minor bigint  default 65300,
  p_status                text    default 'inactive',
  p_priority              integer default 100,
  p_weight                numeric default 1,
  p_min_ticket_minor      bigint  default null,
  p_max_ticket_minor      bigint  default null
)
returns text
language plpgsql security definer
set search_path = public, private
as $$
begin
  if nullif(btrim(p_id), '') is null or nullif(btrim(p_public_key), '') is null then
    raise exception 'id e public_key são obrigatórios';
  end if;
  if upper(p_risk_level) not in ('WHITE', 'GRAY') then
    raise exception 'risk_level deve ser WHITE ou GRAY';
  end if;
  if p_status not in ('active', 'inactive') then
    raise exception 'status deve ser active ou inactive';
  end if;
  if p_daily_cap_minor <= 0 or p_upsell_headroom_minor < 0 then
    raise exception 'tetos inválidos';
  end if;
  if p_secret_enc !~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' then
    raise exception 'secret_enc não está no padrão cifrado iv:tag:content';
  end if;

  insert into gw_card_accounts (
    id, label, provider, public_key, country, currency, risk_level,
    daily_cap_minor, upsell_headroom_minor, status, priority, weight,
    min_ticket_minor, max_ticket_minor, updated_at)
  values (
    btrim(p_id), p_label, 'clip', btrim(p_public_key), upper(p_country), upper(p_currency),
    upper(p_risk_level), p_daily_cap_minor, p_upsell_headroom_minor,
    p_status, p_priority, p_weight, p_min_ticket_minor, p_max_ticket_minor, now())
  on conflict (id) do update set
    label = excluded.label, public_key = excluded.public_key,
    country = excluded.country, currency = excluded.currency,
    risk_level = excluded.risk_level, daily_cap_minor = excluded.daily_cap_minor,
    upsell_headroom_minor = excluded.upsell_headroom_minor,
    status = excluded.status, priority = excluded.priority, weight = excluded.weight,
    min_ticket_minor = excluded.min_ticket_minor,
    max_ticket_minor = excluded.max_ticket_minor, updated_at = now();

  insert into private.gw_card_secrets (account_id, secret_enc, updated_at)
  values (btrim(p_id), p_secret_enc, now())
  on conflict (account_id) do update set
    secret_enc = excluded.secret_enc, updated_at = now();

  return btrim(p_id);
end $$;


create or replace function gw_upsert_spei_account(
  p_id                text,
  p_clabe             text,
  p_banco             text,
  p_beneficiario      text,
  p_label             text    default null,
  p_country           text    default 'MX',
  p_currency          text    default 'MXN',
  p_risk_level        text    default 'WHITE',
  p_balance_cap_minor bigint  default 1000000,
  p_buffer_pct        numeric default 0.20,
  p_status            text    default 'inactive',
  p_priority          integer default 100,
  p_weight            numeric default 1
)
returns text
language plpgsql security definer
set search_path = public
as $$
begin
  if nullif(btrim(p_id), '') is null or nullif(btrim(p_clabe), '') is null
     or nullif(btrim(p_banco), '') is null or nullif(btrim(p_beneficiario), '') is null then
    raise exception 'id, clabe, banco e beneficiario são obrigatórios';
  end if;
  if btrim(p_clabe) !~ '^[0-9]{18}$' then
    raise exception 'CLABE deve conter exatamente 18 dígitos';
  end if;
  if upper(p_risk_level) not in ('WHITE', 'GRAY') then
    raise exception 'risk_level deve ser WHITE ou GRAY';
  end if;
  if p_status not in ('active', 'inactive') then
    raise exception 'status deve ser active ou inactive';
  end if;
  if p_balance_cap_minor <= 0 or p_buffer_pct < 0 or p_buffer_pct >= 1 then
    raise exception 'teto ou buffer inválido';
  end if;

  insert into gw_spei_accounts (
    id, label, clabe, banco, beneficiario, country, currency, risk_level,
    balance_cap_minor, buffer_pct, status, priority, weight, updated_at)
  values (
    btrim(p_id), p_label, btrim(p_clabe), btrim(p_banco), btrim(p_beneficiario),
    upper(p_country), upper(p_currency), upper(p_risk_level), p_balance_cap_minor,
    p_buffer_pct, p_status, p_priority, p_weight, now())
  on conflict (id) do update set
    label = excluded.label, clabe = excluded.clabe, banco = excluded.banco,
    beneficiario = excluded.beneficiario, country = excluded.country,
    currency = excluded.currency, risk_level = excluded.risk_level,
    balance_cap_minor = excluded.balance_cap_minor, buffer_pct = excluded.buffer_pct,
    status = excluded.status, priority = excluded.priority,
    weight = excluded.weight, updated_at = now();

  return btrim(p_id);
end $$;

revoke all on function gw_upsert_card_account(text,text,text,text,text,text,text,bigint,bigint,text,integer,numeric,bigint,bigint)
  from public, anon, authenticated;
grant execute on function gw_upsert_card_account(text,text,text,text,text,text,text,bigint,bigint,text,integer,numeric,bigint,bigint)
  to service_role;
revoke all on function gw_upsert_spei_account(text,text,text,text,text,text,text,text,bigint,numeric,text,integer,numeric)
  from public, anon, authenticated;
grant execute on function gw_upsert_spei_account(text,text,text,text,text,text,text,text,bigint,numeric,text,integer,numeric)
  to service_role;


-- ═══════════════ fim da parte 1 · início da parte 2 ═══════════════

-- ============================================================================
-- SPEI — validação de comprovante por IA
-- ----------------------------------------------------------------------------
-- POR QUE ISTO EXISTE. SPEI aqui não passa pela API da Clip: é transferência
-- direta para uma CLABE, feita pelo comprador no app do banco dele. Não há
-- webhook, não há endpoint de saldo, não há confirmação automática de espécie
-- alguma. A única evidência que chega até nós é o comprovante que o próprio
-- comprador anexa.
--
-- ⚠️⚠️ LEIA ISTO ANTES DE CONFIAR EM QUALQUER COISA AQUI.
--
-- UM MODELO DE IA NÃO VERIFICA QUE O DINHEIRO CHEGOU. Ele verifica que uma
-- IMAGEM é consistente com um pagamento ter sido feito. São coisas diferentes,
-- e a diferença é exatamente o espaço onde a fraude vive: comprovante editado,
-- comprovante de outra transferência, transferência estornada depois.
--
-- Este arquivo NÃO tenta resolver isso — não tem solução no nível da imagem.
-- O que ele faz é três coisas honestas:
--
--   1. Registra CADA decisão com o que foi extraído e qual regra passou ou
--      falhou. Aprovação sem rastro é indefensável quando alguém pergunta
--      "por que este pedido foi liberado?".
--   2. Impede que o MESMO comprovante aprove dois pedidos (hash + clave de
--      rastreo). É a fraude mais barata e a mais comum.
--   3. Marca a captura com origem `ai-receipt`, para que ela NUNCA se pareça
--      com uma captura conferida contra extrato. Ver gw_capacity.
--
-- O BACKSTOP REAL NÃO ESTÁ AQUI — está no saque. Comprovante aprovado cuja
-- transferência não existiu vira `occupied_minor` que o extrato não confirma,
-- e aparece como DERIVA NEGATIVA no próximo gw_spei_withdraw. É lá que a
-- fraude é descoberta, e é por isso que saldo_observado_minor é obrigatório.
--
-- Ver: supabase_gw_routing_migration.sql
-- ============================================================================


create table if not exists gw_spei_receipts (
  id              uuid        primary key default gen_random_uuid(),
  reservation_id  uuid        not null references gw_reservations(id) on delete cascade,
  account_id      text        not null,

  -- Arquivo enviado pelo comprador (bucket do Supabase Storage).
  file_url        text        not null,
  file_type       text,
  -- ⚠️ DEDUPE Nº1. O mesmo arquivo não pode aprovar dois pedidos. É a fraude
  -- mais barata que existe: pagar uma vez, mandar o print em três pedidos.
  file_sha256     text,

  -- ── O que o modelo LEU, sem saber o que esperávamos ──────────────────────
  -- Extração cega de propósito (ver spei-receipt.service.ts): informar o valor
  -- esperado ao modelo faz ele encontrar o valor esperado. O que vale é o que
  -- ele lê sozinho; a comparação é feita em código, aqui embaixo.
  extracted       jsonb       not null default '{}'::jsonb,

  -- ── Decisão ──────────────────────────────────────────────────────────────
  -- approved  → passou em TODAS as regras duras + confiança acima do piso
  -- review    → algo não bateu; precisa de olho humano (NÃO é rejeição)
  -- rejected  → não é comprovante, ou contradiz a reserva de forma dura
  verdict         text        not null check (verdict in ('approved', 'review', 'rejected')),
  confidence      numeric,
  -- Uma linha por regra: { amount_exact: true, clabe_matches: false, ... }.
  -- É isto que responde "por que foi aprovado?" seis meses depois.
  checks          jsonb       not null default '{}'::jsonb,
  reasons         text[],

  -- ── Procedência da decisão ───────────────────────────────────────────────
  -- 'ai' | 'human:<user_id>'. Uma aprovação humana que sobrepõe um `review` da
  -- IA precisa ser distinguível — é a linha que alguém vai ter que defender.
  decided_by      text        not null default 'ai',
  model           text,
  input_tokens    integer,
  output_tokens   integer,
  -- Custo REAL informado pelo provedor nesta chamada, quando ele informa.
  -- Preferido sobre calcular a partir de tokens: a tabela de preços é dele e
  -- muda sem avisar; o número que ele devolve, não. Null = derivar dos tokens.
  cost_usd        numeric,

  created_at      timestamptz not null default now(),
  decided_at      timestamptz not null default now()
);

create index if not exists idx_gw_spei_receipts_reservation
  on gw_spei_receipts (reservation_id, created_at desc);

-- Fila de revisão humana: o que a IA não teve confiança para liberar sozinha.
create index if not exists idx_gw_spei_receipts_review
  on gw_spei_receipts (created_at desc) where verdict = 'review';

-- ⚠️ DEDUPE NO ÍNDICE, NÃO NO `if` DO CÓDIGO.
-- Duas submissões simultâneas do mesmo arquivo passariam por qualquer
-- verificação feita em JS — as duas leem "não existe" antes de qualquer uma
-- gravar. A unicidade parcial mata a corrida no banco: só UMA aprovação por
-- arquivo, e a segunda recebe erro de conflito em vez de liberar o pedido.
create unique index if not exists uq_gw_spei_receipts_sha_approved
  on gw_spei_receipts (file_sha256)
  where verdict = 'approved' and file_sha256 is not null;

-- ⚠️ A CLAVE DE RASTREO NÃO É ÍNDICE ÚNICO, E ISSO FOI UMA CORREÇÃO.
--
-- A primeira versão criava unique index sobre extracted->>'clave_rastreo',
-- com o raciocínio de que ela é o identificador único da transferência no SPEI.
-- O raciocínio sobre o SPEI está certo; sobre NÓS, não: quem preenche esse
-- campo é um modelo lendo 24 dígitos seguidos de uma captura de tela, e em
-- duas chamadas contra a MESMA imagem ele devolveu valores diferentes (um '0'
-- a mais). Leitura instável em constraint duro tem dois efeitos:
--
--   • dedupe fraco — duas leituras do mesmo comprovante não colidem. Chato.
--   • DOIS COMPROVANTES DIFERENTES colidindo por erro de leitura, e um
--     pagamento legítimo recusado como duplicado. Inaceitável.
--
-- O dedupe fica com file_sha256, que é DETERMINÍSTICO: sai dos bytes, não de
-- uma leitura. É mais fraco contra recorte/refotografia — e é o preço honesto
-- de não recusar venda boa por erro de OCR.
--
-- A clave continua sendo extraída e gravada: serve para o revisor humano e é
-- entrada obrigatória de uma verificação CEP no Banxico, se um dia ligar.
-- Só não decide e não restringe nada.
drop index if exists uq_gw_spei_receipts_clave_approved;
create index if not exists idx_gw_spei_receipts_clave
  on gw_spei_receipts ((extracted->>'clave_rastreo'))
  where (extracted->>'clave_rastreo') is not null;


-- ── Confirmação: aprova o comprovante E captura a reserva, atomicamente ─────
--
-- Uma função só porque as duas coisas NÃO podem divergir. Gravar a aprovação e
-- falhar a captura deixa o pedido "aprovado" e o dinheiro fora do contador;
-- capturar e falhar o registro deixa uma captura sem justificativa. Numa
-- transação, ou as duas acontecem ou nenhuma.
--
-- O INSERT vem PRIMEIRO de propósito: é ele que carrega os índices de dedupe.
-- Se o comprovante já aprovou outro pedido, o conflito estoura aqui, ANTES de
-- a captura tocar o contador.
create or replace function gw_spei_confirm_receipt(
  p_reservation_id uuid,
  p_file_url       text,
  p_file_sha256    text,
  p_file_type      text,
  p_extracted      jsonb,
  p_confidence     numeric,
  p_checks         jsonb,
  p_reasons        text[],
  p_model          text,
  p_input_tokens   integer default null,
  p_output_tokens  integer default null,
  p_cost_usd       numeric default null,
  p_decided_by     text    default 'ai'
)
returns table (receipt_id uuid, captured boolean)
language plpgsql security definer as $$
declare
  r        record;
  v_id     uuid;
  v_capped boolean;
begin
  select * into r from gw_reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'gw_spei_confirm_receipt: reserva % inexistente', p_reservation_id;
  end if;
  if r.method <> 'spei' then
    raise exception 'gw_spei_confirm_receipt: reserva % não é SPEI', p_reservation_id;
  end if;

  insert into gw_spei_receipts (
    reservation_id, account_id, file_url, file_type, file_sha256,
    extracted, verdict, confidence, checks, reasons,
    decided_by, model, input_tokens, output_tokens, cost_usd)
  values (
    p_reservation_id, r.account_id, p_file_url, p_file_type, p_file_sha256,
    coalesce(p_extracted, '{}'::jsonb), 'approved', p_confidence,
    coalesce(p_checks, '{}'::jsonb), p_reasons,
    coalesce(p_decided_by, 'ai'), p_model, p_input_tokens, p_output_tokens, p_cost_usd)
  returning id into v_id;

  -- Reserva já capturada (reenvio do mesmo comprovante, ou dois cliques):
  -- registra o comprovante mas não conta o dinheiro duas vezes.
  if r.state = 'captured' then
    return query select v_id, false;
    return;
  end if;

  -- ⚠️ `source` = 'ai-receipt'. NÃO mude para 'manual' nem para 'webhook':
  -- este campo é o que permite, depois, separar quanto do saldo declarado veio
  -- de leitura de imagem e quanto veio de confirmação de verdade.
  v_capped := gw_capture(
    p_reservation_id := p_reservation_id,
    p_amount_minor   := r.charge_minor,
    p_kind           := 'base',
    p_source         := 'ai-receipt');

  return query select v_id, v_capped;
end $$;


-- Registro de um veredito que NÃO aprova (review/rejected). Separado da função
-- acima porque não toca contador nenhum — e porque misturar as duas faria a
-- rejeição herdar o `for update` e os índices de dedupe da aprovação, o que
-- bloquearia o comprador de reenviar um arquivo melhor do mesmo pagamento.
create or replace function gw_spei_log_receipt(
  p_reservation_id uuid,
  p_file_url       text,
  p_file_sha256    text,
  p_file_type      text,
  p_extracted      jsonb,
  p_verdict        text,
  p_confidence     numeric,
  p_checks         jsonb,
  p_reasons        text[],
  p_model          text,
  p_input_tokens   integer default null,
  p_output_tokens  integer default null,
  p_cost_usd       numeric default null
)
returns uuid
language plpgsql security definer as $$
declare v_account text; v_id uuid;
begin
  select account_id into v_account from gw_reservations where id = p_reservation_id;
  if v_account is null then
    raise exception 'gw_spei_log_receipt: reserva % inexistente', p_reservation_id;
  end if;

  insert into gw_spei_receipts (
    reservation_id, account_id, file_url, file_type, file_sha256,
    extracted, verdict, confidence, checks, reasons, model,
    input_tokens, output_tokens, cost_usd)
  values (
    p_reservation_id, v_account, p_file_url, p_file_type, p_file_sha256,
    coalesce(p_extracted, '{}'::jsonb), p_verdict, p_confidence,
    coalesce(p_checks, '{}'::jsonb), p_reasons, p_model,
    p_input_tokens, p_output_tokens, p_cost_usd)
  returning id into v_id;

  return v_id;
end $$;


-- ── Quanto do saldo declarado é só leitura de imagem ────────────────────────
--
-- A pergunta que o dash precisa responder antes de alguém confiar no número do
-- SPEI: destes X pesos que o sistema acha que estão parados na conta, quanto
-- foi confirmado por um humano vendo o extrato, e quanto foi um modelo olhando
-- um print? Se os dois aparecerem somados num número só, ninguém pergunta.
-- Origens que valem como CONFIRMAÇÃO DE VERDADE: alguém conferiu o extrato, ou
-- um sistema que observa o DINHEIRO (não a imagem dele) confirmou.
--
-- ⚠️ Acrescente aqui SÓ o que de fato verifica que o dinheiro entrou. Qualquer
-- origem que decida olhando um comprovante fica de fora, por definição — não
-- importa quão boa seja a leitura.
create or replace function gw_source_verificada(p_source text)
returns boolean
language sql immutable as $$
  -- coalesce obrigatório: `null = any(...)` devolve NULL, não false, e uma
  -- captura sem origem sumiria das duas colunas em vez de aparecer como
  -- não verificada. Origem desconhecida NUNCA conta como confirmada.
  select coalesce(p_source = any (array['manual-conciliado', 'cep-verified', 'extrato']), false)
$$;

create or replace view gw_spei_confidence as
  select
    a.id                                   as account_id,
    a.label,
    a.occupied_minor,
    -- ⚠️ LISTA DE INCLUSÃO, NÃO DE EXCLUSÃO — E ISSO JÁ QUEBROU UMA VEZ.
    -- A primeira versão perguntava `source <> 'ai-receipt'` para dizer
    -- "confirmado". Bastou surgir uma segunda origem de IA ('spei-proof-ai')
    -- para que ela caísse silenciosamente na coluna de CONFIRMADO — dinheiro
    -- validado por leitura de imagem contado como conferido por humano, que é
    -- a confusão exata que esta view existe para impedir.
    --
    -- Com lista de inclusão, uma origem nova nasce como NÃO VERIFICADA. Errar
    -- para o lado de "não sei" é recuperável; errar para o lado de "confirmado"
    -- só aparece quando falta dinheiro no saque.
    coalesce(sum(c.amount_minor) filter (where not gw_source_verificada(c.source)), 0)::bigint
                                           as nao_verificado_minor,
    coalesce(sum(c.amount_minor) filter (where gw_source_verificada(c.source)), 0)::bigint
                                           as confirmado_minor,
    count(c.id) filter (where not gw_source_verificada(c.source))::bigint
                                           as nao_verificado_count
  from gw_spei_accounts a
  left join gw_captures c
    on c.account_id = a.id
   and c.method = 'spei'
   -- Só o que ainda não foi sacado: depois do saque, o saldo foi confrontado
   -- com o extrato e a dúvida sobre aquelas capturas deixou de existir.
   and c.created_at > coalesce(
        (select max(l.created_at) from gw_spei_ledger l where l.account_id = a.id),
        '-infinity'::timestamptz)
  group by a.id, a.label, a.occupied_minor;


-- ── Permissões — mesma regra do resto: nada pela API REST ───────────────────
alter table gw_spei_receipts add column if not exists cost_usd numeric;
alter table gw_spei_receipts enable row level security;
revoke all on gw_spei_receipts from anon, authenticated;
revoke all on gw_spei_confidence from anon, authenticated;

do $perm$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     -- 'gw\_%' e não só '%receipt%': gw_source_verificada não casaria com o
     -- padrão estreito e nasceria executável por anon. Reaplicar em funções
     -- já revogadas é no-op, então abrir o padrão não custa nada.
     where n.nspname = 'public' and p.proname like 'gw\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$perm$;


-- ── Custo real por validação ────────────────────────────────────────────────
--
-- gw_spei_receipts já grava input_tokens/output_tokens de cada chamada, então
-- o custo é MEDÍVEL — não precisa de estimativa. Isto existe porque a conta do
-- provedor chega no fim do mês somada com todo o resto, e "quanto me custa
-- validar um comprovante" é uma pergunta que ninguém consegue responder olhando
-- a fatura.
--
-- ⚠️ Preços em USD por 1M de tokens, conferidos em 2026-08. Preço muda; se a
-- fatura divergir do que esta função diz, é aqui que se corrige.
create or replace function gw_ai_cost_usd(
  p_model text, p_input integer, p_output integer
)
returns numeric
language sql immutable as $$
  select round(
    (coalesce(p_input, 0)::numeric / 1000000) * case
      when p_model like 'claude-opus-%'   then 5.00
      when p_model like 'claude-fable-%'  then 10.00
      when p_model like 'claude-sonnet-%' then 3.00
      when p_model like 'claude-haiku-%'  then 1.00
      else 5.00   -- desconhecido: assume o mais caro da família Opus, para
                  -- que um modelo novo não subestime o custo em silêncio
    end
    +
    (coalesce(p_output, 0)::numeric / 1000000) * case
      when p_model like 'claude-opus-%'   then 25.00
      when p_model like 'claude-fable-%'  then 50.00
      when p_model like 'claude-sonnet-%' then 15.00
      when p_model like 'claude-haiku-%'  then 5.00
      else 25.00
    end
  , 6)
$$;

-- Uma linha por dia por modelo. `custo_por_validacao` é o número que importa:
-- comparado ao ticket médio, ele diz se a validação automática se paga.
create or replace view gw_spei_receipt_cost as
  select
    date_trunc('day', created_at)::date          as dia,
    model,
    verdict,
    count(*)                                     as validacoes,
    sum(input_tokens)                            as input_tokens,
    sum(output_tokens)                           as output_tokens,
    round(avg(input_tokens))                     as input_medio,
    round(avg(output_tokens))                    as output_medio,
    -- Custo informado pelo provedor quando existe; senão, derivado dos tokens.
    sum(coalesce(cost_usd, gw_ai_cost_usd(model, input_tokens, output_tokens)))  as custo_usd,
    round(avg(coalesce(cost_usd, gw_ai_cost_usd(model, input_tokens, output_tokens))), 5)
                                                 as custo_por_validacao_usd,
    count(*) filter (where cost_usd is not null)  as com_custo_informado
  from gw_spei_receipts
  where model is not null
  group by 1, 2, 3
  order by 1 desc, 2, 3;

revoke all on gw_spei_receipt_cost from anon, authenticated;
revoke all on function gw_ai_cost_usd(text, integer, integer) from public, anon, authenticated;
grant execute on function gw_ai_cost_usd(text, integer, integer) to service_role;
