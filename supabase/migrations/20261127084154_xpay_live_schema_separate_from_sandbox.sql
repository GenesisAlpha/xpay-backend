-- The XPAY pilot shares a Supabase project with the Stripe sandbox.
-- Clone the verified sandbox table structure and keep all rows environment-specific.
CREATE SCHEMA xpay_live;
COMMENT ON SCHEMA xpay_live IS 'XPAY production data. The public schema belongs to the Stripe sandbox.';
REVOKE ALL ON SCHEMA xpay_live FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA xpay_live TO service_role;

DO $migration$
DECLARE
  pilot_tables constant text[] := ARRAY['users','seller_profiles','api_keys','fee_tiers','fee_tier_versions','seller_fees','stripe_accounts','account_daily_metrics','payment_method_routes','wallet_ledger','payment_method_route_history','wallet_balance','offers','checkout_sessions','transactions','transaction_attempts','stripe_webhook_events','gw_embed_origins','xpay_orbia_merchants','xpay_orbia_products','xpay_event_outbox'];
  table_name text;
  fk record;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);
  FOREACH table_name IN ARRAY pilot_tables LOOP
    EXECUTE format('CREATE TABLE xpay_live.%I (LIKE public.%I INCLUDING ALL)', table_name, table_name);
    EXECUTE format('ALTER TABLE xpay_live.%I ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;

  FOR fk IN
    SELECT rel.relname, target.relname AS target_table, target.relnamespace AS target_namespace,
           con.conname, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_class target ON target.oid = con.confrelid
    WHERE con.contype = 'f' AND rel.relnamespace = 'public'::regnamespace
      AND rel.relname = ANY(pilot_tables)
  LOOP
    IF fk.target_namespace <> 'public'::regnamespace OR NOT fk.target_table = ANY(pilot_tables)
       OR position('REFERENCES public.' in fk.definition) = 0 THEN
      RAISE EXCEPTION 'Unexpected foreign key target for XPAY pilot constraint %', fk.conname;
    END IF;
    EXECUTE format(
      'ALTER TABLE xpay_live.%I ADD CONSTRAINT %I %s',
      fk.relname, fk.conname, replace(fk.definition, 'REFERENCES public.', 'REFERENCES xpay_live.')
    );
  END LOOP;
END;
$migration$;

ALTER TABLE xpay_live.stripe_accounts
  DROP CONSTRAINT stripe_accounts_publishable_key_check,
  DROP CONSTRAINT stripe_accounts_livemode_check,
  ADD CONSTRAINT stripe_accounts_publishable_key_check CHECK (publishable_key ~ '^pk_live_[A-Za-z0-9_]+$'),
  ADD CONSTRAINT stripe_accounts_livemode_check CHECK (livemode IS TRUE);

REVOKE ALL ON ALL TABLES IN SCHEMA xpay_live FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA xpay_live TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA xpay_live REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Keep the captured payment, pending USD ledger, wallet balance and CRM outbox atomic.
CREATE OR REPLACE FUNCTION xpay_live.xpay_approve_stripe_payment(p_transaction_id text, p_ledger_rows jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, xpay_live
AS $$
DECLARE
  sale xpay_live.transactions%ROWTYPE;
  booked_at timestamptz := now();
BEGIN
  SELECT * INTO STRICT sale FROM xpay_live.transactions WHERE id = p_transaction_id FOR UPDATE;
  IF sale.provider IS DISTINCT FROM 'stripe' OR sale.provider_account_id IS NULL OR
     sale.provider_transaction_id IS NULL THEN
    RAISE EXCEPTION 'Expected a Stripe transaction with account and intent' USING ERRCODE = '23514';
  END IF;
  IF sale.status = 'approved' THEN
    RETURN false;
  END IF;
  IF sale.status IS NULL OR sale.status NOT IN ('pending', 'processing', 'awaiting_payment', 'failed') OR
     sale.net_amount IS NULL OR sale.net_amount <= 0 OR
     jsonb_typeof(p_ledger_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid pending credit' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_ledger_rows) NOT BETWEEN 1 AND 8 OR
     (SELECT count(*) FROM jsonb_to_recordset(p_ledger_rows) AS entry(type text, seller_id text, amount bigint)
       WHERE entry.type = 'credit_pending' AND entry.seller_id = sale.seller_id AND entry.amount = sale.net_amount) <> 1 OR
     EXISTS (
       SELECT 1 FROM jsonb_to_recordset(p_ledger_rows) AS entry(
         transaction_id text, seller_id text, amount bigint, currency text, type text, status text, available_at timestamptz
       )
       WHERE entry.transaction_id IS DISTINCT FROM sale.id OR entry.seller_id IS NULL OR entry.amount IS NULL OR
             entry.amount <= 0 OR entry.currency IS DISTINCT FROM 'USD' OR entry.type IS NULL OR entry.status IS NULL OR
             NOT (
               (entry.type = 'credit_pending' AND entry.status = 'pending' AND entry.seller_id = sale.seller_id AND entry.available_at IS NOT NULL) OR
               (entry.type = 'reserve_hold' AND entry.status = 'hold' AND entry.seller_id = sale.seller_id AND entry.available_at IS NOT NULL) OR
               (entry.type = 'credit_affiliate_commission' AND entry.status = 'pending' AND entry.available_at IS NOT NULL) OR
               (entry.type IN ('debit_platform_fee', 'credit_platform_fee', 'debit_affiliate_commission', 'debit_external_fee', 'credit_external_fee') AND entry.status = 'completed')
             )
     ) OR
     (SELECT coalesce(sum(entry.amount),0) FROM jsonb_to_recordset(p_ledger_rows) AS entry(type text, amount bigint) WHERE entry.type = 'reserve_hold')
       <> coalesce(sale.reserve_amount,0) THEN
    RAISE EXCEPTION 'Ledger rows do not match the pending Stripe sale' USING ERRCODE = '23514';
  END IF;

  INSERT INTO xpay_live.wallet_ledger (seller_id, transaction_id, type, amount, currency, status, available_at, created_at, metadata)
  SELECT entry.seller_id, sale.id, entry.type, entry.amount, entry.currency, entry.status, entry.available_at, booked_at,
         CASE WHEN entry.type = 'reserve_hold' THEN coalesce(entry.metadata,'{}'::jsonb) || '{"reserve_counted":true}'::jsonb
              ELSE coalesce(entry.metadata,'{}'::jsonb) END
  FROM jsonb_to_recordset(p_ledger_rows) AS entry(
    seller_id text, type text, amount bigint, currency text, status text, available_at timestamptz, metadata jsonb
  );

  INSERT INTO xpay_live.wallet_balance AS wallet (seller_id, pending_balance, reserved_balance, available_balance, updated_at)
  SELECT entry.seller_id,
         coalesce(sum(entry.amount) FILTER (WHERE entry.type IN ('credit_pending','credit_affiliate_commission')),0),
         coalesce(sum(entry.amount) FILTER (WHERE entry.type = 'reserve_hold'),0),
         coalesce(sum(entry.amount) FILTER (WHERE entry.type IN ('credit_platform_fee','credit_external_fee')),0),
         booked_at
  FROM jsonb_to_recordset(p_ledger_rows) AS entry(seller_id text, type text, amount bigint)
  WHERE entry.type IN ('credit_pending','credit_affiliate_commission','reserve_hold','credit_platform_fee','credit_external_fee')
  GROUP BY entry.seller_id ORDER BY entry.seller_id
  ON CONFLICT (seller_id) DO UPDATE SET
    pending_balance = coalesce(wallet.pending_balance,0) + excluded.pending_balance,
    reserved_balance = coalesce(wallet.reserved_balance,0) + excluded.reserved_balance,
    available_balance = coalesce(wallet.available_balance,0) + excluded.available_balance,
    updated_at = excluded.updated_at;

  INSERT INTO xpay_live.xpay_event_outbox (seller_id, event_key, event_type, body)
  SELECT sale.seller_id, 'payment.approved:' || sale.id, 'payment.approved',
    jsonb_build_object(
      'transactionId', sale.id, 'externalReference', sale.external_reference,
      'organizationId', merchant.orbia_org_id, 'installation', merchant.orbia_installation,
      'gross', jsonb_build_object('minor', sale.amount, 'currency', sale.currency),
      'net', jsonb_build_object('minor', sale.net_amount, 'currency', 'USD'),
      'fee', jsonb_build_object('minor', coalesce(sale.fee,0), 'currency', 'USD'),
      'fxFee', jsonb_build_object('minor', coalesce(sale.fx_fee_cents,0), 'currency', 'USD'))
  FROM xpay_live.xpay_orbia_merchants merchant WHERE merchant.seller_id = sale.seller_id;

  UPDATE xpay_live.transactions SET status = 'approved', provider_status = 'completed', approved_at = booked_at,
         processed_at = booked_at, webhook_sent = true, last_webhook_at = booked_at, updated_at = booked_at
   WHERE id = sale.id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION xpay_live.xpay_approve_stripe_payment(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION xpay_live.xpay_approve_stripe_payment(text,jsonb) TO service_role;
