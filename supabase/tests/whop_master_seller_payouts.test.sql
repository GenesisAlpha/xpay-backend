begin;

create extension if not exists pgtap with schema extensions;
select plan(40);

select has_table('public', 'seller_payout_accounts', 'seller payout accounts table exists');
select has_table('public', 'seller_payout_methods', 'seller payout methods table exists');
select has_table('public', 'payout_fee_rules', 'payout fee rules table exists');
select has_table('public', 'payout_executions', 'payout executions table exists');

select is(
  (select relrowsecurity from pg_class where oid = 'public.seller_payout_accounts'::regclass),
  true,
  'seller payout accounts has RLS enabled'
);
select is(
  (select relrowsecurity from pg_class where oid = 'public.seller_payout_methods'::regclass),
  true,
  'seller payout methods has RLS enabled'
);
select is(
  (select relrowsecurity from pg_class where oid = 'public.payout_fee_rules'::regclass),
  true,
  'payout fee rules has RLS enabled'
);
select is(
  (select relrowsecurity from pg_class where oid = 'public.payout_executions'::regclass),
  true,
  'payout executions has RLS enabled'
);

select is(
  (select count(*)::integer from public.payout_fee_rules where enabled),
  6,
  'six default fee rules are enabled'
);

select ok(
  not has_table_privilege('anon', 'public.payout_executions', 'select')
  and not has_table_privilege('authenticated', 'public.payout_executions', 'select'),
  'browser roles cannot read payout executions'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.claim_payout_dispatch(uuid,text)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.claim_payout_dispatch(uuid,text)',
    'execute'
  ),
  'only the backend role can claim payout dispatch'
);

insert into public.seller_profiles (
  id,
  enabled_methods,
  risk_level,
  kyc_status,
  status,
  created_at
) values (
  'seller-pgtap',
  array[]::text[],
  'WHITE',
  'approved',
  'active',
  now()
) on conflict (id) do nothing;

insert into public.wallet_balance (
  seller_id,
  available_balance,
  pending_balance,
  reserved_balance,
  withdrawing_balance,
  updated_at
) values (
  'seller-pgtap',
  100000,
  0,
  0,
  0,
  now()
) on conflict (seller_id) do update set
  available_balance = excluded.available_balance,
  pending_balance = excluded.pending_balance,
  reserved_balance = excluded.reserved_balance,
  withdrawing_balance = excluded.withdrawing_balance,
  updated_at = excluded.updated_at;

insert into public.seller_payout_accounts (
  seller_id,
  provider_account_id,
  status,
  verification_status,
  payouts_enabled,
  last_synced_at
) values (
  'seller-pgtap',
  'biz_pgtap',
  'ready',
  'approved',
  true,
  now()
);

insert into public.seller_payout_methods (
  id,
  seller_id,
  provider_method_id,
  provider_supported_method_id,
  method_key,
  delivery_speeds,
  currency,
  masked_reference,
  status,
  is_default
) values (
  '00000000-0000-4000-8000-000000000001',
  'seller-pgtap',
  'potk_pgtap',
  'podst_pgtap',
  'ach_standard',
  array['standard'],
  'USD',
  '••••6789',
  'active',
  true
);

create temporary table first_request as
select public.request_provider_payout_idempotent(
  'seller-pgtap',
  'request_12345678',
  repeat('a', 64),
  '00000000-0000-4000-8000-000000000001',
  'ach_standard',
  'standard',
  'USD',
  'USD',
  11990,
  540,
  640,
  11450,
  10810,
  10810,
  'quote_request_1',
  now() + interval '10 minutes',
  null,
  now() + interval '2 days',
  10810,
  'koopfy_payout_request_1'
) as response;

select is(
  (select response->>'status' from first_request),
  'pending_review',
  'request returns pending review'
);
select is(
  (select available_balance from public.wallet_balance where seller_id = 'seller-pgtap'),
  88010::bigint,
  'request decreases available by the exact gross amount'
);
select is(
  (select withdrawing_balance from public.wallet_balance where seller_id = 'seller-pgtap'),
  11990::bigint,
  'request moves the exact gross amount into withdrawing'
);
select is(
  (select count(*)::integer from public.payout_executions where seller_id = 'seller-pgtap'),
  1,
  'request creates one execution'
);

