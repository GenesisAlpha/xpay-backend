-- Run on a disposable database with the settlement migrations applied.
BEGIN;

-- A deterministic window keeps the accounting checks independent of the day
-- the test runs and of the current year's holiday coverage.
CREATE OR REPLACE FUNCTION xpay_live.xpay_atlasclub_settlement_window(p_paid_at timestamptz)
RETURNS TABLE(availability_date date, dispatch_window_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, xpay_live
AS $$ SELECT (p_paid_at AT TIME ZONE 'Europe/Lisbon')::date+3, p_paid_at+interval '4 days' $$;

INSERT INTO xpay_live.seller_profiles(id,name,status) VALUES
  ('xpay_atlashub_mvp','Atlas pilot test','inactive'),
  ('xpay_manual_other_seller','Other merchant','inactive')
ON CONFLICT (id) DO NOTHING;
INSERT INTO xpay_live.stripe_accounts(id,label,livemode,status)
  VALUES ('xpay_manual_test_provider','Settlement test',false,'inactive');
INSERT INTO xpay_live.offers(id,seller_id,name,currency,amount_minor,status) VALUES
  ('xpay_manual_offer','xpay_atlashub_mvp','Manual settlement test','EUR',990,'inactive'),
  ('xpay_manual_other_offer','xpay_manual_other_seller','Other merchant offer','EUR',990,'inactive');
INSERT INTO xpay_live.xpay_stripe_subscription_invoices(
  invoice_id,subscription_id,payment_intent_id,charge_id,provider_account_id,price_id,seller_id,offer_id,
  currency,gross_minor,fee_pct,fee_minor,paid_at
)
SELECT 'in_Manual'||suffix,'sub_Manual'||suffix,'pi_Manual'||suffix,'ch_Manual'||suffix,
       'xpay_manual_test_provider','price_TEST',seller,offer,'EUR',990,14.9,148,now()-age
FROM (VALUES
  ('A','xpay_atlashub_mvp','xpay_manual_offer',interval '8 days'),
  ('B','xpay_atlashub_mvp','xpay_manual_offer',interval '8 days'),
  ('C','xpay_atlashub_mvp','xpay_manual_offer',interval '1 day'),
  ('D','xpay_manual_other_seller','xpay_manual_other_offer',interval '8 days'),
  ('E','xpay_atlashub_mvp','xpay_manual_offer',interval '8 days')
) AS cases(suffix,seller,offer,age);
INSERT INTO xpay_live.xpay_stripe_subscription_refunds(refund_id,invoice_id,gross_minor)
VALUES ('re_ManualE','in_ManualE',100);

SET LOCAL ROLE service_role;
DO $$
DECLARE
  request uuid := '20000000-0000-4000-8000-000000000001';
  second uuid := '20000000-0000-4000-8000-000000000002';
  actor uuid := '20000000-0000-4000-8000-000000000003';
  reverser uuid := '20000000-0000-4000-8000-000000000004';
  paid date := (now() AT TIME ZONE 'Europe/Lisbon')::date;
  invoice text;
BEGIN
  IF has_function_privilege('authenticated','xpay_live.xpay_book_manual_settlement(uuid,uuid,text[],bigint,date,text)','execute')
     OR has_table_privilege(current_user,'xpay_live.xpay_manual_settlements','insert') THEN
    RAISE EXCEPTION 'Accounting writes must use the authorized RPC';
  END IF;

  FOREACH invoice IN ARRAY ARRAY['in_ManualC','in_ManualD','in_ManualE'] LOOP
    BEGIN
      PERFORM xpay_live.xpay_book_manual_settlement(request,actor,ARRAY[invoice],842,paid,'ready-test');
      RAISE EXCEPTION 'An ineligible invoice was booked';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    PERFORM xpay_live.xpay_book_manual_settlement(request,actor,ARRAY['in_ManualA','in_ManualB'],842,paid,'ready-test');
    RAISE EXCEPTION 'Wrong transferred total was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  IF xpay_live.xpay_book_manual_settlement(request,actor,ARRAY['in_ManualA','in_ManualB'],1684,paid,'READY-TEST')<>request
     OR xpay_live.xpay_book_manual_settlement(request,actor,ARRAY['in_ManualB','in_ManualA'],1684,paid,'READY-TEST')<>request THEN
    RAISE EXCEPTION 'Batch idempotency failed';
  END IF;
  IF (SELECT count(*) FROM xpay_live.xpay_manual_settlement_queue WHERE invoice_id IN ('in_ManualA','in_ManualB') AND status='paid')<>2
     OR NOT EXISTS (SELECT 1 FROM xpay_live.xpay_manual_settlement_history WHERE id=request AND recorded_by=actor AND amount_minor=1684) THEN
    RAISE EXCEPTION 'Batch or operator was not recorded';
  END IF;
  BEGIN
    PERFORM xpay_live.xpay_book_manual_settlement(second,actor,ARRAY['in_ManualA'],842,paid,'other-reference');
    RAISE EXCEPTION 'Invoice was booked twice';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  PERFORM xpay_live.xpay_reverse_manual_settlement(request,reverser,'Incorrect batch selection');
  PERFORM xpay_live.xpay_reverse_manual_settlement(request,reverser,'Incorrect batch selection');
  IF NOT EXISTS (SELECT 1 FROM xpay_live.xpay_manual_settlement_history WHERE id=request
    AND reversed_by=reverser AND reversal_reason='Incorrect batch selection')
    OR (SELECT count(*) FROM xpay_live.xpay_manual_settlement_queue WHERE invoice_id IN ('in_ManualA','in_ManualB') AND status='ready')<>2 THEN
    RAISE EXCEPTION 'Reversal lost audit history or did not release the bookkeeping allocation';
  END IF;
  PERFORM xpay_live.xpay_book_manual_settlement(second,actor,ARRAY['in_ManualA','in_ManualB'],1684,paid,'ready-test');
END;
$$;
RESET ROLE;
INSERT INTO xpay_live.xpay_stripe_subscription_refunds(refund_id,invoice_id,gross_minor)
VALUES ('re_ManualA','in_ManualA',100);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM xpay_live.xpay_manual_settlement_queue
    WHERE invoice_id='in_ManualA' AND status='paid_with_adjustment') THEN
    RAISE EXCEPTION 'Late refund did not flag a booked transfer';
  END IF;
END;
$$;
ROLLBACK;
