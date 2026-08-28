# PFM Post-Completion Review Handoff Recovery v0 — Operator Runbook

Status: **local/inert only.** This runbook describes `scripts/post-completion-review-recovery.ts` as it exists after the local implementation gate. It does **not** authorize a production execution on its own — a production run requires its own separate, explicit approval, following the same pattern as every other first-production-write gate in this rollout.

Related: `lib/semantic-topic/post-completion-review-recovery.ts` (orchestration core), `lib/semantic-topic/human-review-service.ts`'s `createReviewRequest()` (unchanged, reused), `lib/semantic-topic/human-review-extraction-hook.ts`'s `deriveHumanReviewIdempotencyKey()` (unchanged, reused), `supabase/migrations/078_semantic_topic_human_review_rpcs.sql`'s `create_topic_assignment_review_request` RPC (unchanged).

## What this tool is — and is not

This CLI creates (or idempotently replays) exactly one `topic_assignment_review_requests` row for an **already-completed** `topic_extraction_runs` row, for the one specific gap this tool exists to close: a completed, content-eligible extraction whose review request never got created because `SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED` was not `'true'` in the process that produced it (e.g. a local CLI invocation whose shell never exported the flag, even though it is `true` in production).

**It is not:**
- An extraction retry tool. It never calls a provider, never re-runs `runShadowExtraction()`, and only ever reads (never writes) `topic_extraction_runs`.
- A second implementation of the 078 eligibility rules. It calls the exact same `create_topic_assignment_review_request` RPC the live hook calls, via the exact same `createReviewRequest()` service wrapper and the exact same `deriveHumanReviewIdempotencyKey()` key derivation — unchanged, imported, never reimplemented.
- A batch/item/attempt/reservation tool. It never touches any `supervised_intake_*` table.
- A way to override, retry, or resurrect a `rejected`/`cancelled`/`expired` request. A closed request under this run's deterministic key is replayed to (never modified), never superseded.

## 1. Prerequisites

- **Node.js ≥ 24** (same native-TypeScript requirement as `scripts/supervised-intake-runner.ts`).
- Three environment variables, exported in the operator's own shell **before** invoking the CLI — this CLI never reads `.env`/`.env.local` itself:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED=true` — checked explicitly, before any DB call. Setting this in your own shell never modifies the Vercel production environment variable of the same name; it is process-local to whichever terminal exports it.
- The exact Supabase project ref the operator intends to target, to pass as `--confirm-production`.

## 2. Preflight — always do this before a real invocation

Confirm, read-only, in your own terminal:
- Which extraction run you intend to recover a request for, and that it is genuinely `completed`.
- The exact project ref of the Supabase project you are about to point `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` at.

## 3. Dry-run — always run this first

```bash
node scripts/post-completion-review-recovery.ts --extraction-run-id <uuid> --confirm-production <project-ref> --dry-run
```

A dry-run:
- Validates the UUID format and the `--confirm-production` guard.
- Confirms the flag and required env vars are present (booleans only, never values).
- Reads (read-only) the extraction run's status, confidence, specificity, content_format, and supporting-span **count** — never the raw evidence text or the full structured output.
- **Creates nothing.** No review request, no event row, ever.

## 4. The `--confirm-production` guard

`resolveProjectIdentity()` parses `NEXT_PUBLIC_SUPABASE_URL`. A `localhost`/`127.0.0.1` target is always classified `kind:'local'`, which `projectGuardPasses()` **never** accepts, regardless of what string `--confirm-production` carries. This is deliberate, fail-closed protection against a local/production DB mix-up — it means this CLI can only ever proceed against a genuine `<project-ref>.supabase.co` URL, and the `--confirm-production` value must exactly match that ref.

## 5. Real invocation

```bash
node scripts/post-completion-review-recovery.ts --extraction-run-id <uuid> --confirm-production <project-ref>
```

Runs the same preflight as the dry-run, then calls `create_topic_assignment_review_request` **exactly once**.

## 6. Structured output and exit codes

| Exit | Outcome kind | Meaning |
|---|---|---|
| 0 | `dry_run` / `created` / `replayed` | Exactly one request now exists for this run. |
| 2 | `configuration_error` | Bad UUID, missing env, flag not `'true'`, project-guard mismatch, run not found, or run not `completed` — before any RPC call. |
| 3 | `ineligible` | One of `NOT_SPECIFIC` / `CONFIDENCE_NOT_REVIEW_ELIGIBLE` / `NO_SUPPORTING_SPANS` / `INVALID_STRUCTURED_OUTPUT` / `EXTRACTION_NOT_COMPLETED`. No request created. Never retry — the content genuinely does not qualify. |
| 4 | `blocked` | `ALREADY_ASSIGNED` (a decision already exists for this run) or `LIVE_REVIEW_REQUEST_EXISTS` (a pending/approved request already exists under a different key). No request created/changed. |
| 5 | `database_error` | An unexpected RPC/transport error. Safe to re-run — the call is idempotent under the same deterministic key. |

Only an 8-character prefix of any UUID (run id, review request id, evidence id) is ever printed. No secret value is ever printed — only boolean presence.

## 7. Removing the flag afterward

Once you are done, clear the process-local flag from your shell (it only ever affected that shell):

```bash
unset SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED
```

## 8. Postcondition

After a real invocation, confirm read-only:
- Exactly one `topic_assignment_review_requests` row exists for the run (whether it was `created` or `replayed`).
- Exactly one `topic_assignment_review_events` row (`event_type='requested'`) is linked to it.
- `semantic_topics`, `semantic_topic_membership`, `topic_assignment_decisions` counts are unchanged.
- No `supervised_intake_*` row, no `ai_provider_budget_reservations` row was created.

## 9. Replay / crash handling

Because the idempotency key is deterministic (`human-review-request:<extraction_run_id>`), re-running this CLI against the same run — whether because the first run's true outcome is unclear, the process crashed, or you simply want to confirm the result again — is always safe: it will either report the same `created`/`replayed` result it would have produced before, or (if the first call never actually reached the RPC) `created` for the first time. There is no state in which re-running this CLI can produce two requests for the same run.

## 10. Secret and UUID handling

- Never paste this CLI's `SUPABASE_SERVICE_ROLE_KEY`/`NEXT_PUBLIC_SUPABASE_URL` values anywhere outside your own shell.
- Never paste a full extraction-run or evidence UUID into a chat, ticket, or log destined outside your own terminal — this CLI itself only ever prints an 8-character prefix, by design; keep any full identifiers you look up separately with the same discipline.

## 11. This CLI is not an extraction retry tool

If the underlying evidence has never actually been extracted (no `completed` `topic_extraction_runs` row exists for it at all), this tool cannot help — that requires the separate, already-existing supervised-intake canary path (`scripts/supervised-intake-runner.ts`), with its own separate authorization.
