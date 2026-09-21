# Whop Master-to-Seller Payouts Design

**Date:** 2026-09-21

**Status:** Approved

**Owners:** Koopfy Pay / CRM

## 1. Objective

Implement withdrawals in which a Koopfy seller requests a payout, Koopfy reserves the seller's internal wallet balance, and an administrator must approve the request in the CRM before any Whop payout is created. After approval, Koopfy uses the master platform credential to pay the connected seller account's saved payout method.

The seller-facing product remains a Koopfy experience. Koopfy-owned screens must not expose Whop credentials, provider identifiers, or operational terminology. Third-party identity-verification screens and legally required provider notifications may identify the compliance or payment provider; the application must not disguise or suppress required disclosures.

Success means:

- no money-moving Whop request occurs before CRM approval;
- every seller payout is associated with the correct connected account and saved payout method;
- retrying an approval cannot create a duplicate payout;
- provider and Koopfy fees are included in the seller's pre-confirmation summary;
- the internal wallet and Whop payout lifecycle reconcile after timeouts, webhook redelivery, failures, and reversals;
- raw bank, wallet, tax, and identity values are not persisted in Koopfy payout records.

## 2. Existing System

The seller payout request currently calls the Supabase `request_payout_idempotent` RPC. That RPC delegates to `request_payout`, which atomically moves the requested amount from `available` to `withdrawing` and writes a `debit_payout` entry in `wallet_ledger`.

The CRM currently provides these manual transitions:

- `pending` to `approved`, debiting the `withdrawing` bucket;
- `pending` to `rejected`, releasing `withdrawing` back to `available`;
- `approved|processing` to `completed`;
- `approved|processing` to `failed`, restoring the seller balance.

No current approval path creates a Whop payout. The seller UI also stores raw destination data in payout metadata. This implementation replaces the external-processing portion of that flow while preserving the existing ledger as the balance source of truth.

## 3. Provider Contract

The implementation uses Whop's Current API, authenticated server-side with the master platform Account API key and pinned with an `Api-Version-Date` configuration value. The initial pinned date is `2026-09-15`.

Relevant provider behavior:

- the platform creates and owns connected accounts for sellers;
- a connected account must complete KYC/KYB and have a saved payout method before receiving a payout;
- a payout is created with the connected seller `account_id` (`biz_...`) and its saved payout method (`potk_...`);
- the master platform balance funds the connected-account payout flow;
- quotes are short-lived and must be refreshed at approval time;
- `Idempotency-Key` makes payout creation safe to retry;
- payout lifecycle changes arrive through `payout.created`, `payout.updated`, and `payout.reversed`.

Primary references:

- <https://docs.whop.com/developer/platforms/manual-payouts>
- <https://docs.whop.com/api-reference/beta/payouts/create-payout>
- <https://docs.whop.com/api-reference/beta/payouts/create-payout-quote>
- <https://docs.whop.com/api-reference/beta/payouts/create-saved-payout-method>
- <https://docs.whop.com/developer/verification/overview>

## 4. Architecture

### 4.1 `WhopPayoutClient`

A focused backend service owns all payout-related Whop HTTP calls:

- create/retrieve connected accounts;
- start and query identity verification;
- list supported and saved payout methods;
- create and update saved payout methods;
- create payout quotes;
- create and retrieve payouts.

The client:

- obtains the master credential only from server-side configuration;
- sends the pinned API version on every Current API request;
- requires an idempotency key for every mutating operation;
- applies timeouts and structured error mapping;
- never logs credentials, raw payout fields, documents, quote tokens, or regulated identity values;
- validates response shapes before returning domain objects.

### 4.2 `SellerPayoutAccountService`

This service owns the seller-to-connected-account relationship and payout readiness. It provisions an account idempotently with Koopfy's `seller_id` in provider metadata, synchronizes verification state, and exposes only safe readiness information to seller and CRM interfaces.

Newly approved sellers are provisioned after local CRM approval. Existing active sellers are provisioned lazily when they first open payout setup. A failed external provision does not roll back local seller approval; it leaves payout readiness in an actionable error state and blocks withdrawals until repaired.

### 4.3 `PayoutOrchestrator`

This service owns fee calculation, quote snapshots, reservation, approval, dispatch, retry, and reconciliation. `CrmAdminService` delegates payout transitions to this component instead of containing provider rules directly.

### 4.4 `WhopPayoutWebhookHandler`

The existing signed Whop webhook entry point routes payout events to a dedicated handler before the payment-event mapping. Payout metadata includes `koopfy_account_id`, `koopfy_payout_id`, and `koopfy_seller_id`, which let the shared endpoint select the configured webhook secret and resolve the local execution.

Webhook processing remains at-least-once and uses the existing event-deduplication reservation pattern. A failed processing attempt removes the reservation so Whop can retry.

