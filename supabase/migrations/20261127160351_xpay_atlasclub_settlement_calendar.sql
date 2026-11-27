CREATE TABLE xpay_live.xpay_atlasclub_holidays (
  territory text NOT NULL CHECK (territory IN ('GB-EAW','PT','ES')),
  holiday date NOT NULL,
  source_url text NOT NULL,
  PRIMARY KEY (territory, holiday)
);
ALTER TABLE xpay_live.xpay_atlasclub_holidays ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON xpay_live.xpay_atlasclub_holidays FROM PUBLIC, anon, authenticated;
GRANT SELECT ON xpay_live.xpay_atlasclub_holidays TO service_role;

-- The pilot uses England and Wales, Portugal and Spain's nationwide dates.
-- These dates determine the quoted window. Provider clearance remains separate.
INSERT INTO xpay_live.xpay_atlasclub_holidays(territory,holiday,source_url)
SELECT territory, holiday, source_url
FROM (VALUES
  ('GB-EAW', ARRAY[DATE '2026-12-25','2026-12-28','2027-01-01','2027-03-26','2027-03-29',
                           '2027-05-03','2027-05-31','2027-08-30','2027-12-27','2027-12-28'],
     'https://www.gov.uk/bank-holidays'),
  ('PT', ARRAY[DATE '2026-12-01','2026-12-08','2026-12-25','2027-01-01','2027-03-26','2027-03-28',
                    '2027-04-25','2027-05-01','2027-05-27','2027-06-10','2027-08-15','2027-10-05',
                    '2027-11-01','2027-12-01','2027-12-08','2027-12-25'],
     'https://diariodarepublica.pt/dr/detalhe/lei/8-2016-74007209'),
  ('ES', ARRAY[DATE '2026-12-06','2026-12-08','2026-12-25'],
     'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2025-21667'),
  ('ES', ARRAY[DATE '2027-01-01','2027-01-06','2027-03-26','2027-05-01','2027-08-15','2027-10-12',
                    '2027-11-01','2027-12-06','2027-12-08','2027-12-25'],
     'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-21254')
) AS sources(territory,dates,source_url)
CROSS JOIN LATERAL unnest(sources.dates) AS entries(holiday);

CREATE FUNCTION xpay_live.xpay_atlasclub_settlement_window(p_paid_at timestamptz)
RETURNS TABLE(availability_date date, dispatch_window_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, xpay_live
AS $$
  WITH policy AS (
    SELECT (p_paid_at AT TIME ZONE 'Europe/Lisbon')::date AS confirmed_on,
           DATE '2026-11-27' AS calendar_start,
           DATE '2027-12-31' AS calendar_end
  ), upcoming_days AS (
    SELECT policy.confirmed_on + distance AS business_date
    FROM policy CROSS JOIN pg_catalog.generate_series(1,31) AS steps(distance)
    WHERE policy.confirmed_on BETWEEN calendar_start AND calendar_end
      AND policy.confirmed_on + distance <= calendar_end
      AND extract(isodow FROM policy.confirmed_on + distance) < 6
      AND NOT EXISTS (
        SELECT 1 FROM xpay_live.xpay_atlasclub_holidays h WHERE h.holiday=policy.confirmed_on + distance
      )
    ORDER BY business_date
    LIMIT 4
  ), next_dates AS (
    SELECT array_agg(business_date ORDER BY business_date) AS dates FROM upcoming_days
  )
  SELECT dates[3], (dates[4] + TIME '12:00:00') AT TIME ZONE 'Europe/Lisbon'
  FROM next_dates
  WHERE cardinality(dates)=4;
$$;
REVOKE ALL ON FUNCTION xpay_live.xpay_atlasclub_settlement_window(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION xpay_live.xpay_atlasclub_settlement_window(timestamptz) TO service_role;

CREATE VIEW xpay_live.xpay_atlasclub_settlement_preview WITH (security_invoker = true) AS
SELECT led.invoice_id, led.seller_id, led.currency, led.original_net_minor, led.settlement_status,
       forecast.availability_date, forecast.dispatch_window_at,
       (led.stripe_balance->>'currency') AS stripe_balance_currency,
       coalesce(led.stripe_balance->>'status'='available',false) AS stripe_balance_available
FROM xpay_live.xpay_stripe_subscription_balances led
LEFT JOIN LATERAL xpay_live.xpay_atlasclub_settlement_window(led.paid_at) forecast ON true;
REVOKE ALL ON xpay_live.xpay_atlasclub_settlement_preview FROM PUBLIC, anon, authenticated;
GRANT SELECT ON xpay_live.xpay_atlasclub_settlement_preview TO service_role;
