# Whop Master-to-Seller Payouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Koopfy-owned withdrawal flow in which seller funds are reserved at request time and a single, idempotent Whop payout from the master account to the seller's connected account is created only after CRM approval.

**Architecture:** `backend/apps/pay` owns payout state, fee snapshots, connected-account references, provider calls, ledger transitions, webhooks, and reconciliation. `backend-embed/apps/checkout` remains a narrow authenticated facade; `dash-checkout` renders the seller setup/quote/confirmation flow; `dash-pay` renders CRM review, fee configuration, dispatch, and recovery controls. Supabase RPCs make every balance mutation and state claim atomic, while Whop quote tokens remain in memory and provider identifiers never reach the seller client.

**Tech Stack:** NestJS 11/10, TypeScript 5.x, Jest 29, PostgreSQL/Supabase with pgTAP, Next.js 16, React 18/19, Node test runner, Whop Current REST API.

**Spec:** `docs/superpowers/specs/2026-09-21-whop-master-seller-payouts-design.md`

## Global Constraints

- No money-moving Whop request occurs before CRM approval.
- The Whop Current API version is pinned to `2026-09-15` through `WHOP_API_VERSION_DATE`.
- Every mutating provider call has a deterministic `Idempotency-Key`; retries for one execution never create a new key.
- Payout quote and creation use `platform_covers_fees: false`.
- The amount entered by the seller is the gross amount removed from the Koopfy wallet.
- Initial Koopfy fee rules are: Pix `200 bps + 300 USD cents`; Bank Wire `100 bps + 300`; ACH Instant `100 bps + 300`; ACH Next Day `50 bps + 300`; ACH Standard `50 bps + 300`; crypto `150 bps + 300`.
- Seller-facing responses show one consolidated withdrawal fee and never expose Whop names, provider IDs, provider fee composition, Koopfy margin, credentials, or operational terminology.
- CRM responses may show provider cost and Koopfy revenue separately, but never return credentials, quote tokens, or raw payout/KYC fields.
- Raw bank, Pix, crypto wallet, tax, document, and identity values are transient: forward them to Whop, then discard them without logging, analytics, audit, ledger metadata, or database persistence.
- Seller identity always comes from authenticated server context; ignore any client-supplied seller or connected-account ID.
- New public-schema tables enable RLS, grant no browser access, explicitly grant only `service_role`, and database functions revoke `PUBLIC`, `anon`, and `authenticated` execution.
- Newly approved sellers are provisioned after local approval; existing sellers are provisioned lazily when they open payout setup. External provisioning failure never rolls back local approval.
- Legacy pending withdrawals stay on the existing manual workflow unless explicitly migrated; this release performs no bulk migration or bulk connected-account provisioning.
- Legally required provider/compliance disclosures on hosted verification surfaces remain visible even though Koopfy-owned screens use Koopfy terminology.
- Existing dirty files in `dash-checkout` (`next-env.d.ts`, `tsconfig.tsbuildinfo`) and `dash-pay` (`.env.development`, `.env.production`, `next.config.ts`) belong to the user and must not be staged or overwritten.
- Rollout stays fail-closed behind `KOOPFY_WHOP_MASTER_PAYOUTS_ENABLED`; the existing `KOOPFY_UNIFIED_PAYOUTS_ENABLED` flag alone must not enable provider dispatch.
- Preview confirmation fields are bound to the authenticated seller with `HMAC-SHA-256` using the server-only `PAYOUT_PREVIEW_HMAC_SECRET`; the signed proof contains no provider quote token and expires with the preview.
- `KOOPFY_SUPABASE_TEST_DB_URL` must point to a disposable non-production database before database tests or migration pushes run.

## Review Focus

- Two admins approve the same request concurrently: exactly one claim succeeds and Whop receives one create call.
- Whop accepts a payout but the local write times out: reconciliation reuses the same key, records the original provider payout, and finalizes the ledger once.
- A refreshed approval quote is worse than the seller-confirmed minimum: no money is sent, the reservation remains, and the seller must reconfirm.
- A failure/reversal event is duplicated or arrives after a terminal event: funds are restored once only after `funds_returned_at` is confirmed, and terminal state never regresses.
- A seller submits another seller's saved method or injects raw destination fields into confirmation: the request is rejected and no sensitive value is persisted or returned.

---

## Repository Boundaries and File Map

### `backend/apps/pay` — source of truth

- Create `src/payouts/payout.types.ts`: stable domain and public response types.
- Create `src/payouts/payout-domain.ts`: integer fee math, state mapping, transition guards, masking, and deterministic keys.
- Create `src/payouts/whop-payout.client.ts`: validated, redacted Whop Current API transport.
- Create `src/payouts/seller-payout-account.service.ts`: connected-account provisioning, verification, saved methods, readiness.
- Create `src/payouts/payout-orchestrator.service.ts`: preview, reservation, approval, dispatch, rejection, reconfirmation, recovery.
- Create `src/payouts/whop-payout-webhook.service.ts`: payout event resolution and forward-only state application.
- Create `src/payouts/payout-reconciler.service.ts`: scheduled repair for stale dispatching/processing executions.
- Create `src/payouts/payout.module.ts`: isolated module wiring and exports.
- Create co-located Jest specs for every service/domain file.
- Modify `src/integration/koopfy-finance.controller.ts` and `.service.ts`: safe seller payout APIs.
- Modify `src/crm/crm-admin.controller.ts`, `.service.ts`, `crm.service.ts`, and `crm.module.ts`: fee rules, readiness, approve/send, retry/reconcile, provisioning hook.
- Modify `src/webhooks/webhook.service.ts` and `webhook.module.ts`: route signed payout events before payment mapping.
- Modify `src/app.module.ts`: register `PayoutModule` once.
- Create the timestamped migration emitted by `supabase migration new whop_master_seller_payouts` and `supabase/tests/whop_master_seller_payouts.test.sql`: tables, seeds, RPCs, grants, RLS, atomicity tests.

### `backend-embed/apps/checkout` — authenticated facade

- Modify `src/finance/finance.types.ts`: strict allowlists for setup, preview, confirmation, and reconfirmation bodies.
- Modify `src/finance/finance-client.service.ts`: fixed upstream methods for the new Pay endpoints.
- Modify `src/finance/finance.controller.ts`: guarded `/finance/payout-*` routes.
- Modify `src/finance/finance.types.spec.ts`, `finance-client.service.spec.ts`, and `finance.controller.spec.ts`: identity stripping, fixed routing, and safe error propagation.

### `dash-checkout` — seller experience

- Replace raw-destination submission logic in `lib/finance/payout-request.ts` with readiness/method/preview/confirmation contracts and pure view helpers.
- Modify `lib/finance/payout-request.test.mjs`: quote invariants, status copy, dynamic field validation, and no raw fields in confirm payloads.
- Modify `components/finance/withdraw-dialog.tsx`: setup, saved method selection, amount, live preview, confirmation, pending/requote states, mobile behavior.
- Modify `app/finance/wallet/page.tsx` and `hooks/use-finance.ts`: readiness/history refresh and reconfirm actions.
- Modify `lib/koopfy-payments-state.ts` and its test: enable only when both Koopfy rollout flags/readiness permit.

