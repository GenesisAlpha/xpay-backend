-- ============================================================================
-- DIAGNÓSTICO — "Pagamento por SPEI indisponível no momento"
-- ----------------------------------------------------------------------------
-- Essa mensagem significa UMA coisa: gw_hold_spei devolveu zero linhas, ou seja
-- nenhuma conta passou por TODOS os filtros. São seis filtros; esta query mostra
-- qual falhou, comparando o seller real com cada conta.
--
-- Rode inteiro. Ele se ancora na ÚLTIMA transação SPEI que falhou.
-- ============================================================================

-- ── 1. Existe a função de compatibilidade de risco? ─────────────────────────
-- Se vier `f`, a migration é anterior ao fallback WHITE→GRAY e gw_hold_spei
-- estoura em vez de devolver zero linhas. Rode a migration completa de novo.
select to_regprocedure('public.gw_risco_compativel(text,text)') is not null
       as gw_risco_compativel_existe;


-- ── 2. O confronto: seller × cada conta, filtro a filtro ────────────────────
with tx as (
  select id, seller_id, amount, currency, created_at
    from transactions
   where failure_code = 'SPEI_CAPACITY_EXHAUSTED'
   order by created_at desc
   limit 1
),
sel as (
  select sp.id, upper(coalesce(sp.country, 'MX')) as country,
         upper(coalesce(sp.risk_level, '')) as risk_level,
         sp.enabled_methods, sp.provider_default, sp.status
    from seller_profiles sp
    join tx on tx.seller_id = sp.id
)
select
  tx.id                                   as transacao,
  tx.amount                               as valor_centavos,
  sel.id                                  as seller,
  sel.country                             as seller_pais,
  sel.risk_level                          as seller_risco,
  a.id                                    as conta,
  -- ── os seis filtros ──
  a.status = 'active'                                          as ok_ativa,
  upper(a.currency) = upper(tx.currency)                       as ok_moeda,
  upper(a.country)  = sel.country                              as ok_pais,
  (upper(a.risk_level) = sel.risk_level
   or (sel.risk_level = 'WHITE' and upper(a.risk_level) = 'GRAY')) as ok_risco,
  a.occupied_minor + tx.amount
    <= floor(a.balance_cap_minor * (1 - a.buffer_pct))          as ok_capacidade,
  -- valores crus, para ler o que divergiu
  a.currency    as conta_moeda,
  a.country     as conta_pais,
  a.risk_level  as conta_risco,
  a.occupied_minor,
  floor(a.balance_cap_minor * (1 - a.buffer_pct))::bigint       as teto_com_colchao
from gw_spei_accounts a, tx, sel
order by a.id;


-- ── 3. O seller tem SPEI habilitado e está em Clip? ─────────────────────────
-- Se `spei` não estiver em enabled_methods a mensagem seria outra, mas confere.
select sp.id, sp.status, sp.provider_default, sp.risk_level, sp.country, sp.enabled_methods
  from seller_profiles sp
  join (select seller_id from transactions
         where failure_code = 'SPEI_CAPACITY_EXHAUSTED'
         order by created_at desc limit 1) t on t.seller_id = sp.id;


-- ── 4. Os centavos únicos acabaram? ─────────────────────────────────────────
-- gw_hold_spei PULA a conta quando os 99 centavos daquele valor em pesos já
-- foram usados nos últimos 30 dias. Raro, mas é um dos seis motivos e não
-- aparece em nenhum dos filtros acima.
select r.account_id, (r.charge_minor / 100) as valor_pesos, count(*) as centavos_usados
  from gw_reservations r
 where r.method = 'spei'
   and r.created_at > now() - interval '30 days'
 group by 1, 2
having count(*) > 90
 order by 3 desc;
