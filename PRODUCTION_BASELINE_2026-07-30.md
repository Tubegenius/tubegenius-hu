# Production Baseline — 2026-07-30

Migrations 045–047 (ACL / RLS-hardening) rollout closure. This document
records the verified end-state of the production database's schema and
privilege configuration as of this date, and the recovery posture backing
it. No user or business data is referenced anywhere below.

## 1. Rollout end-state

| Migration | Result |
|---|---|
| `045_harden_function_execution.sql` | **PASS** |
| `046_harden_default_privileges.sql` | **PASS** |
| `047_capture_and_harden_rls_auto_enable.sql` | **PASS** |
| Phase 4 metadata reconciliation | **11/11 PASS** |
| Rollback | **Not required** |

## 2. Final statement

**A production séma és jogosultsági állapot igazoltan megfelel a 001–047
által meghatározott kívánt végállapotnak.**

This project's production database has never been managed through the
Supabase CLI's tracked migration history. The above statement is
deliberately scoped to *verified schema and privilege state*, not to
migration bookkeeping. Specifically, it is **not** claimed that:
- production's migration history contains records for 045–047 (or any
  earlier migration);
- 045–047 were applied via `supabase db push` or any other CLI-tracked
  mechanism (they were applied via direct, hash-verified `psql` execution
  of the reviewed `.sql` files, matching how this project's production
  database has always been managed);
- any migration baseline or history registration occurred.

## 3. Application smoke — scope and result

- Logged-out login/redirect flow: **PASS** (`/auth/login` 200; `/dashboard`
  and `/dashboard/overview` redirect cleanly)
- No 500/503 observed
- No console or hydration errors observed
- No automatic POST requests observed (100% GET across every page load
  tested)
- Authenticated `/dashboard`, `/dashboard/profile`, `/dashboard/credits`,
  `/dashboard/opportunities`, `/dashboard/memory`, and credit-balance
  before/after stability: **N/A** — no authenticated Browser-session was
  available during this rollout, and none was created (no test user was
  registered)

This is a **documented test-coverage limitation**, not a demonstrated
regression. Nothing observed in any check performed suggests a problem on
the authenticated path; it has simply not yet been exercised against
production under this rollout.

## 4. Security end-state

- **045** — revoked implicit `PUBLIC` `EXECUTE` on 7 previously-unrestricted
  functions (`anon`/`authenticated`/`service_role` no longer have
  `EXECUTE`; owner retains it); pinned `search_path` on 8 functions that
  previously had none set.
- **046** — established `ALTER DEFAULT PRIVILEGES` for the `postgres` role
  so that any *future* `postgres`-owned table, sequence, or function
  (public schema, plus a global scope for functions) grants nothing to
  `PUBLIC`/`anon`/`authenticated`/`service_role` by default. Does not
  retroactively affect any existing object.
- **047** — version-controlled the pre-existing `public.rls_auto_enable()`
  function and `ensure_rls` event trigger (which automatically enables RLS
  on new `public`-schema tables), and hardened `rls_auto_enable()`'s own
  `EXECUTE` grant the same way as 045's targets.
- **Control objects confirmed unchanged throughout:** the 4 already-hardened
  credit RPCs from migration 040, the `storage` schema's default ACL, the 6
  other platform-owned event triggers, and RLS state on existing
  representative tables — all verified byte-for-byte/value-for-value
  identical before and after the rollout.

## 5. Recovery posture

- An encrypted production backup set was created and independently
  verified (content-integrity hash-diff across all public-schema tables
  and the relevant Auth tables; decrypt/restore proof performed).
- A full local restore-drill against a fresh, disposable Supabase instance
  succeeded.
- A second, physically separate copy of the encrypted backup set exists at
  `D:\WillViralBackup`, with target-side checksum verification passed.
- No plaintext dump, credential file, or connection string exists in the
  backup artifact set.
- No secret value, connection string, or password appears anywhere in this
  document or in any artifact referenced by it.

## 6. Evidence

- `HEAD` = `origin/main` = `d941b62fbe4b474f6152ed1be0ceac663b752737`
- SHA-256 of the three applied migration files (host and production-side
  container staging both confirmed identical before each apply):
  - `045_harden_function_execution.sql`:
    `c6cfad5e84ce67bcab9999c44394ddccabdb4014dc796aad5c3a382a424f3679`
  - `046_harden_default_privileges.sql`:
    `7706656a26eaaafe9d97e10803d2cf5a7a32bb0caa4c67be91ab81b3f7754747`
  - `047_capture_and_harden_rls_auto_enable.sql`:
    `93452a65cdd31c41e8489ea68d18e8cc455fe261af034a51f692fbe9256c9000`
- Production SQL execution results: 045 committed clean on first attempt;
  046 committed clean on first attempt; 047 failed its own fail-fast
  validation on first attempt (whitespace-only mismatch between the
  migration's embedded expected function body and production's actual
  stored body — no production state was changed, transaction rolled back),
  was corrected (7 bytes of indentation across 5 lines, zero semantic
  change, verified via diff, semantic review, and full local regression
  including a drift-rejection test), recommitted as `d941b62`, and
  succeeded on retry (validate/no-op branch for both the function and the
  event trigger; the one real change — the `EXECUTE` ACL revoke on
  `rls_auto_enable()` — applied cleanly).
- Phase 4 read-only reconciliation: 11/11 checks passed against production
  metadata (function ACLs, search_path values, default-privilege end-state,
  existing-object ACL spot-checks, `rls_auto_enable()`/`ensure_rls` full
  definitions, platform event-trigger and RLS-state controls).
- Final `git status --short`: clean (no tracked-file changes outside this
  document and the corrected `047` migration; two pre-existing untracked
  local log files present, unrelated to this rollout).

## 7. Open, non-blocking items

- **Authenticated production smoke** (dashboard/profile/credits/
  opportunities/memory, credit-balance stability) has not yet been
  exercised against production under this rollout — should be completed
  when an authenticated session is available, without creating a new
  production account for the sole purpose of testing.
- **Production has no CLI-tracked migration history** — this remains true
  after this rollout (unchanged from before; not something this rollout
  attempted to establish).
- **The Emerging Trend / First-mover engine preflight** is separate,
  subsequent product-development work and is out of scope for this
  document.
- **`cleanup_expired_cache()` remains an orphaned function** — it exists,
  is now correctly EXECUTE-hardened (045), but has no scheduled or
  application-level caller anywhere in the codebase (confirmed: not
  referenced by any Vercel cron entry or application code as of this
  date). Its hardening does not depend on resolving this; noted here as a
  still-open backlog item, not a rollout blocker.