### `dash-pay` — CRM experience

- Create `src/lib/payout-admin.ts` and `src/lib/payout-admin.test.mjs`: status/readiness/action/fee presentation helpers.
- Modify `src/components/admin-panel.tsx`: fee rule editor, fee breakdown, readiness blocker, approve/send, retry/reconcile, privileged fallback.
- Modify `package.json`: add a narrow Node test script for the new pure helper without changing runtime dependencies.

## Public Contracts Used Across Tasks

```ts
type PayoutLocalState =
  | 'pending_review' | 'dispatching' | 'processing' | 'completed'
  | 'failed' | 'canceled' | 'denied' | 'reversed' | 'rejected'
  | 'requote_required' | 'dispatch_failed';

type PayoutReadiness = {
  status: 'provisioning' | 'verification_required' | 'under_review' | 'ready' | 'restricted' | 'error';
  payoutsEnabled: boolean;
  verificationActionUrl: string | null;
  blockerCode: string | null;
  blockerMessage: string | null;
  methods: PublicSavedPayoutMethod[];
};

type PublicSavedPayoutMethod = {
  id: string; methodKey: 'pix' | 'bank_wire' | 'ach_instant' | 'ach_next_day' | 'ach_standard' | 'crypto';
  label: string; maskedReference: string; currency: string | null;
  country: string | null; network: string | null; speeds: string[];
  isDefault: boolean; status: 'active' | 'inactive' | 'restricted';
};

type PayoutPreview = {
  methodId: string; methodKey: PublicSavedPayoutMethod['methodKey']; speed: string | null;
  grossMinor: number; consolidatedFeeMinor: number; netMinor: number;
  sourceCurrency: 'USD'; destinationCurrency: string; destinationAmountMinor: number;
  exchangeRate: string | null; estimatedArrival: string | null; expiresAt: string;
  confirmationToken: string;
};

type ConfirmPayoutRequest = {
  methodId: string; speed: string | null; grossMinor: number;
  confirmedMinimumNetMinor: number; previewExpiresAt: string; confirmationToken: string;
};
```

The seller API returns only these public shapes. Provider IDs, provider/Koopfy fee split, quote IDs/tokens, and raw method fields stay in Pay/CRM.

### Task 1: Payout Domain Contract and Integer Fee Math

**Files:**
- Create: `src/payouts/payout.types.ts`
- Create: `src/payouts/payout-domain.ts`
- Test: `src/payouts/payout-domain.spec.ts`

**Interfaces:**
- Consumes: fee rule rows `{ method_key, percentage_bps, fixed_fee_usd_cents, enabled }` and provider status strings.
- Produces: `calculateKoopfyFee(grossMinor, rule)`, `providerPayoutMinor(grossMinor, feeMinor)`, `providerIdempotencyKey(payoutId)`, `signPreviewConfirmation(fields, sellerId, secret)`, `verifyPreviewConfirmation(fields, sellerId, token, secret)`, `mapWhopPayoutState(status)`, `canAdvanceState(from, to)`, and `canRestoreFunds(execution)`.

- [ ] **Step 1: Write failing domain tests**

```ts
it('rounds percentage up and adds the fixed fee', () => {
  expect(calculateKoopfyFee(11990, { percentageBps: 200, fixedUsdCents: 300 })).toBe(540);
});

it('rejects a payout whose Koopfy fee consumes the gross amount', () => {
  expect(() => providerPayoutMinor(300, 300)).toThrow('valor líquido');
});

it('does not regress a terminal payout and restores only confirmed returned funds', () => {
  expect(canAdvanceState('completed', 'processing')).toBe(false);
  expect(canRestoreFunds({ state: 'failed', fundsReturnedAt: null, walletRestoredAt: null })).toBe(false);
  expect(canRestoreFunds({ state: 'reversed', fundsReturnedAt: '2026-09-21T12:00:00Z', walletRestoredAt: null })).toBe(true);
});

it('binds the preview to seller, amount, method, minimum net, and expiry', () => {
  const previewFields = {
    methodId: 'method-1', speed: 'standard', grossMinor: 11990,
    confirmedMinimumNetMinor: 10810, previewExpiresAt: '2026-09-21T15:00:00Z',
  };
  const token = signPreviewConfirmation(previewFields, 'seller-1', 'test-secret-at-least-32-bytes-long');
  expect(verifyPreviewConfirmation(previewFields, 'seller-1', token, 'test-secret-at-least-32-bytes-long')).toBe(true);
  expect(verifyPreviewConfirmation({ ...previewFields, grossMinor: 12000 }, 'seller-1', token, 'test-secret-at-least-32-bytes-long')).toBe(false);
  expect(verifyPreviewConfirmation(previewFields, 'seller-2', token, 'test-secret-at-least-32-bytes-long')).toBe(false);
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `pnpm test -- --runInBand src/payouts/payout-domain.spec.ts`

Expected: FAIL with `Cannot find module './payout-domain'`.

- [ ] **Step 3: Implement types and pure functions using integer minor units**

```ts
export function calculateKoopfyFee(grossMinor: number, rule: FeeRule): number {
  assertMinor(grossMinor);
  return Math.ceil((grossMinor * rule.percentageBps) / 10_000) + rule.fixedUsdCents;
}

