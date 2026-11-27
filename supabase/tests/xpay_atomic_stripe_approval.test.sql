begin;

insert into public.seller_profiles(id,name,country,status) values ('xpay_approval_qa_only','QA rollback only','GB','active');
insert into public.xpay_orbia_merchants(seller_id,orbia_installation,orbia_org_id)
  values ('xpay_approval_qa_only','qa-atomic-release-test','36d861ce-0ab1-4bf0-b613-8119635eea0c');
insert into public.transactions(id,seller_id,amount,currency,method,status,provider,provider_account_id,provider_transaction_id,net_amount,fee,reserve_amount)
values ('qa_atomic_paid','xpay_approval_qa_only',100,'EUR','card','pending','stripe','xpay_sandbox_ecom','pi_qa_atomic_paid',85,10,5),
       ('qa_atomic_rollback','xpay_approval_qa_only',100,'EUR','card','pending','stripe','xpay_sandbox_ecom','pi_qa_atomic_rollback',100,0,0);
do $test$
declare
  entries jsonb := jsonb_build_array(
    jsonb_build_object('seller_id','xpay_approval_qa_only','transaction_id','qa_atomic_paid','type','credit_pending','amount',85,'currency','USD','status','pending','available_at',now()),
    jsonb_build_object('seller_id','xpay_approval_qa_only','transaction_id','qa_atomic_paid','type','reserve_hold','amount',5,'currency','USD','status','hold','available_at',now()));
begin
  if public.xpay_approve_stripe_payment('qa_atomic_paid',entries) is not true
     or public.xpay_approve_stripe_payment('qa_atomic_paid',entries) is not false then
    raise exception 'unexpected booking/deduplication result';
  end if;
  if (select status from public.transactions where id='qa_atomic_paid') <> 'approved'
    or (select count(*) from public.wallet_ledger where transaction_id='qa_atomic_paid') <> 2
    or (select count(*) from public.wallet_balance where seller_id='xpay_approval_qa_only' and pending_balance=85 and reserved_balance=5) <> 1
    or (select count(*) from public.xpay_event_outbox where seller_id='xpay_approval_qa_only' and event_key='payment.approved:qa_atomic_paid'
        and body->'gross'->>'currency'='EUR' and body->'net'->>'currency'='USD') <> 1 then
    raise exception 'atomic booking invariants failed';
  end if;
  begin
    perform public.xpay_approve_stripe_payment('qa_atomic_rollback',jsonb_build_array(
      jsonb_build_object('seller_id','xpay_approval_qa_only','transaction_id','qa_atomic_rollback','type','credit_pending','amount',100,'currency','USD','status','pending','available_at',now()),
      jsonb_build_object('seller_id','xpay_qa_missing_recipient','transaction_id','qa_atomic_rollback','type','credit_external_fee','amount',1,'currency','USD','status','completed')));
    raise exception 'expected a foreign key error';
  exception when foreign_key_violation then
    if (select status from public.transactions where id='qa_atomic_rollback') <> 'pending'
       or exists(select 1 from public.wallet_ledger where transaction_id='qa_atomic_rollback')
       or exists(select 1 from public.xpay_event_outbox where event_key='payment.approved:qa_atomic_rollback') then
      raise exception 'partial booking survived a failed transaction';
    end if;
  end;
end;
$test$;
select 'PASS: aprovação, ledger, reserva, outbox, deduplicação e rollback na XPAY-db sandbox' as test_result;
rollback;