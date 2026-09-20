# Starter Credit Contract v1

Status: **implemented locally, not applied anywhere** (migration `091`, no push/PR/deploy, no
staging/production write). A separate staging preflight → apply → verification gate must precede any
rollout.

## Problem

Since migration `037` (credit buckets) every newly registered user ends up with a `user_credits` row of
**balance 0**:

* `on_auth_user_created_credits` (AFTER INSERT on `auth.users`) → `handle_new_user_credits()` creates the
  row at signup with the column defaults (`balance 0`, `plan 'beta'`, `monthly_allowance 50`).
* The 50-credit starter grant lived only in the *"row is missing"* branch of `GET /api/credits`
  (added together with the buckets in commit `75a52fb`, 2026-07-17). The trigger made that branch
  unreachable, so the grant was never issued.

Observed on the first staging user (2026-09-20): `balance 0`, `plan beta`, no ledger row.

## Is 50 the canonical starter grant?

Yes. Every place in the code that encodes a starter amount agrees, and nothing contradicts it:

| Evidence | Value |
| --- | --- |
| `GET /api/credits` grant (75a52fb) | `apply_bucket_credit_event(user, 50, 'subscription', cap 50, 'initial:<id>', 'initial_credit', {"plan":"beta"})` |
| `user_credits.monthly_allowance` column default (003) | `50.0` |
| `user_credits.plan` column default | `'beta'` |
| UI / stats fallbacks (`Sidebar.tsx`, `dashboard-stats`) | `balance ?? 50`, `monthly_allowance ?? 50` |
| Pre-037 route fallback | `{ balance: 50, plan: 'beta', monthly_allowance: 50 }` |

## Contract

For every **newly created** `auth.users` row:

| Field | Value |
| --- | --- |
| bucket | `subscription` (`subscription_credit_balance = 50`, `purchased_credit_balance = 0`) |
| `balance` | `50` (= 50 + 0, enforced by `user_credits_balance_matches_buckets`) |
| `plan` / `subscription_status` | `beta` / `free` (column defaults) |
| `monthly_allowance` | `50` (column default) |
| `renews_at` | `now() + 30 days` (column default; beta credits are a one-off starter, nothing renews them) |
| ledger | **exactly one** `credit_ledger` row: `reason 'initial_credit'`, `external_ref 'initial:<user_id>'`, `credit_bucket 'subscription'`, `delta 50` |
| profile | exactly one `profiles` row (unchanged trigger) |

**Why a ledger row:** every credit mutation must be traceable, and the ledger `UNIQUE(external_ref)` is
the idempotency anchor. `apply_bucket_credit_event` always writes the ledger row and row-locks
`user_credits`, so the grant is exactly-once even under concurrency.

**Exactly once across writers.** Two writers share the single key `initial:<user_id>`:

1. `handle_new_user_credits()` (migration 091) - primary, fires once per new user, in the same
   transaction as the `auth.users` insert (fail-closed: if the grant raised, the signup would fail
   rather than silently create a 0-credit account).
2. `GET /api/credits` - compatibility fallback, only when the `user_credits` row does not exist at all
   (definitive `PGRST116`) and only when that call itself created the row. A transient read error or a
   lost insert race (`23505`) never grants.

The second writer to reach the RPC receives `duplicate: true` and changes nothing.

## Interaction with the rest of the credit system (no regression)

* **Top-up** credits go to the `purchased` bucket only; the starter grant never touches it and it never
  touches the starter grant.
* **Subscription start** calls `apply_bucket_credit_event(..., 'subscription', cap = plan credits, ...)`.
  The unspent starter grant is *absorbed* into the plan allowance (`LEAST(50 + plan, plan) = plan`), it
  does not stack. Purchased credits are untouched. This is the pre-existing 037 semantics and is
  deliberately left unchanged.
* **Spending** takes the subscription bucket first, then purchased; refunds restore the original split.
* **User deletion** cascades (`profiles`, `user_credits`, `credit_ledger` all `ON DELETE CASCADE`).

## What 091 does and does not do

* Changes exactly one object: the body of `public.handle_new_user_credits()` (same identity, owner,
  `SECURITY DEFINER`, `search_path`, ACL - all re-verified).
* Fail-fast pins: current function definition (old or new md5), `apply_bucket_credit_event` md5 + ACL,
  the exact `auth.users` trigger set, `credit_ledger UNIQUE(external_ref)`, `user_credits` defaults.
* Writes **no data**: no backfill, no retroactive grant. `user_credits` / `credit_ledger` row counts and
  a `user_credits` content digest are asserted unchanged. Existing production users (including the one
  with a 381 balance) are not modified.
* Idempotent: re-applying is a no-op.

## Explicitly out of scope / follow-ups

* **The current staging user (balance 0, no starter grant)** is *not* corrected here. Whether to grant
  them the starter credit (the same `initial:<user_id>` idempotent event, staging only) is a separate,
  later staging-only decision.
* No production backfill of any kind.
* Rollout order (each its own gate): staging preflight → staging apply + new-user verification →
  production preflight → production apply. `psql` only (production has no CLI migration history).
  After apply, the pinned `APP` function digest in the rollout fact files must be re-recorded.
