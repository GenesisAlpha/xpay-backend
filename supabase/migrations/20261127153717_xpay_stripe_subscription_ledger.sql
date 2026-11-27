CREATE TABLE xpay_live.xpay_stripe_subscription_invoices (
  invoice_id text PRIMARY KEY CHECK (invoice_id ~ '^in_[a-zA-Z0-9]+$'),
  subscription_id text NOT NULL CHECK (subscription_id ~ '^sub_[a-zA-Z0-9]+$'),
  payment_intent_id text NOT NULL CHECK (payment_intent_id ~ '^pi_[a-zA-Z0-9]+$'),
  charge_id text NOT NULL CHECK (charge_id ~ '^ch_[a-zA-Z0-9]+$'),
  provider_account_id text NOT NULL REFERENCES xpay_live.stripe_accounts(id),
  price_id text NOT NULL,
  seller_id text NOT NULL,
  offer_id text NOT NULL,
  currency text NOT NULL CHECK (currency = 'EUR'),
  gross_minor bigint NOT NULL CHECK (gross_minor > 0),
  fee_pct numeric(7,3) NOT NULL CHECK (fee_pct >= 0 AND fee_pct <= 100),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0 AND fee_minor <= gross_minor),
  net_minor bigint GENERATED ALWAYS AS (gross_minor - fee_minor) STORED,
  paid_at timestamptz NOT NULL,
  disputed_at timestamptz,
  stripe_balance jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (seller_id, offer_id) REFERENCES xpay_live.offers(seller_id, id),
  UNIQUE (provider_account_id, payment_intent_id),
  UNIQUE (provider_account_id, charge_id)
);

