-- ============================================================================
-- SPEI travado por reservas de teste que nunca foram liberadas
-- ----------------------------------------------------------------------------
-- Sintoma: "Pagamento por SPEI indisponível" com a conta ativa e o teto certo.
-- Causa: cada tentativa abandonada deixa a reserva em `held`, e o espaço só
-- volta quando ela expira (TTL 3h), é capturada, ou é liberada.
-- ============================================================================

-- ── 1. O que está segurando o espaço agora ──────────────────────────────────
select r.id, r.account_id, r.state,
       r.charge_minor,                          -- valor com os centavos únicos
       r.held_minor,                            -- o que ainda ocupa a conta
       r.created_at, r.expires_at,
       r.expires_at < now()          as ja_venceu,
       r.external_reference          as transacao
  from gw_reservations r
 where r.method = 'spei' and r.held_minor > 0
 order by r.created_at desc;

-- ── 2. Bate com o occupied da conta? ────────────────────────────────────────
-- `soma_held` deve ser <= occupied_minor. Se for IGUAL, todo o "saldo" da conta
-- é reserva em aberto — nenhum dinheiro real chegou ainda.
select a.id, a.occupied_minor,
       coalesce(sum(r.held_minor), 0)                       as soma_held,
       a.occupied_minor - coalesce(sum(r.held_minor), 0)    as dinheiro_confirmado,
       floor(a.balance_cap_minor * (1 - a.buffer_pct))::bigint - a.occupied_minor as livre
  from gw_spei_accounts a
  left join gw_reservations r
    on r.account_id = a.id and r.method = 'spei' and r.held_minor > 0
 group by a.id, a.occupied_minor, a.balance_cap_minor, a.buffer_pct;

-- ── 3. Liberar o que já venceu (seguro: só mexe em reserva expirada) ────────
select gw_expire_stale_reservations() as reservas_expiradas;

-- ── 4. Liberar uma reserva de teste ESPECÍFICA que ainda não venceu ─────────
-- ⚠️ Só use em reserva de TESTE. Liberar reserva de comprador real que está
-- prestes a transferir faz o dinheiro chegar sem espaço reservado — e ele
-- aparece como deriva positiva no próximo saque.
-- select gw_release('<reservation_id>', 'teste');

-- ── 5. Conferência ──────────────────────────────────────────────────────────
select id, method, cap_minor, em_voo_minor, confirmado_minor, livre_minor
  from gw_capacity where method = 'spei';
