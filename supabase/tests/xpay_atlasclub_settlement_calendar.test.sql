DO $$
BEGIN
 IF NOT EXISTS (SELECT FROM xpay_live.xpay_atlasclub_settlement_window('2026-11-27T14:00Z') 
    WHERE availability_date='2026-12-03' AND dispatch_window_at='2026-12-04T12:00Z') THEN
   RAISE EXCEPTION 'Wrong December 1 holiday handling';
 END IF;
 IF NOT EXISTS (SELECT FROM xpay_live.xpay_atlasclub_settlement_window('2026-12-25T11:00Z') 
    WHERE availability_date='2026-12-31' AND dispatch_window_at='2027-01-04T12:00Z') THEN
   RAISE EXCEPTION 'Wrong Christmas or New Year handling';
 END IF;
 IF NOT EXISTS (SELECT FROM xpay_live.xpay_atlasclub_settlement_window('2027-07-13T12:00Z') 
    WHERE availability_date='2027-07-16' AND dispatch_window_at='2027-07-19T11:00Z') THEN
   RAISE EXCEPTION 'Wrong Lisbon daylight saving conversion';
 END IF;
 IF EXISTS (SELECT FROM xpay_live.xpay_atlasclub_settlement_window('2027-12-30T14:00Z')) THEN
   RAISE EXCEPTION 'Projected dispatch without supported holiday coverage';
 END IF;
END;
$$;