create temporary table replay_request as
select public.request_provider_payout_idempotent(
  'seller-pgtap',
  'request_12345678',
  repeat('a', 64),
  '00000000-0000-4000-8000-000000000001',
  'ach_standard',
  'standard',
  'USD',
  'USD',
  11990,
  540,
  640,
  11450,
  10810,
  10810,
  'quote_request_1',
  now() + interval '10 minutes',
  null,
  now() + interval '2 days',
  10810,
  'koopfy_payout_request_1'
) as response;

select is(
  (select response->>'payoutId' from replay_request),
  (select response->>'payoutId' from first_request),
  'idempotent replay returns the original payout'
);
select is(
  (select response->>'replayed' from replay_request),
  'true',
  'idempotent replay is identified'
);

create temporary table first_claim as
select public.claim_payout_dispatch(
  (select (response->>'payoutId')::uuid from first_request),
  'admin-a'
) as response;
create temporary table second_claim as
select public.claim_payout_dispatch(
  (select (response->>'payoutId')::uuid from first_request),
  'admin-b'
) as response;

select is((select response->>'claimed' from first_claim), 'true', 'first admin claims dispatch');
select is((select response->>'claimed' from second_claim), 'false', 'second admin cannot claim dispatch');

update public.payout_executions
set claimed_at = now() - interval '10 minutes'
where id = (select (response->>'payoutId')::uuid from first_request);

select is(
  public.claim_payout_reconciliation(
    (select (response->>'payoutId')::uuid from first_request),
    'admin-reconcile-a',
    now() - interval '5 minutes'
  )->>'claimed',
  'true',
  'first reconciler leases a stale dispatch'
);
select is(
  public.claim_payout_reconciliation(
    (select (response->>'payoutId')::uuid from first_request),
    'admin-reconcile-b',
    now() - interval '5 minutes'
  )->>'claimed',
  'false',
  'second reconciler cannot lease the same dispatch'
);

select is(
  public.mark_payout_requote_required(
    (select (response->>'payoutId')::uuid from first_request),
    651,
    10799,
    'USD',
    10799,
    'quote_deteriorated',
    now() + interval '10 minutes',
    null,
    now() + interval '2 days',
    (
      select dispatch_attempt_token
        from public.payout_executions
       where id = (select (response->>'payoutId')::uuid from first_request)
    )
  )->>'state',
  'requote_required',
  'deteriorated approval quote requires seller reconfirmation'
);
select is(
  (
    select status
      from public.wallet_ledger
     where id = (
       select ledger_entry_id
         from public.payout_executions
        where id = (select (response->>'payoutId')::uuid from first_request)
     )
  ),
  'requote_required',
  'requote transition updates execution and ledger together'
);

select is(
  public.requeue_requoted_payout(
    (select (response->>'payoutId')::uuid from first_request),
    620,
    10830,
    10830,
    'quote_reconfirmed',
    now() + interval '10 minutes',
    null,
    now() + interval '2 days',
    10830
  )->>'state',
  'pending_review',
  'seller reconfirmation requeues the existing reserved execution'
);

select ok(
  (
    select dispatch_attempt_token is null
       and provider_create_started_at is null
       and provider_create_resolved_at is null
      from public.payout_executions
     where id = (select (response->>'payoutId')::uuid from first_request)
  ),
  'seller reconfirmation clears the previous dispatch lease'
);

select is(
  public.claim_payout_dispatch(
    (select (response->>'payoutId')::uuid from first_request),
    'admin-c'
  )->>'claimed',
  'true',
  'reconfirmed payout can be claimed with a fresh lease'
);

select is(
  public.mark_payout_create_started(
    (select (response->>'payoutId')::uuid from first_request),
    (
      select dispatch_attempt_token
        from public.payout_executions
       where id = (select (response->>'payoutId')::uuid from first_request)
    )
  )->>'started',
  'true',
  'provider create boundary is persisted before the external request'
);

