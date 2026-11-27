BEGIN;
DO $$
DECLARE
  pilot xpay_live.offers%ROWTYPE;
  account text;
  payment jsonb;
  status_row xpay_live.xpay_stripe_subscription_balances%ROWTYPE;
  msg jsonb;
  ref text := 'in_XPAYRecurringRegression';
BEGIN
  SELECT * INTO STRICT pilot FROM xpay_live.offers WHERE id='xpay_atlasclub_mvp';
  SELECT stripe_account_id INTO STRICT account FROM xpay_live.stripe_accounts
    WHERE id=pilot.metadata->>'stripe_provider_account_id';
  payment := jsonb_build_object(
    'invoice_id',ref,'subscription_id','sub_XPAYRecurringRegression','payment_intent_id','pi_XPAYRecurringRegression',
    'charge_id','ch_XPAYRecurringRegression','price_id',pilot.metadata->>'stripe_price_id','offer_id',pilot.id,
    'provider_account_id',pilot.metadata->>'stripe_provider_account_id','stripe_account_id',account,
    'gross_minor',990,'currency','EUR','paid_at','2026-11-27T12:00:00Z'
  );

  IF has_function_privilege('authenticated','xpay_live.xpay_sync_stripe_subscription(jsonb,jsonb)','EXECUTE')
    OR has_table_privilege('anon','xpay_live.xpay_stripe_subscription_invoices','SELECT') THEN
    RAISE EXCEPTION 'Stripe finance records must require the service role';
  END IF;

  PERFORM xpay_live.xpay_sync_stripe_subscription(payment,'[]');
  PERFORM xpay_live.xpay_sync_stripe_subscription(payment,'[]');
  SELECT * INTO STRICT status_row FROM xpay_live.xpay_stripe_subscription_balances WHERE invoice_id=ref;
  SELECT body INTO STRICT msg FROM xpay_live.xpay_event_outbox WHERE event_key='payment.approved:stripe-invoice:'||ref;
  IF status_row.fee_minor<>148 OR status_row.original_net_minor<>842 OR
     status_row.settlement_status<>'settlement_pending' OR msg#>>'{net,currency}'<>'EUR' OR
     msg->>'billingSource'<>'stripe_subscription' THEN
    RAISE EXCEPTION 'Stripe EUR booking or duplicate outbox event is wrong';
  END IF;

  PERFORM xpay_live.xpay_sync_stripe_subscription(payment,'[{"refund_id":"re_XPAYRecurringPart","gross_minor":195}]');
  PERFORM xpay_live.xpay_sync_stripe_subscription(payment,'[{"refund_id":"re_XPAYRecurringPart","gross_minor":195}]');
  IF (SELECT refunded_gross_minor FROM xpay_live.xpay_stripe_subscription_balances WHERE invoice_id=ref)<>195 THEN
    RAISE EXCEPTION 'Partial refund has been lost or counted twice';
  END IF;

  BEGIN
    PERFORM xpay_live.xpay_sync_stripe_subscription(payment,'[{"refund_id":"re_XPAYRecurringExcess","gross_minor":796}]');
    RAISE EXCEPTION 'Over-refund was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    PERFORM xpay_live.xpay_sync_stripe_subscription(payment||'{"provider_account_id":"other"}','[]');
    RAISE EXCEPTION 'An invoice from another Stripe account was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  PERFORM xpay_live.xpay_sync_stripe_subscription(payment,
    '[{"refund_id":"re_XPAYRecurringPart","gross_minor":195},{"refund_id":"re_XPAYRecurringRest","gross_minor":795}]');
  SELECT * INTO STRICT status_row FROM xpay_live.xpay_stripe_subscription_balances WHERE invoice_id=ref;
  IF status_row.refunded_gross_minor<>990 OR status_row.settlement_status<>'refund_review' THEN
    RAISE EXCEPTION 'Full refund was not held for reconciliation';
  END IF;
  PERFORM xpay_live.xpay_sync_stripe_subscription(payment||'{"disputed":true}','[]');
  PERFORM xpay_live.xpay_sync_stripe_subscription(payment,'[]');
  IF (SELECT settlement_status FROM xpay_live.xpay_stripe_subscription_balances WHERE invoice_id=ref)<>'dispute_review' THEN
    RAISE EXCEPTION 'Dispute was cleared by a retry of the invoice';
  END IF;
END;
$$;
ROLLBACK;
