-- Seller WHITE pode usar conta GRAY (Clip cartão e SPEI) — 2026-10-09.
--
-- O banco estava com a versão antiga de gw_risco_compativel: risco do seller
-- IGUAL ao da conta. Todas as contas Clip cadastradas são GRAY, então um seller
-- WHITE não achava conta nenhuma: gw_hold_card / gw_hold_spei devolviam zero
-- linhas, o pay respondia { available: false } e o checkout mostrava
-- "Pagamento com cartão indisponível no momento" — sem erro em lugar nenhum.
--
-- A regra certa (já descrita em ops/migration-completa.sql) é ASSIMÉTRICA:
--   seller GRAY  → só conta GRAY;
--   seller WHITE → conta WHITE e, na falta dela, GRAY.
-- Volume GRAY numa conta WHITE contamina o histórico limpo; o contrário só
-- dilui a proporção ruim da conta GRAY. Por isso o fallback vale num sentido só.
-- Os dois holds já ordenam "risco exato primeiro": havendo conta WHITE com
-- espaço, é ela que recebe.
--
-- Só troca o corpo de uma função (mesma assinatura): nada de dado é alterado.

create or replace function gw_risco_compativel(p_conta text, p_seller text)
returns boolean
language sql immutable as $$
  select upper(p_conta) = upper(p_seller)
      or (upper(p_seller) = 'WHITE' and upper(p_conta) = 'GRAY')
$$;
