CREATE TABLE xpay_live.xpay_manual_settlements (
  id uuid PRIMARY KEY,
  seller_id text NOT NULL REFERENCES xpay_live.seller_profiles(id),
  currency text NOT NULL CHECK (currency = 'EUR'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  payment_date date NOT NULL,
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 120),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL,
  reversed_at timestamptz,
  reversed_by uuid,
  reversal_reason text,
  CHECK (
    (reversed_at IS NULL AND reversed_by IS NULL AND reversal_reason IS NULL)
    OR (reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_reason IS NOT NULL
        AND length(btrim(reversal_reason)) BETWEEN 4 AND 500)
  )
);
CREATE UNIQUE INDEX xpay_manual_settlements_active_reference
  ON xpay_live.xpay_manual_settlements(seller_id,currency,lower(btrim(reference))) WHERE reversed_at IS NULL;

CREATE TABLE xpay_live.xpay_manual_settlement_items (
  settlement_id uuid NOT NULL REFERENCES xpay_live.xpay_manual_settlements(id),
  invoice_id text NOT NULL REFERENCES xpay_live.xpay_stripe_subscription_invoices(invoice_id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY(settlement_id,invoice_id)
);
CREATE INDEX ON xpay_live.xpay_manual_settlement_items(invoice_id);
ALTER TABLE xpay_live.xpay_manual_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE xpay_live.xpay_manual_settlement_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON xpay_live.xpay_manual_settlements,xpay_live.xpay_manual_settlement_items FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON xpay_live.xpay_manual_settlements,xpay_live.xpay_manual_settlement_items TO service_role;

CREATE VIEW xpay_live.xpay_manual_settlement_queue WITH (security_invoker = true) AS
SELECT led.invoice_id,led.paid_at,led.currency,led.original_net_minor AS amount_minor,
       forecast.dispatch_window_at,payout.id AS settlement_id,
       CASE
         WHEN payout.id IS NOT NULL AND led.settlement_status <> 'settlement_pending' THEN 'paid_with_adjustment'
         WHEN payout.id IS NOT NULL THEN 'paid'
         WHEN led.settlement_status = 'refund_review' THEN 'refund_review'
         WHEN led.settlement_status = 'dispute_review' THEN 'dispute_review'
         WHEN forecast.dispatch_window_at <= now() THEN 'ready'
         WHEN forecast.dispatch_window_at IS NULL THEN 'calendar_missing'
         ELSE 'scheduled'
       END AS status
FROM xpay_live.xpay_stripe_subscription_balances led
LEFT JOIN LATERAL xpay_live.xpay_atlasclub_settlement_window(led.paid_at) forecast ON true
LEFT JOIN LATERAL (
  SELECT s.id
  FROM xpay_live.xpay_manual_settlement_items item
  JOIN xpay_live.xpay_manual_settlements s ON s.id=item.settlement_id AND s.reversed_at IS NULL
  WHERE item.invoice_id=led.invoice_id
  LIMIT 1
) payout ON true
WHERE led.seller_id='xpay_atlashub_mvp';

CREATE VIEW xpay_live.xpay_manual_settlement_history WITH (security_invoker = true) AS
SELECT s.id,s.currency,s.amount_minor,s.reference,s.payment_date,s.recorded_at,s.recorded_by,
       s.reversed_at,s.reversed_by,s.reversal_reason,
       array_agg(item.invoice_id ORDER BY item.invoice_id) AS invoice_ids
FROM xpay_live.xpay_manual_settlements s
JOIN xpay_live.xpay_manual_settlement_items item ON item.settlement_id=s.id
WHERE s.seller_id='xpay_atlashub_mvp'
GROUP BY s.id;
REVOKE ALL ON xpay_live.xpay_manual_settlement_queue,xpay_live.xpay_manual_settlement_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON xpay_live.xpay_manual_settlement_queue,xpay_live.xpay_manual_settlement_history TO service_role;

CREATE FUNCTION xpay_live.xpay_book_manual_settlement(
  p_request_id uuid,p_actor uuid,p_invoice_ids text[],p_amount_minor bigint,p_payment_date date,p_reference text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, xpay_live
AS $$
DECLARE
  selected_ids text[];
  prior xpay_live.xpay_manual_settlements%ROWTYPE;
  ref text := btrim(p_reference);
  total bigint;
  eligible integer;
BEGIN
  IF p_request_id IS NULL OR p_actor IS NULL OR p_payment_date IS NULL OR
     p_payment_date > (now() AT TIME ZONE 'Europe/Lisbon')::date OR
     coalesce(length(ref),0) NOT BETWEEN 1 AND 120 OR p_amount_minor IS NULL OR p_amount_minor <= 0 OR
     coalesce(cardinality(p_invoice_ids),0) NOT BETWEEN 1 AND 100 OR
     EXISTS (SELECT 1 FROM unnest(p_invoice_ids) AS v WHERE v IS NULL OR v !~ '^in_[A-Za-z0-9]{1,125}$') THEN
    RAISE EXCEPTION 'invalid settlement input' USING ERRCODE='22023';
  END IF;
  SELECT array_agg(DISTINCT invoice ORDER BY invoice) INTO selected_ids FROM unnest(p_invoice_ids) invoice;
  IF cardinality(selected_ids) <> cardinality(p_invoice_ids) THEN
    RAISE EXCEPTION 'duplicated invoices' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('xpay_atlashub_mvp:manual_settlement',0));
  SELECT * INTO prior FROM xpay_live.xpay_manual_settlements WHERE id=p_request_id;
  IF FOUND THEN
    IF prior.seller_id <> 'xpay_atlashub_mvp' OR prior.recorded_by <> p_actor OR prior.amount_minor <> p_amount_minor OR
       prior.payment_date <> p_payment_date OR prior.reference <> ref OR
       (SELECT array_agg(invoice_id ORDER BY invoice_id) FROM xpay_live.xpay_manual_settlement_items WHERE settlement_id=p_request_id)
           IS DISTINCT FROM selected_ids THEN
      RAISE EXCEPTION 'settlement request already used' USING ERRCODE='23505';
    END IF;
    RETURN prior.id;
  END IF;

  -- The Stripe booking/refund RPC also locks this row before applying adjustments.
  PERFORM invoice_id FROM xpay_live.xpay_stripe_subscription_invoices
  WHERE seller_id='xpay_atlashub_mvp' AND invoice_id=ANY(selected_ids) ORDER BY invoice_id FOR UPDATE;
  SELECT count(*),sum(q.amount_minor) INTO eligible,total FROM xpay_live.xpay_manual_settlement_queue q
  WHERE q.invoice_id=ANY(selected_ids) AND q.status='ready' AND q.amount_minor>0
    AND p_payment_date >= (q.dispatch_window_at AT TIME ZONE 'Europe/Lisbon')::date;
  IF eligible <> cardinality(selected_ids) THEN
    RAISE EXCEPTION 'invoices are not eligible for this settlement' USING ERRCODE='23514';
  END IF;
  IF total IS DISTINCT FROM p_amount_minor THEN
    RAISE EXCEPTION 'settlement amount does not match eligible invoices' USING ERRCODE='23514';
  END IF;

  INSERT INTO xpay_live.xpay_manual_settlements(id,seller_id,currency,amount_minor,payment_date,reference,recorded_by)
  VALUES(p_request_id,'xpay_atlashub_mvp','EUR',total,p_payment_date,ref,p_actor);
  INSERT INTO xpay_live.xpay_manual_settlement_items(settlement_id,invoice_id,amount_minor)
  SELECT p_request_id,q.invoice_id,q.amount_minor FROM xpay_live.xpay_manual_settlement_queue q WHERE q.invoice_id=ANY(selected_ids);
  RETURN p_request_id;
END;
$$;

CREATE FUNCTION xpay_live.xpay_reverse_manual_settlement(p_id uuid,p_actor uuid,p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, xpay_live
AS $$
DECLARE
  prior xpay_live.xpay_manual_settlements%ROWTYPE;
  reason text := btrim(p_reason);
BEGIN
  IF p_id IS NULL OR p_actor IS NULL OR coalesce(length(reason),0) NOT BETWEEN 4 AND 500 THEN
    RAISE EXCEPTION 'invalid financial reversal' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('xpay_atlashub_mvp:manual_settlement',0));
  SELECT * INTO prior FROM xpay_live.xpay_manual_settlements
  WHERE id=p_id AND seller_id='xpay_atlashub_mvp' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement not found' USING ERRCODE='22023';
  END IF;
  IF prior.reversed_at IS NOT NULL THEN
    IF prior.reversed_by=p_actor AND prior.reversal_reason=reason THEN RETURN prior.id; END IF;
    RAISE EXCEPTION 'settlement already reversed' USING ERRCODE='23505';
  END IF;
  UPDATE xpay_live.xpay_manual_settlements
    SET reversed_at=now(),reversed_by=p_actor,reversal_reason=reason WHERE id=p_id;
  RETURN p_id;
END;
$$;
REVOKE ALL ON FUNCTION xpay_live.xpay_book_manual_settlement(uuid,uuid,text[],bigint,date,text),
                       xpay_live.xpay_reverse_manual_settlement(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION xpay_live.xpay_book_manual_settlement(uuid,uuid,text[],bigint,date,text),
                          xpay_live.xpay_reverse_manual_settlement(uuid,uuid,text) TO service_role;