select throws_ok(
  format(
    'select public.release_payout_reservation(%L::uuid, %L, %L)',
    (select response->>'payoutId' from first_request),
    'admin-c',
    'must remain reserved'
  ),
  'KP409',
  'Resultado do envio ao provider ainda é incerto.',
  'an unresolved external create can never release reserved funds'
);

select is(
  public.resolve_payout_create_failure(
    (select (response->>'payoutId')::uuid from first_request),
    (
      select dispatch_attempt_token
        from public.payout_executions
       where id = (select (response->>'payoutId')::uuid from first_request)
    ),
    'provider_validation_failed',
    'definitive rejection'
  )->>'state',
  'dispatch_failed',
  'a definitive provider rejection resolves the external create boundary'
);

select is(
  public.release_payout_reservation(
    (select (response->>'payoutId')::uuid from first_request),
    'admin-a',
    'rejected in pgTAP'
  )->>'released',
  'true',
  'rejection releases the reservation once'
);
select is(
  public.release_payout_reservation(
    (select (response->>'payoutId')::uuid from first_request),
    'admin-a',
    'duplicate rejection'
  )->>'released',
  'false',
  'duplicate rejection does not release twice'
);
select is(
  (select available_balance from public.wallet_balance where seller_id = 'seller-pgtap'),
  100000::bigint,
  'rejection restores available balance'
);

create temporary table accepted_request as
select public.request_provider_payout_idempotent(
  'seller-pgtap',
  'request_accepted_123',
  repeat('b', 64),
  '00000000-0000-4000-8000-000000000001',
  'ach_standard',
  'standard',
  'USD',
  'USD',
  11990,
  540,
  640,
  11450,
  10810,
  10810,
  'quote_request_2',
  now() + interval '10 minutes',
  null,
  now() + interval '2 days',
  10810,
  'koopfy_payout_request_2'
) as response;

select public.claim_payout_dispatch(
  (select (response->>'payoutId')::uuid from accepted_request),
  'admin-a'
);

select is(
  public.mark_payout_create_started(
    (select (response->>'payoutId')::uuid from accepted_request),
    (
      select dispatch_attempt_token
        from public.payout_executions
       where id = (select (response->>'payoutId')::uuid from accepted_request)
    )
  )->>'started',
  'true',
  'recovery fixture persists the external create boundary'
);

select is(
  public.attach_recovered_provider_payout(
    (select (response->>'payoutId')::uuid from accepted_request),
    'wdrl_pgtap',
    'processing',
    (
      select dispatch_attempt_token
        from public.payout_executions
       where id = (select (response->>'payoutId')::uuid from accepted_request)
    )
  )->>'finalized',
  'true',
  'verified provider recovery atomically finalizes withdrawing outflow'
);
select is(
  public.finalize_payout_outflow(
    (select (response->>'payoutId')::uuid from accepted_request),
    'wdrl_pgtap',
    'processing'
  )->>'finalized',
  'false',
  'provider acceptance finalization is idempotent'
);
select is(
  (select withdrawing_balance from public.wallet_balance where seller_id = 'seller-pgtap'),
  0::bigint,
  'finalization removes the accepted amount from withdrawing'
);

select is(
  public.restore_provider_payout_funds(
    (select (response->>'payoutId')::uuid from accepted_request),
    'failed',
    null,
    'provider failure without returned funds'
  )->>'restored',
  'false',
  'failure without returned funds does not credit the wallet'
);
select is(
  public.restore_provider_payout_funds(
    (select (response->>'payoutId')::uuid from accepted_request),
    'failed',
    now(),
    'provider returned funds'
  )->>'restored',
  'true',
  'confirmed returned funds credit the wallet'
);
select is(
  public.restore_provider_payout_funds(
    (select (response->>'payoutId')::uuid from accepted_request),
    'failed',
    now(),
    'duplicate returned funds event'
  )->>'restored',
  'false',
  'duplicate returned funds do not credit twice'
);
select is(
  (select available_balance from public.wallet_balance where seller_id = 'seller-pgtap'),
  100000::bigint,
  'wallet balance is restored exactly once'
);

select * from finish();
rollback;