CREATE TABLE xpay_live.xpay_stripe_subscription_refunds (
  refund_id text PRIMARY KEY CHECK (refund_id ~ '^re_[a-zA-Z0-9]+$'),
  invoice_id text NOT NULL REFERENCES xpay_live.xpay_stripe_subscription_invoices(invoice_id),
  gross_minor bigint NOT NULL CHECK (gross_minor > 0),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON xpay_live.xpay_stripe_subscription_refunds (invoice_id);

ALTER TABLE xpay_live.xpay_stripe_subscription_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE xpay_live.xpay_stripe_subscription_refunds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON xpay_live.xpay_stripe_subscription_invoices, xpay_live.xpay_stripe_subscription_refunds
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON xpay_live.xpay_stripe_subscription_invoices TO service_role;
GRANT SELECT, INSERT ON xpay_live.xpay_stripe_subscription_refunds TO service_role;

CREATE VIEW xpay_live.xpay_stripe_subscription_balances WITH (security_invoker = true) AS
SELECT sale.invoice_id, sale.seller_id, sale.currency, sale.gross_minor, sale.fee_minor,
       sale.net_minor AS original_net_minor, sale.paid_at, sale.stripe_balance,
       coalesce(refunds.gross_minor, 0) AS refunded_gross_minor,
       CASE
         WHEN sale.disputed_at IS NOT NULL THEN 'dispute_review'
         WHEN refunds.gross_minor IS NOT NULL THEN 'refund_review'
         ELSE 'settlement_pending'
       END AS settlement_status
FROM xpay_live.xpay_stripe_subscription_invoices sale
LEFT JOIN LATERAL (
  SELECT sum(refund.gross_minor)::bigint AS gross_minor
  FROM xpay_live.xpay_stripe_subscription_refunds refund WHERE refund.invoice_id = sale.invoice_id
) refunds ON true;
REVOKE ALL ON xpay_live.xpay_stripe_subscription_balances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON xpay_live.xpay_stripe_subscription_balances TO service_role;

CREATE FUNCTION xpay_live.xpay_sync_stripe_subscription(p_payment jsonb, p_refunds jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, xpay_live
AS $$
DECLARE
  sale xpay_live.xpay_stripe_subscription_invoices%ROWTYPE;
  offer xpay_live.offers%ROWTYPE;
  fees xpay_live.seller_fees%ROWTYPE;
  destination xpay_live.xpay_orbia_merchants%ROWTYPE;
  refund record;
  invoice_ref text := p_payment->>'invoice_id';
  account_ref text := p_payment->>'provider_account_id';
  tx_ref text := 'stripe-invoice:' || invoice_ref;
  amount bigint := (p_payment->>'gross_minor')::bigint;
  paid timestamptz := (p_payment->>'paid_at')::timestamptz;
  balance_info jsonb := nullif(p_payment->'stripe_balance', 'null'::jsonb);
  dispute boolean := coalesce((p_payment->>'disputed')::boolean, false);
  total_refunded bigint;
  pct numeric;
  added boolean;
  refund_added boolean;
BEGIN
  IF jsonb_typeof(p_payment) IS DISTINCT FROM 'object' OR
     jsonb_typeof(p_refunds) IS DISTINCT FROM 'array' OR jsonb_array_length(p_refunds) > 100 OR
     p_payment->>'offer_id' IS DISTINCT FROM 'xpay_atlasclub_mvp' OR
     coalesce(invoice_ref, '') !~ '^in_[a-zA-Z0-9]+$' OR
     p_payment->>'currency' IS DISTINCT FROM 'EUR' OR amount IS NULL OR paid IS NULL THEN
    RAISE EXCEPTION 'Invalid Stripe subscription payment' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(invoice_ref, 439637));
  SELECT * INTO sale FROM xpay_live.xpay_stripe_subscription_invoices WHERE invoice_id=invoice_ref FOR UPDATE;
  added := NOT FOUND;
  IF added THEN
    SELECT * INTO STRICT offer FROM xpay_live.offers WHERE id=p_payment->>'offer_id';
    IF offer.currency IS DISTINCT FROM 'EUR' OR offer.amount_minor IS DISTINCT FROM amount OR
       offer.metadata->>'billing_mode' IS DISTINCT FROM 'subscription' OR
       offer.metadata->>'stripe_price_id' IS DISTINCT FROM p_payment->>'price_id' OR
       offer.metadata->>'stripe_provider_account_id' IS DISTINCT FROM account_ref OR
       NOT EXISTS (SELECT 1 FROM xpay_live.stripe_accounts a WHERE a.id=account_ref AND a.livemode=true
                   AND a.stripe_account_id=p_payment->>'stripe_account_id') THEN
      RAISE EXCEPTION 'Stripe payment does not match its offer' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO STRICT fees FROM xpay_live.seller_fees WHERE seller_id=offer.seller_id;
    SELECT * INTO STRICT destination FROM xpay_live.xpay_orbia_merchants WHERE seller_id=offer.seller_id;
    IF destination.orbia_installation IS DISTINCT FROM 'orbia.live' THEN
      RAISE EXCEPTION 'Invalid subscription sales destination' USING ERRCODE = '23514';
    END IF;
    pct := fees.checkout_fee_pct + fees.processing_fee_pct + fees.orchestration_fee_pct;
    IF pct IS NULL OR pct IS DISTINCT FROM fees.fee_percentage OR
       fees.reserve_percentage IS DISTINCT FROM 0 OR fees.fee_fixed_usd IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Unsupported terms for the EUR subscription pilot' USING ERRCODE = '23514';
    END IF;
    INSERT INTO xpay_live.xpay_stripe_subscription_invoices (
      invoice_id, subscription_id, payment_intent_id, charge_id, provider_account_id,
      price_id, seller_id, offer_id, currency, gross_minor, fee_pct, fee_minor, paid_at,
      disputed_at, stripe_balance
    ) VALUES (
      invoice_ref, p_payment->>'subscription_id', p_payment->>'payment_intent_id', p_payment->>'charge_id',
      account_ref, p_payment->>'price_id', offer.seller_id, offer.id, 'EUR', amount, pct,
      round(amount * pct / 100), paid, CASE WHEN dispute THEN now() END, balance_info
    ) RETURNING * INTO sale;

    INSERT INTO xpay_live.xpay_event_outbox(seller_id,event_key,event_type,body,created_at)
    VALUES (
      sale.seller_id,'payment.approved:' || tx_ref,'payment.approved',
      jsonb_build_object(
        'transactionId',tx_ref,'billingSource','stripe_subscription','externalReference',null,
        'organizationId',destination.orbia_org_id,'installation',destination.orbia_installation,
        'gross',jsonb_build_object('minor',sale.gross_minor,'currency','EUR'),
        'fee',jsonb_build_object('minor',sale.fee_minor,'currency','EUR'),
        'net',jsonb_build_object('minor',sale.net_minor,'currency','EUR'),
        'fxFee',jsonb_build_object('minor',0,'currency','EUR')
      ), sale.paid_at
    );
  ELSE
    IF sale.gross_minor IS DISTINCT FROM amount OR sale.paid_at IS DISTINCT FROM paid OR
       sale.provider_account_id IS DISTINCT FROM account_ref OR sale.offer_id IS DISTINCT FROM p_payment->>'offer_id' OR
       sale.price_id IS DISTINCT FROM p_payment->>'price_id' OR sale.payment_intent_id IS DISTINCT FROM p_payment->>'payment_intent_id' OR
       sale.charge_id IS DISTINCT FROM p_payment->>'charge_id' OR sale.subscription_id IS DISTINCT FROM p_payment->>'subscription_id' THEN
      RAISE EXCEPTION 'Stripe invoice conflicts with the booked sale' USING ERRCODE = '23505';
    END IF;
    IF balance_info IS NOT NULL OR dispute THEN
      UPDATE xpay_live.xpay_stripe_subscription_invoices
      SET stripe_balance=coalesce(balance_info,stripe_balance),
          disputed_at=coalesce(disputed_at,CASE WHEN dispute THEN now() END)
      WHERE invoice_id=invoice_ref;
    END IF;
  END IF;

  FOR refund IN SELECT * FROM jsonb_to_recordset(p_refunds) AS r(refund_id text,gross_minor bigint) LOOP
    INSERT INTO xpay_live.xpay_stripe_subscription_refunds(refund_id,invoice_id,gross_minor)
    VALUES(refund.refund_id,invoice_ref,refund.gross_minor) ON CONFLICT (refund_id) DO NOTHING;
    refund_added := FOUND;
    IF NOT refund_added AND NOT EXISTS (
      SELECT 1 FROM xpay_live.xpay_stripe_subscription_refunds r
      WHERE r.refund_id=refund.refund_id AND r.invoice_id=invoice_ref AND r.gross_minor=refund.gross_minor
    ) THEN
      RAISE EXCEPTION 'Stripe refund conflicts with the booked refund' USING ERRCODE = '23505';
    END IF;
    IF refund_added THEN
      INSERT INTO xpay_live.xpay_event_outbox(seller_id,event_key,event_type,body)
      SELECT sale.seller_id,'payment.refunded:' || tx_ref || ':' || refund.refund_id,'payment.refunded',
        jsonb_build_object(
          'transactionId',tx_ref,'billingSource','stripe_subscription','refundId',refund.refund_id,
          'organizationId',m.orbia_org_id,'installation',m.orbia_installation,
          'gross',jsonb_build_object('minor',refund.gross_minor,'currency','EUR')
        )
      FROM xpay_live.xpay_orbia_merchants m WHERE m.seller_id=sale.seller_id;
    END IF;
  END LOOP;
  SELECT coalesce(sum(r.gross_minor),0) INTO total_refunded
  FROM xpay_live.xpay_stripe_subscription_refunds r WHERE r.invoice_id=invoice_ref;
  IF total_refunded > amount THEN
    RAISE EXCEPTION 'Stripe refunds exceed the invoice payment' USING ERRCODE = '23514';
  END IF;
  RETURN tx_ref;
END;
$$;
REVOKE ALL ON FUNCTION xpay_live.xpay_sync_stripe_subscription(jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION xpay_live.xpay_sync_stripe_subscription(jsonb,jsonb) TO service_role;
