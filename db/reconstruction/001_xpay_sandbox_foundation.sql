-- XPAY sandbox bootstrap. Reconstructed from xpay-backend dad3e55f.
-- Apply to a fresh database. The original Supabase migrations are incremental
-- and require further contracts before they can be replayed on this foundation.
-- A checked sandbox default keeps this schema unsuitable for a live provider.

create table public.users (
    id text primary key default gen_random_uuid()::text,
    email text unique,
    name text,
    full_name text,
    password_hash text,
    instagram text,
    whatsapp text,
    avatar_url text,
    email_verified boolean not null default false,
    email_verify_token text,
    email_verify_token_expires_at timestamptz,
    email_verified_at timestamptz,
    password_reset_token text,
    password_reset_expires_at timestamptz,
    last_login_at timestamptz,
    operation_setup_completed boolean not null default false,
    role text not null default 'seller',
    kyc_completed boolean not null default false,
    documents_completed boolean not null default false,
    onboarding_completed boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.seller_profiles (
    id text primary key default gen_random_uuid()::text,
    user_id text references public.users(id),
    name text not null,
    email text,
    country text check (country ~ '^[A-Z]{2}$'),
    instagram text,
    enabled_methods text[] not null default '{}',
    risk_level text,
    kyc_status text not null default 'pending',
    status text not null default 'pending_review',
    provider_default text,
    provider_mid text,
    payment_routing jsonb,
    config jsonb not null default '{}',
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index seller_profiles_user_id_idx on public.seller_profiles(user_id);

create table public.api_keys (
    id uuid primary key default gen_random_uuid(),
    seller_id text not null references public.seller_profiles(id),
    key_prefix text not null unique,
    secret_key_hash text not null check (secret_key_hash ~ '^[a-f0-9]{64}$'),
    name text,
    is_active boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.fee_tiers (
    code text primary key,
    label text not null,
    enabled boolean not null default false
);

create table public.fee_tier_versions (
    id uuid primary key default gen_random_uuid(),
    tier_code text not null references public.fee_tiers(code),
    version integer not null check (version > 0),
    effective_from timestamptz not null,
    effective_until timestamptz,
    approved_at timestamptz,
    currency text not null check (currency ~ '^[A-Z]{3}$'),
    fee_terms jsonb not null check (jsonb_typeof(fee_terms) = 'object'),
    unique(tier_code, version),
    check (effective_until is null or effective_until > effective_from)
);

create table public.seller_fees (
    seller_id text primary key references public.seller_profiles(id),
    tier_version_id uuid references public.fee_tier_versions(id),
    risk_level text,
    fee_percentage numeric(7,3),
    fx_fee_pct numeric(7,3),
    checkout_fee_pct numeric(7,3),
    processing_fee_pct numeric(7,3),
    orchestration_fee_pct numeric(7,3),
    fee_fixed_usd numeric(12,2),
    reserve_percentage numeric(7,3),
    reserve_hold_days integer check (reserve_hold_days >= 0),
    settlement_days integer check (settlement_days >= 0),
    chargeback_fee_usd numeric(12,2),
    payout_min_usd numeric(12,2),
    payout_fee_pct numeric(7,3),
    payout_fee_fixed_usd numeric(12,2),
    payout_fx_fee_pct numeric(7,3),
    anticipation_enabled boolean not null default false,
    anticipation_days integer check (anticipation_days >= 0),
    anticipation_fee_pct numeric(7,3),
    checkout_fee_source text check (checkout_fee_source in ('legacy', 'plan', 'crm')),
    checkout_fee_updated_at timestamptz,
    overridden_by text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (
      least(fee_percentage, fx_fee_pct, checkout_fee_pct, processing_fee_pct,
        orchestration_fee_pct, reserve_percentage, payout_fee_pct, payout_fx_fee_pct,
        anticipation_fee_pct) >= 0
      and greatest(fee_percentage, fx_fee_pct, checkout_fee_pct, processing_fee_pct,
        orchestration_fee_pct, reserve_percentage, payout_fee_pct, payout_fx_fee_pct,
        anticipation_fee_pct) <= 100
    ),
    check (least(fee_fixed_usd, chargeback_fee_usd, payout_min_usd, payout_fee_fixed_usd) >= 0)
);

create table public.stripe_accounts (
    id text primary key,
    label text,
    entity text,
    holder_legal_name text,
    holder_document text,
    holder_country text,
    stripe_account_id text unique,
    country text,
    default_currency text not null default 'EUR',
    product_url text,
    domain text,
    bank_account_last4 text,
    bank_name text,
    secret_key text check (secret_key ~ '^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]{2,}$'),
    publishable_key text check (publishable_key ~ '^pk_test_[A-Za-z0-9_]+$'),
    webhook_secret text check (webhook_secret ~ '^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]{2,}$'),
    livemode boolean not null default false check (livemode = false),
    status text not null default 'inactive',
    weight integer not null default 1 check (weight >= 0),
    supported_methods text[],
    countries text[],
    risk_levels text[],
    segments text[],
    domains text[],
    daily_cap_amount bigint,
    min_ticket bigint,
    max_ticket bigint,
    cooldown_until timestamptz,
    activated_at timestamptz,
    warmup_days integer,
    probe_charges_enabled boolean not null default false,
    probe_payouts_enabled boolean not null default false,
    probe_disabled_reason text,
    probed_at timestamptz,
    quarantined_at timestamptz,
    quarantine_reason text,
    efw_auto_refund boolean not null default false,
    efw_auto_refund_max_usd_cents bigint,
    declared_monthly_volume_usd_cents bigint,
    declared_avg_ticket_usd_cents bigint,
    declared_mcc text,
    statement_descriptor text,
    descriptor_suffix text,
    support_email text,
    support_phone text,
    support_url text,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (status <> 'active' or (
      stripe_account_id is not null and secret_key is not null
      and publishable_key is not null and webhook_secret is not null
    ))
);

create table public.account_daily_metrics (
    account_id text not null,
    day date not null,
    volume bigint not null default 0,
    paid_count integer not null default 0,
    primary key(account_id, day)
);

create table public.payment_method_routes (
    id uuid primary key default gen_random_uuid(),
    method text not null,
    country text check (country ~ '^[A-Z]{2}$'),
    currency text check (currency ~ '^[A-Z]{3}$'),
    seller_id text references public.seller_profiles(id),
    providers text[] not null check (cardinality(providers) between 1 and 5),
    enabled boolean not null default false,
    notes text,
    updated_by text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create unique index payment_method_routes_scope_uq on public.payment_method_routes
    (method, coalesce(country, ''), coalesce(currency, ''), coalesce(seller_id, ''));

create table public.payment_method_route_history (
    id uuid primary key default gen_random_uuid(),
    route_id uuid,
    action text not null,
    before jsonb,
    after jsonb,
    actor text,
    created_at timestamptz not null default now()
);

create table public.offers (
    id text primary key default gen_random_uuid()::text,
    seller_id text not null references public.seller_profiles(id),
    name text not null,
    user_id text references public.users(id),
    description text,
    sales_page_url text,
    niche text,
    segment text,
    risk_level text,
    status text not null default 'pending_review',
    amount_minor bigint check (amount_minor > 0),
    currency text check (currency ~ '^[A-Z]{3}$'),
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(seller_id, id)
);

create table public.checkout_sessions (
    id text primary key,
    seller_id text not null references public.seller_profiles(id),
    amount bigint not null check (amount > 0),
    currency text not null check (currency ~ '^[A-Z]{3}$'),
    country text check (country ~ '^[A-Z]{2}$'),
    status text not null default 'created',
    routing jsonb not null default '{}',
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.transactions (
    id text primary key default gen_random_uuid()::text,
    seller_id text not null references public.seller_profiles(id),
    offer_id text,
    foreign key (seller_id,offer_id) references public.offers(seller_id,id),
    amount bigint not null check (amount > 0),
    currency text not null check (currency ~ '^[A-Z]{3}$'),
    method text not null,
    status text not null default 'pending',
    provider_status text,
    provider text,
    provider_account_id text,
    provider_transaction_id text,
    external_reference text,
    idempotency_key text,
    metadata jsonb not null default '{}',
    risk_level text,
    amount_usd_net_cents bigint,
    amount_usd_gross_cents bigint,
    fx_fee_cents bigint,
    fx_rate numeric(24,12),
    fee bigint,
    chargeback_protection_fee bigint,
    net_amount bigint,
    reserve_amount bigint,
    fee_breakdown jsonb,
    fee_tier_version_id uuid references public.fee_tier_versions(id),
    external_fee_cents bigint,
    external_fee_pct numeric(9,4),
    external_fee_recipient_id text references public.seller_profiles(id),
    customer_name text,
    customer_email text,
    customer_phone text,
    customer_document text,
    customer_country text,
    payment_last4 text,
    payment_brand text,
    ip text,
    user_agent text,
    device_id text,
    session_id text,
    postback_url text,
    webhook_sent boolean not null default false,
    webhook_status text not null default 'pending',
    webhook_attempts integer not null default 0,
    last_webhook_at timestamptz,
    failure_code text,
    failure_message text,
    available_at timestamptz,
    reserve_until timestamptz,
    approved_at timestamptz,
    processed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create unique index transactions_seller_idempotency_uidx
    on public.transactions(seller_id, idempotency_key) where idempotency_key is not null;
create unique index transactions_provider_object_uidx
    on public.transactions(provider, provider_account_id, provider_transaction_id)
    where provider_transaction_id is not null and provider_account_id is not null;
create index transactions_seller_created_idx on public.transactions(seller_id, created_at desc);

create table public.transaction_attempts (
    id uuid primary key default gen_random_uuid(),
    transaction_id text not null references public.transactions(id),
    provider_account_id text,
    provider text,
    status text,
    failure_code text,
    failure_message text,
    created_at timestamptz not null default now()
);
create index transaction_attempts_transaction_idx on public.transaction_attempts(transaction_id);

create table public.stripe_webhook_events (
    event_id text primary key,
    account_id text not null,
    event_type text not null,
    created_at timestamptz not null default now()
);

create table public.gw_embed_origins (
    seller_id text not null references public.seller_profiles(id),
    origin text not null,
    wildcard boolean not null default false,
    status text not null default 'inactive',
    primary key (seller_id, origin)
);

create table public.wallet_balance (
    seller_id text primary key references public.seller_profiles(id),
    available_balance bigint not null default 0,
    pending_balance bigint not null default 0,
    reserved_balance bigint not null default 0,
    updated_at timestamptz not null default now()
);

create table public.wallet_ledger (
    id uuid primary key default gen_random_uuid(),
    seller_id text not null references public.seller_profiles(id),
    transaction_id text not null,
    type text not null,
    amount bigint not null,
    currency text not null check (currency ~ '^[A-Z]{3}$'),
    status text not null,
    fee bigint,
    available_at timestamptz,
    completed_at timestamptz,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(transaction_id, type)
);
create index wallet_ledger_seller_created_idx on public.wallet_ledger(seller_id,created_at desc);

create table public.xpay_orbia_merchants (
    seller_id text primary key references public.seller_profiles(id),
    orbia_installation text not null,
    orbia_org_id uuid not null,
    created_at timestamptz not null default now(),
    unique(orbia_installation, orbia_org_id)
);

create table public.xpay_orbia_products (
    seller_id text not null references public.xpay_orbia_merchants(seller_id),
    orbia_product_id uuid not null,
    offer_id text not null,
    foreign key (seller_id,offer_id) references public.offers(seller_id,id),
    primary key (seller_id,orbia_product_id),
    unique(seller_id,offer_id)
);

create table public.xpay_event_outbox (
    id uuid primary key default gen_random_uuid(),
    seller_id text not null references public.seller_profiles(id),
    event_key text not null,
    event_type text not null,
    body jsonb not null,
    created_at timestamptz not null default now(),
    next_attempt_at timestamptz not null default now(),
    delivered_at timestamptz,
    attempts integer not null default 0 check (attempts >= 0),
    unique(seller_id,event_key)
);
create index xpay_event_outbox_due_idx on public.xpay_event_outbox(next_attempt_at)
    where delivered_at is null;

-- Expose no table directly to browsers. The API authenticates and enforces tenancy.
alter table public.users enable row level security;
revoke all on table public.users from public, anon, authenticated;
grant select, insert, update, delete on table public.users to service_role;
alter table public.seller_profiles enable row level security;
revoke all on table public.seller_profiles from public, anon, authenticated;
grant select, insert, update, delete on table public.seller_profiles to service_role;
alter table public.api_keys enable row level security;
revoke all on table public.api_keys from public, anon, authenticated;
grant select, insert, update, delete on table public.api_keys to service_role;
alter table public.fee_tiers enable row level security;
revoke all on table public.fee_tiers from public, anon, authenticated;
grant select, insert, update, delete on table public.fee_tiers to service_role;
alter table public.fee_tier_versions enable row level security;
revoke all on table public.fee_tier_versions from public, anon, authenticated;
grant select, insert, update, delete on table public.fee_tier_versions to service_role;
alter table public.seller_fees enable row level security;
revoke all on table public.seller_fees from public, anon, authenticated;
grant select, insert, update, delete on table public.seller_fees to service_role;
alter table public.stripe_accounts enable row level security;
revoke all on table public.stripe_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.stripe_accounts to service_role;
alter table public.account_daily_metrics enable row level security;
revoke all on table public.account_daily_metrics from public, anon, authenticated;
grant select, insert, update, delete on table public.account_daily_metrics to service_role;
alter table public.payment_method_routes enable row level security;
revoke all on table public.payment_method_routes from public, anon, authenticated;
grant select, insert, update, delete on table public.payment_method_routes to service_role;
alter table public.payment_method_route_history enable row level security;
revoke all on table public.payment_method_route_history from public, anon, authenticated;
grant select, insert, update, delete on table public.payment_method_route_history to service_role;
alter table public.offers enable row level security;
revoke all on table public.offers from public, anon, authenticated;
grant select, insert, update, delete on table public.offers to service_role;
alter table public.checkout_sessions enable row level security;
revoke all on table public.checkout_sessions from public, anon, authenticated;
grant select, insert, update, delete on table public.checkout_sessions to service_role;
alter table public.transactions enable row level security;
revoke all on table public.transactions from public, anon, authenticated;
grant select, insert, update, delete on table public.transactions to service_role;
alter table public.transaction_attempts enable row level security;
revoke all on table public.transaction_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.transaction_attempts to service_role;
alter table public.stripe_webhook_events enable row level security;
revoke all on table public.stripe_webhook_events from public, anon, authenticated;
grant select, insert, update, delete on table public.stripe_webhook_events to service_role;
alter table public.gw_embed_origins enable row level security;
revoke all on table public.gw_embed_origins from public, anon, authenticated;
grant select, insert, update, delete on table public.gw_embed_origins to service_role;
alter table public.wallet_balance enable row level security;
revoke all on table public.wallet_balance from public, anon, authenticated;
grant select, insert, update, delete on table public.wallet_balance to service_role;
alter table public.wallet_ledger enable row level security;
revoke all on table public.wallet_ledger from public, anon, authenticated;
grant select, insert, update, delete on table public.wallet_ledger to service_role;
alter table public.xpay_orbia_merchants enable row level security;
revoke all on table public.xpay_orbia_merchants from public, anon, authenticated;
grant select, insert, update, delete on table public.xpay_orbia_merchants to service_role;
alter table public.xpay_orbia_products enable row level security;
revoke all on table public.xpay_orbia_products from public, anon, authenticated;
grant select, insert, update, delete on table public.xpay_orbia_products to service_role;
alter table public.xpay_event_outbox enable row level security;
revoke all on table public.xpay_event_outbox from public, anon, authenticated;
grant select, insert, update, delete on table public.xpay_event_outbox to service_role;

-- Preserve the historical names without assigning unapproved tariffs.
insert into public.fee_tiers(code, label) values
    ('NEW','New'), ('C','Tier C'), ('B','Tier B'), ('A','Tier A'), ('AAA','Tier AAA');