export function providerIdempotencyKey(payoutId: string): string {
  return `koopfy_payout_${createHash('sha256').update(payoutId).digest('hex').slice(0, 40)}`;
}
```

Implement an exhaustive provider mapping for `requested`, `in_review`, `processing`, `completed`, `failed`, `canceled`, `denied`, and `reversed`. Unknown states throw a sanitized domain error and never guess a terminal outcome.

- [ ] **Step 4: Run focused tests**

Run: `pnpm test -- --runInBand src/payouts/payout-domain.spec.ts`

Expected: PASS, including all five Review Focus transition/restoration cases owned by this module.

- [ ] **Step 5: Commit**

```bash
git add src/payouts/payout.types.ts src/payouts/payout-domain.ts src/payouts/payout-domain.spec.ts
git commit -m "feat(pay): add payout domain invariants"
```

### Task 2: Atomic Supabase Schema, Reservations, Claims, and Restoration

**Files:**
- Create with CLI: the exact `supabase/migrations/*_whop_master_seller_payouts.sql` path printed by `supabase migration new whop_master_seller_payouts`
- Create: `supabase/tests/whop_master_seller_payouts.test.sql`

**Interfaces:**
- Consumes: existing `wallet_balance`, `wallet_ledger`, `request_payout`, `transfer_balance`, `credit_balance`, and service-role backend access.
- Produces: tables `seller_payout_accounts`, `seller_payout_methods`, `payout_fee_rules`, `payout_executions`; RPCs `request_provider_payout_idempotent`, `claim_payout_dispatch`, `release_payout_reservation`, `finalize_payout_outflow`, `restore_provider_payout_funds`, `requeue_requoted_payout`.

- [ ] **Step 1: Inspect the deployed base contract before writing SQL**

Run these read-only queries in the non-production Supabase SQL editor:

```sql
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('request_payout','transfer_balance','credit_balance');

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('wallet_balance','wallet_ledger')
order by table_name, ordinal_position;
```

Expected: one unambiguous signature per function and the exact ledger/balance columns needed by the migration. Stop before schema changes if production differs from the preconditions recorded in the existing idempotency migration.

- [ ] **Step 2: Generate the migration with the installed Supabase CLI**

Run: `../../../dash-checkout/node_modules/.bin/supabase migration new whop_master_seller_payouts`

Expected: one new timestamped SQL file under `supabase/migrations/`; use that exact generated filename in every later command and commit.

- [ ] **Step 3: Write failing pgTAP coverage first**

```sql
begin;
select plan(16);
select has_table('public', 'payout_executions');
select is(
  (select relrowsecurity from pg_class where oid = 'public.payout_executions'::regclass),
  true,
  'payout_executions has RLS enabled'
);
select function_privs_are(
  'public', 'claim_payout_dispatch', array['uuid','uuid'],
  'service_role', array['EXECUTE'],
  'only service_role can claim a dispatch'
);
select is(
  (select count(*)::int from public.payout_fee_rules where enabled),
  6,
  'six default fee rules are seeded'
);
select * from finish();
rollback;
```

Continue the pgTAP file with concrete wallet fixtures and assertions:

```sql
select lives_ok($$ select public.request_provider_payout_idempotent(
  'seller-pgtap', 'request_12345678', repeat('a', 64), 'method-pgtap',
  11990, 540, 11450, 10810, 'ach_standard', 'standard', 'USD', 'USD',
  'koopfy_payout_pgtap'
) $$, 'request atomically reserves the gross amount');
select is((select available_balance from public.wallet_balance where seller_id = 'seller-pgtap'), 88010::bigint, 'available decreases by gross');
select is((select withdrawing_balance from public.wallet_balance where seller_id = 'seller-pgtap'), 11990::bigint, 'gross enters withdrawing');
select is((select count(*)::int from public.payout_executions where seller_id = 'seller-pgtap'), 1, 'idempotent replay creates one execution');
select is((select count(*)::int from claim_results where claimed), 1, 'concurrent compare-and-set has one winner');
select is((select count(*)::int from restoration_results where restored), 1, 'returned funds credit happens once');
```

Create `claim_results` and `restoration_results` as temporary tables populated by two calls to their RPCs in the same test transaction; call restoration once without `funds_returned_at` and assert `restored = false`, then twice with the timestamp and assert one `true` result.

- [ ] **Step 4: Run the database test and verify schema failures**

Run: `../../../dash-checkout/node_modules/.bin/supabase test db supabase/tests/whop_master_seller_payouts.test.sql --db-url "$KOOPFY_SUPABASE_TEST_DB_URL"`

Expected: FAIL because the new tables and functions do not exist in the disposable non-production database.

- [ ] **Step 5: Implement the migration**

Use `bigint` minor-unit columns and checks such as:

```sql
create table public.payout_executions (
  id uuid primary key default gen_random_uuid(),
  ledger_entry_id text not null unique,
  seller_id text not null,
  seller_payout_method_id uuid not null references public.seller_payout_methods(id),
  method_key text not null,
  local_state text not null default 'pending_review',
  gross_minor bigint not null check (gross_minor > 0),
  koopfy_fee_minor bigint not null check (koopfy_fee_minor >= 0),
  provider_fee_minor bigint check (provider_fee_minor >= 0),
  provider_payout_minor bigint not null check (provider_payout_minor > 0),
  net_minor bigint not null check (net_minor >= 0),
  confirmed_minimum_net_minor bigint not null check (confirmed_minimum_net_minor >= 0),
  provider_idempotency_key text not null unique,
  provider_payout_id text unique,
  funds_returned_at timestamptz,
  wallet_restored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.payout_executions enable row level security;
revoke all on public.payout_executions from public, anon, authenticated;
grant select, insert, update on public.payout_executions to service_role;
```

Add these exact fields beyond the abbreviated table fragment: connected account ID; source/destination currency; delivery speed; destination amount; quote ID/expiry; exchange rate; estimated arrival; provider status/detail; error code/message; claimed/reviewed/dispatched/accepted/completed timestamps; funds-returned/restored timestamps; created/updated timestamps. Add unique constraints on provider account ID, provider method ID, ledger entry ID, provider idempotency key, and non-null provider payout ID; add indexes on `(local_state, updated_at)` and `(seller_id, created_at desc)`. Seed the six Global Constraint fee rows. Implement all six named RPCs so each sets `search_path = ''`, locks its wallet/execution row, validates the allowed source state, and revokes default execution before granting only `service_role`.

- [ ] **Step 6: Run pgTAP and advisors**

Run:

```bash
../../../dash-checkout/node_modules/.bin/supabase db push --db-url "$KOOPFY_SUPABASE_TEST_DB_URL" --dry-run
../../../dash-checkout/node_modules/.bin/supabase db push --db-url "$KOOPFY_SUPABASE_TEST_DB_URL" --yes
../../../dash-checkout/node_modules/.bin/supabase test db supabase/tests/whop_master_seller_payouts.test.sql --db-url "$KOOPFY_SUPABASE_TEST_DB_URL"
../../../dash-checkout/node_modules/.bin/supabase db advisors --db-url "$KOOPFY_SUPABASE_TEST_DB_URL" --type security --fail-on error
../../../dash-checkout/node_modules/.bin/supabase migration list --db-url "$KOOPFY_SUPABASE_TEST_DB_URL"
```

Expected: dry-run lists only the intended migration, 16/16 tests pass, no security errors, and the CLI-generated migration appears applied in the non-production history.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations supabase/tests/whop_master_seller_payouts.test.sql
git commit -m "feat(pay): add atomic provider payout ledger"
```

### Task 3: Validated Whop Current API Client

**Files:**
- Create: `src/payouts/whop-payout.client.ts`
- Test: `src/payouts/whop-payout.client.spec.ts`
- Modify: `src/orchestrator/whop/whop-accounts.service.ts`
- Test: `src/orchestrator/whop/whop-accounts.service.spec.ts`

**Interfaces:**
- Consumes: `WhopAccountsService.getById(process.env.WHOP_ENV_ACCOUNT_ID)` and server-only master `apiKey`/`accountId`.
- Produces: `createConnectedAccount`, `createVerificationSession`, `listVerifications`, `listSupportedPayoutMethods`, `listSavedPayoutMethods`, `createSavedPayoutMethod`, `deleteSavedPayoutMethod`, `createQuote`, `createPayout`, `retrievePayout`.

- [ ] **Step 1: Write failing transport tests**

```ts
it('pins version and idempotency without leaking the API key', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'wdrl_1', status: 'processing' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  await client.createPayout({
    accountId: 'biz_1', payoutMethodId: 'potk_1', quoteToken: 'quote_secret',
    platformCoversFees: false, metadata: { koopfy_payout_id: 'payout-1' },
  }, 'koopfy_payout_abc');
  expect(fetchMock).toHaveBeenCalledWith('https://api.whop.com/api/v1/payouts', expect.objectContaining({
    method: 'POST',
    headers: expect.objectContaining({ 'Api-Version-Date': '2026-09-15', 'Idempotency-Key': 'koopfy_payout_abc' }),
  }));
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('quote_secret');
});

it('maps 409 to an idempotency replay and sanitizes 401/422 responses', async () => {
  // Assert typed code/status only; response bodies and submitted fields are absent.
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- --runInBand src/payouts/whop-payout.client.spec.ts`

Expected: FAIL because `WhopPayoutClient` does not exist.

- [ ] **Step 3: Implement one private transport and strict response parsers**

```ts
private async request<T>(path: string, init: RequestInit & { idempotencyKey?: string }): Promise<T> {
  const account = await this.accounts.getById(this.requireMasterAccountId());
  const response = await fetch(`${this.baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(this.timeoutMs),
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
      'Content-Type': 'application/json',
      'Api-Version-Date': this.apiVersionDate,
      ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
    },
  });
  return this.parseValidatedResponse(response);
}
```

Use explicit allowlist parsers instead of passing provider JSON through. Quote results include the token only in the returned in-memory object; no log statement serializes request or response bodies.

- [ ] **Step 4: Run client and existing account tests**

Run: `pnpm test -- --runInBand src/payouts/whop-payout.client.spec.ts src/orchestrator/whop/whop-accounts.service.spec.ts`

Expected: PASS for version pinning, timeouts, 4xx/5xx mapping, 409 recovery signal, malformed responses, and redaction.

- [ ] **Step 5: Commit**

```bash
git add src/payouts/whop-payout.client.ts src/payouts/whop-payout.client.spec.ts src/orchestrator/whop/whop-accounts.service.ts src/orchestrator/whop/whop-accounts.service.spec.ts
git commit -m "feat(pay): add Whop payout API client"
```

### Task 4: Connected Seller Accounts, Verification, and Vaulted Methods

**Files:**
- Create: `src/payouts/seller-payout-account.service.ts`
- Test: `src/payouts/seller-payout-account.service.spec.ts`
- Create: `src/payouts/payout.module.ts`
- Modify: `src/integration/koopfy-finance.controller.ts`
- Modify: `src/integration/koopfy-finance.service.ts`
- Test: `src/integration/koopfy-finance-payout.spec.ts`
- Modify: `src/crm/crm.service.ts`
- Modify: `src/crm/crm.module.ts`

**Interfaces:**
- Consumes: `WhopPayoutClient`, seller context, seller profile country/entity data, `seller_payout_accounts`, and `seller_payout_methods`.
- Produces: `getReadiness(sellerId)`, `ensureConnectedAccount(sellerId)`, `startVerification(sellerId, returnUrl)`, `syncReadiness(sellerId)`, `listSupportedMethods(sellerId)`, `createSavedMethod(sellerId, input)`, `removeSavedMethod(sellerId, localMethodId)`, `assertOwnedActiveMethod(sellerId, localMethodId)`.

- [ ] **Step 1: Write failing service/API tests**

```ts
it('provisions an existing seller once and stores only the connected account id', async () => {
  whop.createConnectedAccount.mockResolvedValue({ id: 'biz_1' });
  await Promise.all([service.ensureConnectedAccount('seller-1'), service.ensureConnectedAccount('seller-1')]);
  expect(whop.createConnectedAccount).toHaveBeenCalledTimes(1);
  expect(accountRepository.upsert).toHaveBeenCalledWith(expect.objectContaining({ providerAccountId: 'biz_1' }));
  expect(JSON.stringify(accountRepository.upsert.mock.calls)).not.toContain('identity');
});

it('forwards raw method fields once and persists only masked provider output', async () => {
  await service.createSavedMethod('seller-1', { supportedMethodId: 'podst_1', fields: { routing_number: '021000021' } });
  expect(methodRepository.upsert).toHaveBeenCalledWith(expect.objectContaining({ providerMethodId: 'potk_1', maskedReference: '••••6789' }));
  expect(JSON.stringify(methodRepository.upsert.mock.calls)).not.toContain('021000021');
});
```

Add this controller assertion for browser-supplied identity/provider fields:

```ts
await controller.createPayoutMethod({ sellerCtx: activeContext } as never, {
  supportedMethodId: 'podst_1', fields: { routing_number: '021000021' },
  sellerId: 'attacker', account_id: 'biz_attacker', provider_method_id: 'potk_attacker',
} as never);
expect(finance.createPayoutMethod).toHaveBeenCalledWith(activeContext, {
  supportedMethodId: 'podst_1', fields: { routing_number: '021000021' },
});
```

- [ ] **Step 2: Run and verify failures**

Run: `pnpm test -- --runInBand src/payouts/seller-payout-account.service.spec.ts src/integration/koopfy-finance-payout.spec.ts`

Expected: FAIL on missing service/routes.

- [ ] **Step 3: Implement readiness and safe seller routes**

Add these Pay routes:

```text
GET    /integration/koopfy/finance/payout-account
POST   /integration/koopfy/finance/payout-account/verification
POST   /integration/koopfy/finance/payout-account/sync
GET    /integration/koopfy/finance/payout-methods/supported
GET    /integration/koopfy/finance/payout-methods
POST   /integration/koopfy/finance/payout-methods
DELETE /integration/koopfy/finance/payout-methods/:id
```

`createSavedMethod` accepts `{ supportedMethodId, fields }`, forwards `fields`, zeroes the local reference after the call, and persists only provider-returned masked data. `getReadiness` lazily provisions existing active sellers. Add a post-approval best-effort call in `CrmService.approveSeller`; catch a typed provisioning error, persist actionable payout-account status, and keep the seller locally approved.

- [ ] **Step 4: Run focused and regression tests**

Run: `pnpm test -- --runInBand src/payouts/seller-payout-account.service.spec.ts src/integration/koopfy-finance-payout.spec.ts src/integration/koopfy-finance.controller.spec.ts`

Expected: PASS; no raw destination or provider identifiers appear in public readiness/method responses.

- [ ] **Step 5: Commit**

```bash
git add src/payouts src/integration/koopfy-finance.controller.ts src/integration/koopfy-finance.service.ts src/integration/koopfy-finance-payout.spec.ts src/crm/crm.service.ts src/crm/crm.module.ts
git commit -m "feat(pay): add seller payout onboarding"
```

### Task 5: Seller Preview, Confirmation, Reservation, and Requote

**Files:**
- Create: `src/payouts/payout-orchestrator.service.ts`
- Test: `src/payouts/payout-orchestrator.service.spec.ts`
- Modify: `src/integration/koopfy-finance.controller.ts`
- Modify: `src/integration/koopfy-finance.service.ts`
- Test: `src/integration/koopfy-finance-payout.spec.ts`
- Modify: `src/dashboard/services/services.ts`
- Modify: `src/dashboard/dto/request-payout.dto.ts`

**Interfaces:**
- Consumes: fee rule, owned saved method, Whop quote, seller wallet, RPC `request_provider_payout_idempotent`.
- Produces: `preview(sellerId, input): Promise<PayoutPreview>`, `confirm(sellerId, input, key)`, `reconfirm(sellerId, payoutId, confirmedMinimumNetMinor, key)`, and public payout history mapping.

- [ ] **Step 1: Write failing orchestration tests**

```ts
it('previews fees without reserving funds or creating a payout', async () => {
  whop.createQuote.mockResolvedValue({
    quoteId: 'quote-1', quoteToken: 'quote_secret', providerFeeMinor: 640,
    netMinor: 10810, destinationCurrency: 'USD', destinationAmountMinor: 10810,
    exchangeRate: null, estimatedArrival: '2026-09-23', expiresAt: '2026-09-21T15:00:00Z',
  });
  await service.preview('seller-1', { methodId: 'local-method-1', speed: 'standard', grossMinor: 11990 });
  expect(whop.createQuote).toHaveBeenCalledWith(expect.objectContaining({ amount: 11450, platformCoversFees: false }));
  expect(supabase.rpc).not.toHaveBeenCalled();
  expect(whop.createPayout).not.toHaveBeenCalled();
});

it('rejects confirmation when the fresh net is below the shown minimum', async () => {
  whop.createQuote.mockResolvedValue({
    quoteId: 'quote-2', quoteToken: 'quote_secret', providerFeeMinor: 750,
    netMinor: 10700, destinationCurrency: 'USD', destinationAmountMinor: 10700,
    exchangeRate: null, estimatedArrival: '2026-09-24', expiresAt: '2026-09-21T15:05:00Z',
  });
  await expect(service.confirm('seller-1', {
    methodId: 'local-method-1', speed: 'standard', grossMinor: 11990,
    confirmedMinimumNetMinor: 10800, previewExpiresAt: '2026-09-21T15:00:00Z',
    confirmationToken: 'signed-preview',
  }, 'payout_request_12345678')).rejects.toMatchObject({ status: 409 });
  expect(supabase.rpc).not.toHaveBeenCalled();
});
```

Add Review Focus coverage for another seller's method and injected `fields`/raw account properties.

- [ ] **Step 2: Run and verify failures**

Run: `pnpm test -- --runInBand src/payouts/payout-orchestrator.service.spec.ts src/integration/koopfy-finance-payout.spec.ts`

Expected: FAIL on missing preview/confirm behavior.

- [ ] **Step 3: Implement preview and confirm without persisting quote tokens**

Add routes:

```text
POST /integration/koopfy/finance/payout-preview
POST /integration/koopfy/finance/payouts
POST /integration/koopfy/finance/payouts/:id/reconfirm
```

Confirmation receives only the public `ConfirmPayoutRequest`, obtains a fresh quote, requires `netMinor >= confirmedMinimumNetMinor`, snapshots both fee components/FX/ETA in `payout_executions`, and invokes the reservation RPC. The short-lived quote token falls out of scope after confirmation; it is never written. Return `{ payoutId, status: 'pending_review', replayed }`.

Before quoting or reserving, verify `confirmationToken` in constant time against the authenticated seller and the exact `methodId`, `speed`, `grossMinor`, `confirmedMinimumNetMinor`, and `previewExpiresAt`. Reject expired or altered previews with 409. Generate the HMAC from a canonical field ordering; require `PAYOUT_PREVIEW_HMAC_SECRET` to be at least 32 bytes and fail closed when absent.

- [ ] **Step 4: Run focused tests and inspect secret/raw-field absence**

Run: `pnpm test -- --runInBand src/payouts/payout-orchestrator.service.spec.ts src/integration/koopfy-finance-payout.spec.ts`

Expected: PASS; request phase performs zero `createPayout` calls, reserves the exact gross once, and public JSON snapshots contain no `biz_`, `potk_`, quote token, routing number, Pix key, or wallet address.

- [ ] **Step 5: Commit**

```bash
git add src/payouts/payout-orchestrator.service.ts src/payouts/payout-orchestrator.service.spec.ts src/integration src/dashboard/services/services.ts src/dashboard/dto/request-payout.dto.ts
git commit -m "feat(pay): reserve reviewed seller payouts"
```

### Task 6: Checkout Backend Facade for the New Seller Contract

**Repository:** `/Users/lucas/koopfy/backend-embed`

**Files:**
- Modify: `apps/checkout/src/finance/finance.types.ts`
- Modify: `apps/checkout/src/finance/finance.types.spec.ts`
- Modify: `apps/checkout/src/finance/finance-client.service.ts`
- Modify: `apps/checkout/src/finance/finance-client.service.spec.ts`
- Modify: `apps/checkout/src/finance/finance.controller.ts`
- Modify: `apps/checkout/src/finance/finance.controller.spec.ts`

**Interfaces:**
- Consumes: Pay routes from Tasks 4–5 and the authenticated workspace token.
- Produces: same paths below `/finance`, with fixed upstream paths, encoded resource IDs, strict body picks, and forwarded idempotency headers.

- [ ] **Step 1: Write failing body-allowlist and routing tests**

```ts
expect(pickPayoutConfirmation({
  methodId: 'method-1', speed: 'standard', grossMinor: 11990,
  confirmedMinimumNetMinor: 10800, previewExpiresAt: '2026-09-21T15:00:00Z', confirmationToken: 'signed-preview',
  sellerId: 'attacker', accountId: 'biz_attacker', routingNumber: 'secret',
})).toEqual({
  methodId: 'method-1', speed: 'standard', grossMinor: 11990,
  confirmedMinimumNetMinor: 10800, previewExpiresAt: '2026-09-21T15:00:00Z', confirmationToken: 'signed-preview',
});
```

Assert all fixed routes and that a method ID containing `../` is percent-encoded.

- [ ] **Step 2: Run and verify failures**

Run from `backend-embed`: `pnpm --dir apps/checkout test -- --runInBand finance.types.spec.ts finance-client.service.spec.ts finance.controller.spec.ts`

Expected: FAIL because the new pickers and methods are absent.

- [ ] **Step 3: Implement facade endpoints**

Mirror readiness, verification, supported/saved methods, preview, confirm, reconfirm, and history routes. Keep `authorize(request, workspaceId)` on every operational endpoint. Forward `fields` only on saved-method creation; confirmation never accepts `fields`. Update status capability so `payoutCreate` requires both `KOOPFY_UNIFIED_PAYOUTS_ENABLED` and `KOOPFY_WHOP_MASTER_PAYOUTS_ENABLED`.

- [ ] **Step 4: Run checkout facade tests and build**

Run:

```bash
pnpm --dir apps/checkout test -- --runInBand finance.types.spec.ts finance-client.service.spec.ts finance.controller.spec.ts
pnpm --dir apps/checkout build
```

Expected: PASS and successful Nest build.

- [ ] **Step 5: Commit only facade files in `backend-embed`**

```bash
git add apps/checkout/src/finance/finance.types.ts apps/checkout/src/finance/finance.types.spec.ts apps/checkout/src/finance/finance-client.service.ts apps/checkout/src/finance/finance-client.service.spec.ts apps/checkout/src/finance/finance.controller.ts apps/checkout/src/finance/finance.controller.spec.ts
git commit -m "feat(checkout): proxy seller payout workflow"
```

### Task 7: CRM Approval Dispatch, Fee Rules, and Recovery APIs

**Repository:** `/Users/lucas/koopfy/backend/apps/pay`

**Files:**
- Modify: `src/payouts/payout-orchestrator.service.ts`
- Modify: `src/payouts/payout-orchestrator.service.spec.ts`
- Modify: `src/crm/crm-admin.controller.ts`
- Modify: `src/crm/crm-admin.service.ts`
- Create: `src/crm/crm-admin-payout.spec.ts`
- Modify: `src/crm/crm.module.ts`

**Interfaces:**
- Consumes: claim/finalize/release RPCs, readiness service, fresh Whop quote, deterministic execution key.
- Produces: `approveAndDispatch`, `reject`, `retryDispatch`, `reconcileOne`, `cancelBeforeAcceptance`, fee-rule list/update, and safe CRM detail DTOs.

- [ ] **Step 1: Write failing concurrency and dispatch tests**

```ts
it('lets only one concurrent admin dispatch the payout', async () => {
  const execution = { id: 'payout-1', state: 'dispatching', providerIdempotencyKey: 'koopfy_payout_abc' };
  const adminA = { managerId: 'admin-a', role: 'admin' };
  const adminB = { managerId: 'admin-b', role: 'admin' };
  claimRpc.mockResolvedValueOnce(execution).mockResolvedValueOnce(null);
  await Promise.allSettled([
    service.approveAndDispatch('payout-1', adminA),
    service.approveAndDispatch('payout-1', adminB),
  ]);
  expect(whop.createPayout).toHaveBeenCalledTimes(1);
});

it('moves to requote_required without payout creation when net deteriorates', async () => {
  whop.createQuote.mockResolvedValue({
    quoteId: 'quote-2', quoteToken: 'quote_secret', providerFeeMinor: 651,
    netMinor: 10799, destinationCurrency: 'USD', destinationAmountMinor: 10799,
    exchangeRate: null, estimatedArrival: '2026-09-24', expiresAt: '2026-09-21T15:05:00Z',
  });
  await expect(service.approveAndDispatch('payout-1', {
    managerId: 'admin-a', role: 'admin',
  })).resolves.toMatchObject({ state: 'requote_required' });
  expect(whop.createPayout).not.toHaveBeenCalled();
  expect(releaseReservationRpc).not.toHaveBeenCalled();
});
```

Pin the error matrix with a table-driven test:

```ts
it.each([
  [422, 'dispatch_failed', false],
  [401, 'dispatch_failed', false],
  [403, 'dispatch_failed', false],
  [500, 'dispatching', true],
  ['timeout', 'dispatching', true],
])('maps provider failure %s to %s', async (failure, expectedState, retryable) => {
  whop.createPayout.mockRejectedValue(providerFailure(failure));
  await service.approveAndDispatch('payout-1', { managerId: 'admin-a', role: 'admin' });
  expect(executionRepository.updateState).toHaveBeenCalledWith('payout-1', expectedState, expect.objectContaining({ retryable }));
});

it('retrieves the original payout after a provider 409', async () => {
  whop.createPayout.mockRejectedValue(providerFailure(409));
  whop.retrievePayout.mockResolvedValue({ id: 'wdrl_original', status: 'processing' });
  await service.approveAndDispatch('payout-1', { managerId: 'admin-a', role: 'admin' });
  expect(finalizeRpc).toHaveBeenCalledTimes(1);
});

it('leaves an accepted payout recoverable when local finalization fails', async () => {
  whop.createPayout.mockResolvedValue({ id: 'wdrl_1', status: 'processing' });
  finalizeRpc.mockRejectedValue(new Error('database unavailable'));
  await expect(service.approveAndDispatch('payout-1', { managerId: 'admin-a', role: 'admin' })).rejects.toThrow('database unavailable');
  expect(executionRepository.lastWrittenProviderId).toBe('wdrl_1');
});
```

Define `providerFailure` in the spec as a small test helper returning the client's typed sanitized error for the supplied status.

- [ ] **Step 2: Run and verify failures**

Run: `pnpm test -- --runInBand src/payouts/payout-orchestrator.service.spec.ts src/crm/crm-admin-payout.spec.ts`

Expected: FAIL on missing admin orchestration and routes.

- [ ] **Step 3: Implement approval and CRM routes**

```text
GET   /crm/admin/payout-fees
PATCH /crm/admin/payout-fees/:methodKey
POST  /crm/admin/withdrawals/:id/approve
POST  /crm/admin/withdrawals/:id/reject
POST  /crm/admin/withdrawals/:id/retry
POST  /crm/admin/withdrawals/:id/reconcile
POST  /crm/admin/withdrawals/:id/manual-override
```

`approve` becomes “claim, revalidate, requote, create, persist provider result, finalize ledger.” Fee updates accept integer `percentage_bps`, integer `fixed_fee_usd_cents`, `enabled`, and an effective timestamp. `manual-override` requires `{ action, reason }`, is admin-only, retrieves a known provider payout first, and writes a safe audit record. Existing mark-completed/mark-failed endpoints call the same guarded recovery path instead of directly moving money.

- [ ] **Step 4: Run tests**

Run: `pnpm test -- --runInBand src/payouts/payout-orchestrator.service.spec.ts src/crm/crm-admin-payout.spec.ts`

Expected: PASS, including the two-admin Review Focus case and the accepted-provider/local-write recovery case.

- [ ] **Step 5: Commit**

```bash
git add src/payouts/payout-orchestrator.service.ts src/payouts/payout-orchestrator.service.spec.ts src/crm
git commit -m "feat(pay): dispatch payouts after CRM approval"
```

### Task 8: Signed Payout Webhooks and Scheduled Reconciliation

**Files:**
- Create: `src/payouts/whop-payout-webhook.service.ts`
- Test: `src/payouts/whop-payout-webhook.service.spec.ts`
- Create: `src/payouts/payout-reconciler.service.ts`
- Test: `src/payouts/payout-reconciler.service.spec.ts`
- Modify: `src/webhooks/webhook.service.ts`
- Modify: `src/webhooks/webhook.module.ts`
- Modify: `src/payouts/payout.module.ts`
- Modify: `src/app.module.ts`
- Test: `src/webhooks/whop-renewal.spec.ts`

**Interfaces:**
- Consumes: verified raw-body event, metadata IDs, provider retrieval, finalization/restoration RPCs.
- Produces: `handles(eventType)`, `handleVerifiedEvent(event)`, `reconcileStaleExecutions(now)`, and scheduler cadence from `PAYOUT_RECONCILE_CRON`.

- [ ] **Step 1: Write failing event and reconciliation tests**

```ts
it.each(['payout.created', 'payout.updated', 'payout.reversed'])('routes %s before payment mapping', async (type) => {
  await webhook.handleVerifiedEvent({
    id: `evt_${type}`, type,
    data: { id: 'wdrl_1', metadata: { koopfy_payout_id: 'payout-1', koopfy_account_id: 'account-1' } },
  });
  expect(payoutHandler.handleVerifiedEvent).toHaveBeenCalledTimes(1);
  expect(paymentMapper).not.toHaveBeenCalled();
});

it('restores a reversed payout once across duplicate webhook and reconciler races', async () => {
  const reversed = {
    id: 'evt_reversed', type: 'payout.reversed',
    data: { id: 'wdrl_1', status: 'reversed', failure: { funds_returned_at: '2026-09-21T12:00:00Z' } },
  };
  restoreRpc.mockResolvedValueOnce({ restored: true }).mockResolvedValueOnce({ restored: false });
  await Promise.all([handler.handleVerifiedEvent(reversed), reconciler.reconcileOne('payout-1')]);
  expect(restoreRpc).toHaveBeenCalledTimes(2);
  expect(restoreRpc.mock.results.filter(result => result.value).length).toBe(2);
  await expect(Promise.all(restoreRpc.mock.results.map(result => result.value)))
    .resolves.toEqual(expect.arrayContaining([{ restored: true }, { restored: false }]));
});
```

Add explicit event cases:

```ts
it.each([
  ['invalid signature', invalidSignatureRequest(), 401, 0],
  ['duplicate event', duplicateEventRequest(), 200, 0],
  ['unknown owned payout', ownedUnknownPayoutRequest(), 503, 0],
])('%s returns %i and applies %i mutations', async (_name, request, status, mutations) => {
  const response = await controller.handle(request);
  expect(response.status).toBe(status);
  expect(stateMutation).toHaveBeenCalledTimes(mutations);
});

it('ignores completed-to-processing regression and does not credit unreturned failures', async () => {
  await handler.handleVerifiedEvent(providerEvent('processing', { currentLocalState: 'completed' }));
  await handler.handleVerifiedEvent(providerEvent('failed', { fundsReturnedAt: null }));
  expect(stateMutation).not.toHaveBeenCalledWith(expect.anything(), 'processing');
  expect(restoreRpc).not.toHaveBeenCalled();
});
```

Define the four fixture builders at the top of the spec with only IDs, event type/status, Koopfy metadata, and signature validity; exclude secrets and raw payout destinations.

- [ ] **Step 2: Run and verify failures**

Run: `pnpm test -- --runInBand src/payouts/whop-payout-webhook.service.spec.ts src/payouts/payout-reconciler.service.spec.ts src/webhooks/whop-renewal.spec.ts`

Expected: FAIL because payout routing/reconciliation is absent.

- [ ] **Step 3: Implement handler and reconciler**

Route payout event names immediately after signature/dedup reservation and before existing payment mapping. Resolve executions by `provider_payout_id` first, then validated Koopfy metadata. The reconciler selects stale `dispatching`/`processing` rows in bounded pages, retrieves when a provider ID exists, or repeats creation with the stored deterministic key when it does not. It never creates a replacement execution.

- [ ] **Step 4: Run payout, webhook, and subscription regressions**

Run:

```bash
pnpm test -- --runInBand src/payouts src/webhooks/whop-renewal.spec.ts
pnpm build
```

Expected: PASS and successful Nest build.

- [ ] **Step 5: Commit**

```bash
git add src/payouts src/webhooks src/app.module.ts
git commit -m "feat(pay): reconcile Whop payout lifecycle"
```

### Task 9: Seller Withdrawal Setup and Quote UI

**Repository:** `/Users/lucas/koopfy/dash-checkout`

**Files:**
- Modify: `lib/finance/payout-request.ts`
- Modify: `lib/finance/payout-request.test.mjs`
- Modify: `components/finance/withdraw-dialog.tsx`
- Modify: `app/finance/wallet/page.tsx`
- Modify: `hooks/use-finance.ts`
- Modify: `lib/koopfy-payments-state.ts`
- Modify: `lib/koopfy-payments-state.test.mjs`

**Interfaces:**
- Consumes: `/finance/payout-account`, `/payout-methods*`, `/payout-preview`, `/payouts`, and `/payouts/:id/reconfirm` public contracts.
- Produces: responsive five-stage Koopfy UI with verification/setup, saved method, amount, fee/net/FX/ETA review, and pending/requote results.

- [ ] **Step 1: Replace raw-form tests with public-contract tests**

```js
test('confirmation includes only saved method, quote boundary, and gross amount', () => {
  const preview = {
    methodId: 'method-1', methodKey: 'ach_standard', speed: 'standard', grossMinor: 11990,
    consolidatedFeeMinor: 1180, netMinor: 10810, sourceCurrency: 'USD', destinationCurrency: 'USD',
    destinationAmountMinor: 10810, exchangeRate: null, estimatedArrival: '2026-09-23',
    expiresAt: '2026-09-21T15:00:00.000Z', confirmationToken: 'signed-preview',
  };
  assert.deepEqual(buildConfirmation(preview), {
    methodId: 'method-1', speed: 'standard', grossMinor: 11990,
    confirmedMinimumNetMinor: 10810,
    previewExpiresAt: '2026-09-21T15:00:00.000Z',
    confirmationToken: 'signed-preview',
  });
  assert.equal(JSON.stringify(buildConfirmation(preview)).includes('routing'), false);
});

test('requote_required uses actionable copy and never says the payout was sent', () => {
  assert.match(payoutStatusCopy('requote_required').description, /revise/i);
  assert.doesNotMatch(payoutStatusCopy('requote_required').description, /enviado/i);
});
```

Add these pure cases:

```js
test('expired and non-positive previews cannot be confirmed', () => {
  assert.equal(canConfirmPreview({ ...preview, expiresAt: '2026-09-21T14:00:00Z' }, new Date('2026-09-21T15:00:00Z')), false);
  assert.equal(canConfirmPreview({ ...preview, netMinor: 0 }, new Date('2026-09-21T13:00:00Z')), false);
});

test('method schema requires only server-declared fields and speeds', () => {
  const schema = { fields: [{ key: 'pix_key', required: true }], speeds: ['instant'] };
  assert.equal(validateMethodFields(schema, {}).field, 'pix_key');
  assert.deepEqual(availableSpeeds(schema), ['instant']);
});

test('summary uses consolidated fee and readiness blocker copy', () => {
  assert.equal(payoutSummary(preview).feeMinor, preview.consolidatedFeeMinor);
  assert.match(readinessCopy({ status: 'under_review', blockerMessage: 'Verificação em análise.' }), /análise/i);
});
```

- [ ] **Step 2: Run and verify failures**

Run: `node --test lib/finance/payout-request.test.mjs lib/koopfy-payments-state.test.mjs`

Expected: FAIL because new helpers/contracts are absent.

- [ ] **Step 3: Implement the responsive dialog**

On open, load readiness and saved methods. If verification is required, show one primary `Verificar identidade` action using the returned HTTPS session URL and a `Já concluí` sync action. Render provider-supported setup fields dynamically only while creating a saved method; clear the React field state after the response. For ready sellers, request a server preview before entering review and show:

```text
Valor do saque
Taxas de saque
Você receberá
Câmbio (when present)
Previsão de chegada
```

Confirmation sends only `buildConfirmation(preview)` plus an idempotency header. Success copy is `Solicitação recebida — aguardando aprovação`. On `requote_required`, display the refreshed summary and require a new explicit confirmation. Keep buttons at least 44px high, content scrollable under the mobile viewport, and never use popup-only navigation for the verification action.

- [ ] **Step 4: Run tests, lint, and build without staging user files**

Run:

```bash
node --test lib/finance/payout-request.test.mjs lib/koopfy-payments-state.test.mjs lib/finance-api.test.mjs
pnpm lint
pnpm build
git status --short
```

Expected: all tests/build pass; `next-env.d.ts` and `tsconfig.tsbuildinfo` remain unstaged user changes.

- [ ] **Step 5: Commit selected files**

```bash
git add lib/finance/payout-request.ts lib/finance/payout-request.test.mjs components/finance/withdraw-dialog.tsx app/finance/wallet/page.tsx hooks/use-finance.ts lib/koopfy-payments-state.ts lib/koopfy-payments-state.test.mjs
git commit -m "feat(checkout): add seller payout setup and preview"
```

### Task 10: CRM Fee Configuration, Approval, and Recovery UI

**Repository:** `/Users/lucas/koopfy/dash-pay`

**Files:**
- Create: `src/lib/payout-admin.ts`
- Create: `src/lib/payout-admin.test.mjs`
- Modify: `src/components/admin-panel.tsx`
- Modify: `package.json`

**Interfaces:**
- Consumes: fee-rule CRUD, withdrawal detail readiness/fee split, approve, reject, retry, reconcile, and manual-override CRM endpoints.
- Produces: admin-only fee editor and safe operational controls with disabled reasons.

- [ ] **Step 1: Write failing presentation tests**

```js
test('approval is disabled with an actionable readiness reason', () => {
  assert.deepEqual(approvalAvailability({ payouts_enabled: false, blocker_message: 'Verificação pendente.' }), {
    enabled: false,
    reason: 'Verificação pendente.',
  });
});

test('completed payouts do not offer normal manual completion', () => {
  assert.deepEqual(normalActionsFor('completed'), []);
});
```

Add the remaining state/fee assertions:

```js
test('recovery actions follow backend state', () => {
  assert.deepEqual(normalActionsFor('dispatch_failed'), ['retry', 'reconcile']);
  assert.deepEqual(normalActionsFor('processing', { stale: true }), ['reconcile']);
  assert.deepEqual(normalActionsFor('requote_required'), []);
});

test('fee editor converts percentages to integer basis points', () => {
  assert.deepEqual(toFeeRulePatch({ percentage: '1.50', fixedUsd: '3.00', enabled: true }), {
    percentage_bps: 150, fixed_fee_usd_cents: 300, enabled: true,
  });
});
```

- [ ] **Step 2: Add the narrow test command and verify failure**

Add to `package.json`:

```json
"test:payout-admin": "node --test src/lib/payout-admin.test.mjs"
```

Run: `pnpm test:payout-admin`

Expected: FAIL because `payout-admin.ts` is absent.

- [ ] **Step 3: Implement helpers and CRM views**

In the withdrawal detail, replace raw destination display with the saved method label/masked reference, show gross, Koopfy fee, provider fee, consolidated fee, provider payout amount, destination net, FX, ETA, connected-account readiness, and last sync. Rename the primary action to `Aprovar e enviar`; disable it with the backend reason. Show retry/reconcile only for eligible states. Put manual override behind a secondary danger dialog requiring a typed reason. Add fee-rule rows with percent, fixed USD, enabled, effective timestamp, and updater; submit integers only.

- [ ] **Step 4: Run test, lint, build, and inspect dirty files**

Run:

```bash
pnpm test:payout-admin
pnpm lint
pnpm build
git status --short
```

Expected: PASS; `.env.development`, `.env.production`, and `next.config.ts` remain unstaged user changes.

- [ ] **Step 5: Commit selected CRM files**

```bash
git add src/lib/payout-admin.ts src/lib/payout-admin.test.mjs src/components/admin-panel.tsx package.json
git commit -m "feat(crm): manage and dispatch seller payouts"
```

### Task 11: End-to-End Rollout, Observability, and Release Gate

**Repositories:** all four repositories above.

**Files:**
- Create: `docs/runbooks/whop-master-seller-payouts.md` in `backend/apps/pay`

**Interfaces:**
- Consumes: completed backend, facade, seller UI, CRM UI, Whop sandbox, and non-production Supabase.
- Produces: operational runbook, rollout sequence, evidence bundle, and rollback procedure.

- [ ] **Step 1: Write the release checklist before enabling flags**

The runbook must name exact settings and order:

```text
1. Apply and verify the Supabase migration in non-production.
2. Configure WHOP_API_VERSION_DATE=2026-09-15, PAYOUT_PREVIEW_HMAC_SECRET, and master account credentials server-side.
3. Keep KOOPFY_WHOP_MASTER_PAYOUTS_ENABLED=false while deploying Pay, checkout facade, CRM, and seller UI.
4. Run one sandbox seller through verification and save a payout method.
5. Confirm seller request reserves funds and produces zero POST /api/v1/payouts calls.
6. Approve in CRM and confirm one provider payout under forced retries.
7. Deliver duplicate/out-of-order failure and reversal fixtures and verify exactly-once restoration.
8. Enable the flag for internal sellers, then a bounded cohort, then general availability.
```

Include rollback: disable the flag, leave reconciliation/webhooks running, do not delete executions, and reconcile every non-terminal payout before reverting code.

- [ ] **Step 2: Run the full automated verification matrix**

Run:

```bash
cd /Users/lucas/koopfy/backend/apps/pay && pnpm test -- --runInBand && pnpm build
cd /Users/lucas/koopfy/backend-embed && pnpm --dir apps/checkout test -- --runInBand && pnpm --dir apps/checkout build
cd /Users/lucas/koopfy/dash-checkout && node --test lib/finance/payout-request.test.mjs lib/koopfy-payments-state.test.mjs lib/finance-api.test.mjs && pnpm build
cd /Users/lucas/koopfy/dash-pay && pnpm test:payout-admin && pnpm build
```

Expected: every command exits 0.

- [ ] **Step 3: Run database and sandbox acceptance checks**

Run the pgTAP/advisor commands from Task 2 against non-production, then execute the eight runbook steps. Capture IDs/timestamps, counts, and masked screenshots only; do not capture API keys, quote tokens, identity data, full bank/Pix/wallet values, or raw webhook bodies.

Expected: request causes no provider payout; approval causes exactly one; duplicate webhooks do not repeat balance changes; failed/reversed funds return only after provider confirmation.

- [ ] **Step 4: Verify structured telemetry and alerts**

Confirm counters/timers for requests, approvals, rejections, provider acceptance/completion/reversal, provider error code, stale executions, reconciliation recovery, gross, provider fee, Koopfy fee, and delivered net. Trigger non-production alerts for provider 401/403, invalid webhook signature, unknown Koopfy-owned payout, repeated dispatch failure, and stale unreconciled execution.

- [ ] **Step 5: Commit the runbook**

```bash
cd /Users/lucas/koopfy/backend/apps/pay
git add docs/runbooks/whop-master-seller-payouts.md
git commit -m "docs(pay): add Whop payout rollout runbook"
```

## Final Review Gate

- [ ] Confirm every spec section maps to a completed task and test.
- [ ] Search all four diffs for `apiKey`, `quote_token`, routing/account/Pix/wallet fixtures, `biz_`, and `potk_`; distinguish intentional server-side identifiers/tests from leaks.
- [ ] Confirm seller JSON and browser network payloads contain only public saved-method IDs and consolidated fees.
- [ ] Confirm CRM approval is the first possible code path that calls `WhopPayoutClient.createPayout`.
- [ ] Confirm every retry retains one execution and one deterministic provider idempotency key.
- [ ] Confirm all user-owned dirty files remain unstaged.
- [ ] Request a whole-branch review before merging any repository to `main`.
