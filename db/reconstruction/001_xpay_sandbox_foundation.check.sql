-- Run after 001_xpay_sandbox_foundation.sql on a clean validation database.
-- Removes its fixtures by rolling back. The runner must stop on SQL errors.

begin;
do $test$
declare
  shop text;
  different_shop text;
  offer text;
  tx text;
begin
  if (select count(*) from public.fee_tiers where not enabled) <> 5 then
    raise exception 'unexpected fee tiers';
  end if;
  if exists (select 1 from public.fee_tier_versions) then
    raise exception 'unapproved rate values';
  end if;
  insert into public.seller_profiles (name,country,enabled_methods) values ('Test merchant','PT',array['mbway','multibanco']) returning id into shop;
  insert into public.seller_profiles (name) values ('Separate test merchant') returning id into different_shop;
  insert into public.seller_fees (seller_id,processing_fee_pct,fee_fixed_usd,checkout_fee_source) values (shop,2,0,'crm');
  insert into public.offers (seller_id,name,amount_minor,currency) values (shop,'Test offer',990,'EUR') returning id into offer;
  insert into public.checkout_sessions (id,seller_id,amount,currency,country) values ('cs_isolated_sql_check',shop,990,'EUR','PT');
  insert into public.transactions (seller_id,offer_id,amount,currency,method,idempotency_key) values (shop,offer,990,'EUR','mbway','atlasclub-check') returning id into tx;
  begin
    insert into public.transactions (seller_id,amount,currency,method,idempotency_key) values (shop,990,'EUR','mbway','atlasclub-check');
    raise exception 'accepted duplicate idempotency key';
  exception when unique_violation then null; end;
  begin
    insert into public.transactions (seller_id,offer_id,amount,currency,method) values (different_shop,offer,990,'EUR','mbway');
    raise exception 'accepted cross-merchant offer';
  exception when foreign_key_violation then null; end;
  insert into public.stripe_webhook_events (event_id,account_id,event_type) values ('evt_isolated_database_check','test-account','payment_intent.succeeded');
  begin
    insert into public.stripe_webhook_events (event_id,account_id,event_type) values ('evt_isolated_database_check','test-account','payment_intent.succeeded');
    raise exception 'accepted a duplicate webhook event';
  exception when unique_violation then null; end;
  insert into public.wallet_balance(seller_id) values (shop);
  insert into public.wallet_ledger(seller_id,transaction_id,type,amount,currency,status) values (shop,tx,'credit_pending',900,'USD','pending');
  begin
    insert into public.wallet_ledger(seller_id,transaction_id,type,amount,currency,status) values (shop,tx,'credit_pending',900,'USD','pending');
    raise exception 'accepted repeated ledger booking';
  exception when unique_violation then null; end;
  begin
    insert into public.stripe_accounts (id,livemode) values ('live-account-check',true);
    raise exception 'accepted production mode';
  exception when check_violation then null; end;
  begin
    insert into public.stripe_accounts (id,secret_key) values ('plaintext-test-account','clear text');
    raise exception 'accepted a clear text provider key';
  exception when check_violation then null; end;
end $test$;
set local role anon;
do $permission$
begin
  begin
    perform * from public.stripe_accounts;
    raise exception 'anon can read provider accounts';
  exception when insufficient_privilege then null; end;
end $permission$;
reset role;
set local role authenticated;
do $permission$
begin
  begin
    perform * from public.transactions;
    raise exception 'authenticated role can read another merchant transactions';
  exception when insufficient_privilege then null; end;
end $permission$;
reset role;
set local role service_role;
select count(*) as tiers_visible_to_service from public.fee_tiers;
reset role;
rollback;
select count(*) as public_tables from pg_tables where schemaname='public';
select count(*) as tables_with_rls from pg_tables where schemaname='public' and rowsecurity;
select count(*) as sandbox_rows_left from public.transactions;