### 4.5 Reconciler

A scheduled reconciler queries local executions that have remained in `dispatching` or `processing` beyond a configured threshold. It retrieves the provider payout when an ID exists; otherwise it safely repeats creation with the same idempotency key. Reconciliation never creates a new idempotency key for an existing execution.

## 5. Data Model

All new public-schema tables enable RLS. Browser roles receive no privileges or policies. Only `service_role` receives the explicit grants needed by the backend, accommodating Supabase's current explicit Data API exposure behavior.

### 5.1 `seller_payout_accounts`

One row per Koopfy seller:

- `seller_id` primary key;
- `provider` fixed to `whop`;
- `provider_account_id` unique `biz_...` value;
- `status`: `provisioning`, `verification_required`, `under_review`, `ready`, `restricted`, or `error`;
- `verification_status` and `payouts_enabled`;
- `last_error_code`, `last_error_message`, `last_synced_at`, and timestamps.

The table contains no identity documents or raw tax data.

### 5.2 `seller_payout_methods`

Safe references to provider-vaulted destinations:

- local ID and seller ID;
- unique provider method ID (`potk_...`);
- provider-supported method ID (`podst_...`);
- method category, delivery speed capabilities, network, destination country, and currency;
- nickname, institution name, and masked account reference;
- provider status, default flag, and timestamps.

Raw fields are accepted only in a request body, forwarded to Whop, and discarded. They must not appear in application logs, `wallet_ledger`, audit metadata, or error payloads.

### 5.3 `payout_fee_rules`

CRM-managed Koopfy markup rules:

- stable `method_key` primary key;
- percentage in basis points;
- fixed fee in USD cents;
- enabled flag;
- effective timestamp, updater, and timestamps.

Initial rules:

| Method key | Percentage | Fixed fee |
| --- | ---: | ---: |
| `pix` | 2.00% | US$ 3.00 |
| `bank_wire` | 1.00% | US$ 3.00 |
| `ach_instant` | 1.00% | US$ 3.00 |
| `ach_next_day` | 0.50% | US$ 3.00 |
| `ach_standard` | 0.50% | US$ 3.00 |
| `crypto` | 1.50% | US$ 3.00 |

The rule selected at request time is snapshotted on the payout so later CRM edits cannot change an existing request.

### 5.4 `payout_executions`

One provider execution per `wallet_ledger` payout entry:

- local payout ID and unique ledger entry ID;
- seller ID, connected-account ID, and saved-method ID;
- method key, speed, source currency, and destination currency;
- gross amount, Koopfy fee, provider fee, provider payout amount, net amount, and destination amount in integer minor units where applicable;
- quote ID, quote expiry, exchange rate, estimated arrival, and confirmed minimum net;
- deterministic provider idempotency key;
- provider payout ID (`wdrl_...`) and provider status/detail;
- local state, error code/message, funds-returned timestamp, wallet-restored timestamp, and lifecycle timestamps.

The short-lived signed `quote_token` is held in memory only for the immediate create call. It is not persisted.

### 5.5 Audit and webhook events

Existing CRM audit records receive safe payout transition metadata. Existing Whop webhook-event deduplication is reused. Neither receives raw destination or identity fields.

## 6. Fee Semantics

The amount entered by the seller is the gross amount removed from the Koopfy wallet.

For gross amount `G`:

1. Koopfy calculates its snapshotted additional fee `K` from the selected CRM rule.
2. The amount quoted for provider payout is `G - K`.
3. Whop returns its provider fee `W`, exchange rate, and destination amount.
4. The seller-facing net is the quote's authoritative net/destination amount; conceptually for a same-currency payout it is `G - K - W`.

The request is invalid when the post-fee payout amount is non-positive or below a provider minimum. Provider rounding and zero/three-decimal currencies follow the provider quote rather than local floating-point calculations.

The Whop quote and payout use `platform_covers_fees: false`, because the provider fee is borne by the seller within the gross withdrawal. The seller UI shows one consolidated `withdrawal fee`; it does not name Whop or disclose Koopfy's margin. The CRM shows provider cost and Koopfy revenue separately.

## 7. Lifecycle and Ledger Rules

### 7.1 Seller request

1. Authenticate and resolve the seller from server-side context; ignore any client-supplied seller ID.
2. Require an active Koopfy seller, ready connected account, approved verification, and active saved method owned by that seller.
3. Fetch a quote and compute the Koopfy fee snapshot.
4. Present gross, consolidated fee, net/destination amount, exchange rate, and estimated arrival.
   The preview includes an expiring opaque HMAC confirmation proof, bound to the authenticated seller, method, speed, gross amount, minimum net, and expiry. It contains no provider quote token and prevents the browser from lowering or replacing the reviewed values.
