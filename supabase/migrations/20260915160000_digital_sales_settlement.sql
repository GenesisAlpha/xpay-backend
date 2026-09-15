-- Venda digital libera no prazo de liberação sem exigir rastreio.
--
-- O checkout grava metadata.fulfillment = 'digital' quando todos os produtos do
-- pedido são digitais (renovações herdam a marca da compra original). Venda com
-- produto físico, ou sem a marca, continua exigindo o rastreio sincronizado.
-- Fora a condição do rastreio, a função é a mesma que estava no banco.

create or replace function public.run_settlement_batch(p_limit integer default 100)
 returns table(released_count integer, total_amount bigint)
 language plpgsql
as $function$
declare
  v_entry    record;
  v_released int    := 0;
  v_total    bigint := 0;
begin
  for v_entry in
    select wl.*
      from wallet_ledger wl
      join transactions t on t.id = wl.transaction_id
     where wl.type   = 'credit_pending'
       and wl.status = 'pending'
       and wl.available_at <= now()
       and (
         -- produto digital: não há envio
         t.metadata->>'fulfillment' = 'digital'
         -- produto físico: só libera se o pedido foi ENVIADO (tracking sincronizado)
         or (t.tracking is not null
             and t.tracking->>'status' = 'synced'
             and coalesce(t.tracking->>'number', '') <> '')
       )
     order by wl.available_at asc
     limit p_limit
     for update of wl skip locked     -- concorrência segura entre execuções
  loop
    -- 1) move pending → available
    update wallet_balance
       set pending_balance   = pending_balance   - v_entry.amount,
           available_balance = available_balance + v_entry.amount,
           updated_at = now()
     where seller_id = v_entry.seller_id;

    -- 2) ledger de release (idempotente via unique transaction_id+type)
    insert into wallet_ledger
      (seller_id, transaction_id, type, amount, currency, status, created_at)
    values
      (v_entry.seller_id, v_entry.transaction_id, 'release_to_available',
       v_entry.amount, v_entry.currency, 'completed', now())
    on conflict (transaction_id, type) do nothing;

    -- 3) marca a entrada original como concluída
    update wallet_ledger
       set status = 'completed', updated_at = now()
     where id = v_entry.id;

    v_released := v_released + 1;
    v_total    := v_total + v_entry.amount;
  end loop;

  released_count := v_released;
  total_amount   := v_total;
  return next;
end $function$;
