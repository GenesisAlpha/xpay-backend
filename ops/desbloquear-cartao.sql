-- ============================================================================
-- DESBLOQUEAR O CARTÃO — teto do dia tomado por reservas que não viraram venda
-- ----------------------------------------------------------------------------
-- Rode os quatro blocos em ordem. O 1 mostra, o 2 libera, o 3 corrige a causa,
-- o 4 confere.
-- ============================================================================

-- ── 1. Onde está o teto de hoje ─────────────────────────────────────────────
-- `em_reserva` alto com `vendas_reais` zerado = o teto está tomado por
-- checkouts abertos e abandonados, não por dinheiro.
select u.account_id,
       u.reserved_minor as em_reserva,
       u.captured_minor as vendas_reais,
       a.daily_cap_minor as teto,
       a.daily_cap_minor - u.reserved_minor - u.captured_minor as livre
  from gw_card_usage u
  join gw_card_accounts a on a.id = u.account_id
 where u.day = gw_mx_today();


-- ── 2. Devolver o espaço ────────────────────────────────────────────────────
-- Primeiro o que já venceu (sempre seguro):
select gw_expire_stale_reservations() as expiradas;

-- Depois as que ainda estão em pé e nunca viraram cobrança.
-- ⚠️ Em produção com tráfego real isto libera o espaço de quem está com o
-- cartão na mão AGORA — use enquanto está testando. Reserva `captured` não é
-- tocada: aquilo é dinheiro.
do $$
declare r record;
begin
  for r in select id from gw_reservations
            where method = 'card' and state = 'held' and held_minor > 0
  loop
    perform gw_release(r.id, 'limpeza-teste');
  end loop;
end $$;


-- ── 3. A CAUSA: folga de upsell que este seller não usa ─────────────────────
--
-- ⚠️ Cada abertura de checkout reservava o pedido MAIS 653,00 MXN de folga.
-- Essa folga existe porque no funil do tkt-page os upsells one-click
-- re-tokenizam o mesmo SDK e caem obrigatoriamente na conta da venda base.
--
-- O checkout Koopfy NÃO tem upsell pós-compra: os order bumps entram na MESMA
-- transação, já somados no valor. Então a folga aqui é 100% desperdício — e é
-- o que fazia um teste de 1 centavo travar 653 MXN do teto.
--
-- Com folga zero: 10 aberturas de checkout por dia em vez de 7, e teste de
-- valor baixo custa quase nada de teto.
--
-- ⚠️ NÃO zere se esta conta também servir o funil do tkt-page. Lá os upsells
-- são reais e sem a folga eles falham na borda, perdendo receita já ganha.
update gw_card_accounts
   set upsell_headroom_minor = 0, updated_at = now()
 where id = 'clip_mx_gray_01';


-- ── 4. Conferência ──────────────────────────────────────────────────────────
select id, cap_minor, em_voo_minor, confirmado_minor, livre_minor
  from gw_capacity where method = 'card';