5. On confirmation, call a new transactional and idempotent Supabase RPC that:
   - verifies the quote snapshot and seller ownership inputs;
   - moves gross funds from `available` to `withdrawing`;
   - creates the `wallet_ledger` payout and `payout_executions` row;
   - stores the seller-confirmed minimum net;
   - returns `pending_review`.

No `POST /payouts` call occurs in this phase.

### 7.2 CRM rejection

Only `pending_review` and `requote_required` requests may be rejected. A transactional RPC changes the state and returns the exact reserved gross amount from `withdrawing` to `available` once.

### 7.3 CRM approval and dispatch

1. A compare-and-set transition claims `pending_review` for one administrator and moves it to `dispatching`.
2. The backend revalidates connected-account readiness and saved-method ownership.
3. The backend creates a new provider quote.
4. If the refreshed net is lower than the seller-confirmed minimum, the execution becomes `requote_required`; no payout is created and the gross amount remains reserved.
5. Otherwise, the backend immediately submits the quote token to `POST /payouts` with:
   - the seller connected `account_id`;
   - the seller saved `payout_method_id`;
   - `platform_covers_fees: false`;
   - metadata linking the local payout, seller, and Koopfy Whop account;
   - the deterministic payout idempotency key.
6. A successful provider response stores the `wdrl_...` ID and moves the local state to `processing`.
7. An idempotent ledger RPC finalizes the reservation from `withdrawing` as an external outflow only after Whop accepts the payout.

If the process crashes after provider acceptance but before local finalization, the reconciler repeats the same provider request or retrieves the returned payout and then runs the idempotent finalization RPC.

### 7.4 Provider state mapping

| Whop status | Local state |
| --- | --- |
| `requested`, `in_review`, `processing` | `processing` |
| `completed` | `completed` |
| `failed` | `failed` |
| `canceled` | `canceled` |
| `denied` | `denied` |
| `reversed` | `reversed` |

`payout.created` and `payout.updated` may advance a state but cannot move a terminal state backward. `payout.reversed` is handled explicitly even when the payout had already completed.

### 7.5 Restoring funds

Balance restoration is a distinct idempotent operation:

- before Whop acceptance, canceling a dispatch releases the original `withdrawing` reservation;
- after acceptance/final ledger debit, a failed, canceled, denied, or reversed payout credits `available` only when Whop reports `failure.funds_returned_at` or a retrieval confirms returned funds;
- `wallet_restored_at` and an atomic RPC prevent duplicate credits from webhook redelivery and reconciliation races.

An external failure without confirmed returned funds remains visible for operations and does not manufacture local available balance.

## 8. State Machine

```text
pending_review ──→ rejected
      │
      └──→ dispatching ──→ processing ──→ completed
                 │              ├──→ failed
                 │              ├──→ canceled
                 │              ├──→ denied
                 │              └──→ reversed
                 ├──→ requote_required ──→ pending_review
                 └──→ dispatch_failed ──→ dispatching
```

Every transition declares its allowed source states and uses a database compare-and-set or transactional RPC. Provider retries keep the same execution and idempotency key.

## 9. Interfaces

### 9.1 Seller-facing API and UI

The unified finance API adds operations to:

- read payout readiness;
- start/resume verification and refresh its status;
- list dynamically supported payout methods for the seller's country/currency;
- create, list, select, and remove saved methods;
- create a withdrawal preview;
- confirm a preview and reserve funds;
- reconfirm a requoted withdrawal;
- view payout history and status.

The withdrawal dialog becomes:

1. readiness/setup when KYC or a destination is missing;
2. method and speed selection;
3. gross amount entry;
4. fee/net/FX/arrival review;
5. confirmation showing `Aguardando aprovação`.

Provider identifiers and internal fee composition are never returned to the seller client.

### 9.2 CRM API

The CRM adds:

- list/update payout fee rules;
- connected-account readiness and last synchronization on seller details;
- provider and Koopfy fee breakdown on withdrawal details;
- `Aprovar e enviar`, which performs the claimed dispatch flow;
- retry/reconcile actions for `dispatch_failed` and stale processing states;
- a controlled manual fallback with mandatory reason and audit entry.

The CRM API reports whether approval is allowed and returns an actionable blocking reason when verification, payout capability, saved-method status, or master configuration is invalid.

The current manual `mark-completed` and `mark-failed` actions no longer serve as the normal workflow. They remain privileged recovery tools and must first retrieve the provider payout when a provider ID exists.

The CRM frontend repository is outside this implementation by explicit scope decision on 2026-09-21. The backend contracts remain ready for the active administrative client without modifying `dash-pay`.

## 10. Failure Handling

