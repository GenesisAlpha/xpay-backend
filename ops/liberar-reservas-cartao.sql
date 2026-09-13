-- ============================================================================
-- Liberar reservas de cartão presas (teto do dia esgotado sem vendas)
-- ----------------------------------------------------------------------------
-- Sintoma: "Pagamento com cartão indisponível" com a conta ativa e sem vendas
-- correspondentes. Cada abertura do checkout reserva (valor + folga de upsell)
-- e o espaço só volta no TTL.
-- ============================================================================

-- ── 1. O que está segurando o teto de hoje ──────────────────────────────────
select r.id, r.account_id, r.state, r.amount_minor, r.held_minor,
       r.created_at, r.expires_at, r.expires_at < now() as ja_venceu,
       r.external_reference
  from gw_reservations r
 where r.method = 'card' and r.held_minor > 0
   and r.usage_day = gw_mx_today()
 order by r.created_at desc;

-- ── 2. Quanto do teto é reserva vs. venda de verdade ────────────────────────
select u.account_id, u.day,
       u.reserved_minor  as em_reserva,
       u.captured_minor  as vendas_reais,
       a.daily_cap_minor,
       a.daily_cap_minor - u.reserved_minor - u.captured_minor as livre
  from gw_card_usage u
  join gw_card_accounts a on a.id = u.account_id
 where u.day = gw_mx_today();

-- ── 3. Devolve o que já venceu (seguro) ─────────────────────────────────────
select gw_expire_stale_reservations() as expiradas;

-- ── 4. Devolve TODAS as reservas de cartão de hoje que nunca viraram venda ──
-- ⚠️ Use enquanto está testando. Em produção com tráfego real, isto libera o
-- espaço de compradores que estão com o cartão na mão neste instante — eles
-- passariam a cobrar sem reserva, furando o teto.
-- Reserva capturada (state='captured') NÃO é tocada: aquilo é dinheiro.
-- do $$
-- declare r record;
-- begin
--   for r in select id from gw_reservations
--             where method = 'card' and state = 'held' and held_minor > 0
--   loop
--     perform gw_release(r.id, 'limpeza-teste');
--   end loop;
-- end $$;

-- ── 5. Conferência ──────────────────────────────────────────────────────────
select id, cap_minor, em_voo_minor, confirmado_minor, livre_minor
  from gw_capacity where method = 'card';