- **Provider 4xx before acceptance:** persist a sanitized code and message, transition to `dispatch_failed`, keep funds reserved, and allow correction/retry or admin cancellation.
- **Provider 401/403:** fail closed, surface a master-configuration incident in CRM, and do not retry rapidly.
- **Provider 409/idempotency replay:** retrieve or accept the original payout and reconcile it.
- **Timeout/5xx:** keep `dispatching`; retry with exponential backoff and the same idempotency key.
- **Quote deterioration:** transition to `requote_required`; do not send money without renewed seller confirmation.
- **Webhook signature failure:** return a non-2xx response so Whop retries; make no state change.
- **Unknown payout webhook:** log a high-severity reconciliation event and return non-2xx when metadata indicates Koopfy ownership.
- **Duplicate webhook:** return success without repeating state or ledger mutations.
- **Database update failure after provider acceptance:** leave the execution recoverable by deterministic idempotency and reconciliation.

## 11. Security and Privacy

- Master credentials remain server-side and use the minimum required Whop scopes.
- The API version is pinned and changed only through reviewed configuration.
- Seller identity always comes from authenticated server context.
- Saved-method ownership is checked against both local seller mapping and Whop response.
- Sensitive destination and KYC values are transient and redacted from logs, exceptions, analytics, and audit events.
- No regulated data is written to Whop metadata.
- Public-schema tables use RLS, explicit service-role grants, and no browser policies.
- Database functions revoke default `PUBLIC`, `anon`, and `authenticated` execution and grant only `service_role`.
- CRM state-changing endpoints remain admin-only and audited.
- Webhooks use the raw body, configured signing secret, timestamp tolerance, and constant-time signature comparison.

## 12. Observability

Structured operational metrics include:

- payout requests, approvals, rejections, provider acceptance, completion, and reversal counts;
- time from request to approval and approval to completion;
- failures by provider code and method;
- stale `dispatching`/`processing` counts;
- gross payout, provider fee, Koopfy fee, and delivered net totals;
- reconciliation recoveries and manual overrides.

Logs include local payout ID, seller ID, provider payout ID when available, state, and sanitized error code. Alerts fire for authentication failures, signature failures, unknown owned webhooks, repeated dispatch failures, and unreconciled payouts.

## 13. Testing and Verification

### Unit tests

- fee-rule selection and integer rounding;
- gross/Koopfy/provider/net invariants;
- provider response validation and error sanitization;
- deterministic idempotency keys;
- provider-to-local state mapping;
- forward-only terminal transitions and restoration eligibility.

### Service tests

- connected-account provisioning and existing-seller lazy provisioning;
- payout-method ownership and raw-data non-persistence;
- request reservation without payout creation;
- concurrent CRM approval with exactly one provider create call;
- timeout followed by idempotent retry;
- refreshed quote below confirmed minimum;
- accepted payout followed by local write failure and reconciliation;
- duplicate, out-of-order, failed, and reversed webhooks;
- exactly-once balance restoration.

### Database tests

- atomic request and rejection transitions;
- compare-and-set approval claim;
- idempotent external-outflow finalization;
- idempotent returned-funds credit;
- RLS and grants for all new tables and functions;
- view security invoker behavior when a new CRM view is introduced.

### Frontend tests

- KYC/readiness blocking states;
- dynamic method and speed selection;
- gross, consolidated fee, net, FX, and ETA summary;
- `pending_review`, `requote_required`, processing, terminal, and retry states;
- mobile completion of the entire withdrawal flow.

### Release verification

1. Apply migrations to a non-production Supabase environment and run database tests/advisors.
2. Exercise connected-account onboarding and saved methods in Whop sandbox.
3. Verify that a seller request performs no payout create call.
4. Approve in CRM and observe exactly one payout under forced retries.
5. Deliver duplicate and out-of-order webhook fixtures.
6. Test failure and reversal with exactly-once wallet restoration.
7. Run backend unit tests/build and dashboard tests/build.
8. Enable production dispatch behind a server-side feature flag, initially for internal sellers only.

## 14. Rollout and Recovery

The release is additive and feature-flagged:

- migrations land before code paths are enabled;
- legacy pending withdrawals remain on the existing manual workflow unless explicitly migrated;
- new provider-backed requests are marked by a `payout_executions` row;
- disabling the dispatch flag stops new Whop payout calls without preventing webhook processing or reconciliation;
- webhooks and reconciliation remain enabled while any provider-backed payout is nonterminal;
- rollback never deletes execution or audit data and never automatically rewinds a completed external payout.

No automatic bulk provisioning of existing sellers occurs at deployment time.

## 15. Explicit Non-Goals

- replacing the Koopfy wallet ledger with Whop's ledger;
- allowing sellers to self-approve or bypass CRM review;
- exposing the Whop payout portal as the primary Koopfy withdrawal interface;
- storing raw bank, crypto, tax, document, or identity data;
- introducing an external queue platform in the first release;
- automatically migrating legacy pending withdrawals;
- suppressing legally required provider or compliance disclosures.
