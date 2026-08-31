# PFM Supervised Production Candidate Intake v0 — Operator Runbook

Status: **local/inert only.** This runbook describes `scripts/supervised-intake-runner.ts` as it exists after the local E2E + recovery-closure gate. It does **not** authorize a production run, a real provider call, reviewer bootstrap, or flipping `ai_extraction_control`/`supervised_intake_control` in any environment where doing so would be consequential. Every command below is written for a local or otherwise fully controlled environment.

Related: `lib/semantic-topic/supervised-intake-runner.ts` (orchestration core), `lib/semantic-topic/supervised-intake-types.ts` (input contract, exit codes, claim-state shape), `supabase/migrations/079_semantic_topic_supervised_intake_foundation.sql` (the 12 RPCs this runner exclusively drives its state through).

## 1. Prerequisites

- **Node.js ≥ 24.** The CLI uses this Node version's native TypeScript support directly (no build step, no bundler). Running it under an older Node either fails at Node's own module-load stage (pre-22.6, TypeScript syntax simply cannot be parsed) or is rejected by the CLI's own explicit version preflight with exit code `2` (22.6–23.x — new enough to parse the file, old enough that this CLI is not validated against it).
- Two environment variables, exported in the operator's own shell **before** invoking the CLI — this CLI never reads `.env`/`.env.local` itself:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY` is read only inside the real provider-call path (`provider-adapter.ts`), never by this CLI directly. For any dry-run, or any scenario where the kill switch (§7) is disabled, it is never needed at all.
- No new package install, no `npx` download — the CLI is Node-core-only (`node:module`, `node:fs/promises`, `node:path`) plus this repository's own existing application modules.

## 2. Dry-run — always run this first

```bash
node scripts/supervised-intake-runner.ts --input path/to/batch.json --dry-run
```

A dry-run:
- Validates the batch input file against the closed schema (§3) — fails closed on any unknown or forbidden field.
- Computes and prints a preview of the extraction-config digest and a local request-digest preview (for confirming two runs of the same file agree, before either ever touches the database).
- Checks that both required environment variables are present (booleans only — the actual values are never logged).
- Reads (never writes) `supervised_intake_control` and `ai_extraction_control` and reports both.
- **Creates nothing.** No batch row, no claim, no claim-state file, no provider call, ever.

Exit code is `0` only when the batch is genuinely ready to run for real — which requires `ai_extraction_control.enabled = true`. In any environment where that flag is intentionally kept `false` (a kill-switch-disabled canary/staging environment, or this project's own local development database), a dry-run against an otherwise well-formed batch will legitimately report exit code `2` with the message `ai_extraction_control.enabled is false -- a real run would reject every reservation.` This is the dry-run doing its job, not a bug — it is telling you a real run would be rejected before spending anything.

## 3. Batch input file schema

A single JSON object. Every field is required; **no other field is permitted** — an unknown field, or any of the explicitly forbidden fields below, fails validation before the file is ever sent to the database.

| Field | Type | Notes |
|---|---|---|
| `idempotencyKey` | string, 1–256 chars, `[A-Za-z0-9._:-]` | Re-running the CLI with the same value never creates a second batch. |
| `operatorReference` | string, 3–64 chars, `[A-Za-z0-9._@-]` | Who/what requested this batch — never a secret. |
| `signalEvidenceIds` | array of UUID strings, 1–500 items, no duplicates | The real limit is enforced server-side by `supervised_intake_control.max_batch_items`; this is only a file-sanity ceiling. |
| `provider`, `model`, `normalizationVersion`, `extractionSchemaVersion`, `promptVersion` | must byte-match `extraction-config.ts`'s pinned constants | The extraction pipeline is not parameterizable — these fields exist so the batch's own recorded digest matches what will actually run, not so an operator can choose a different model/version. |
| `deterministicExtractorVersion` | must be exactly `null` | This pipeline only ever produces `ai_assisted` extractions. |

**Never include:** `confidence`, `specificity`, `structuredOutput`/`structured_output`, `reviewOutcome`/`review_outcome`, `manualReviewConfirmed`/`manual_review_confirmed`, `semanticTopicId`/`semantic_topic_id`, `approvalDigest`/`approval_digest`, any credential/API-key field, `maxBatchItems`/`max_batch_items`, `maxDailyClaimedItems`/`max_daily_claimed_items`, `intakeLimitOverride`, `aiExtractionControlOverride`, `humanReviewFlagOverride`. All of these are rejected explicitly, by name, even though an unknown-field check would already catch them.

## 4. Safe startup

```bash
node scripts/supervised-intake-runner.ts --input path/to/batch.json [--claim-state path/to/state.json]
```

1. Always dry-run the identical file first (§2) and read its report.
2. `--claim-state` defaults to `.supervised-intake/claim-state.json` under the current working directory. That path is already `.gitignore`d — never commit it, never move it into a location that isn't.
3. If a claim-state file already exists at that path when the CLI starts, it is never blindly trusted — see §9 (restart).
4. The CLI registers `SIGINT`/`SIGTERM` handlers before it ever claims anything (§8) — it is always safe to signal it once and wait.

## 5. Claim-state file

- Written **before** `begin_intake_attempt_call` and before any provider call, via an atomic temp-file-then-rename (never a partially-written file on disk).
- File permissions are narrowed to `0600` on write on POSIX; on Windows/NTFS, `chmod` is best-effort and its failure is never fatal (there is no equivalent POSIX-mode narrowing to fall back to).
- Contains the plaintext claim token (needed to call `begin`/`complete`/`fail` for that specific claim) — this is exactly why the file must never be committed, copied into a log, or pasted anywhere. Every logged event redacts it; only the on-disk file itself ever carries it.
- Cleared automatically on a fully resolved item (success or a resolved failure). **Preserved on purpose** when the item's true outcome is unknown (`calling`, unresolved) — that is the forensic trail a separate reconciliation pass needs.
- Cleanup (`store.clear()`) only ever touches the exact path it was constructed with, and tolerates the file already being absent.

## 6. Exit codes

| Code | Meaning |
|---|---|
| `0` | Completed — dry-run passed, or a real run's batch fully finalized (which may still include item-local failures; see `completed_with_failures`). |
| `2` | Validation or config error — bad input file, missing/invalid environment, unsupported Node version, intake policy disabled at batch-creation time. |
| `3` | Batch stopped — a batch-fatal condition (kill switch, budget, an unrecognized error class, a shutdown signal) closed the batch before every item was processed. |
| `4` | Reconciliation required — an attempt's true provider outcome is unknown, or an existing local claim-state file cannot be safely resumed. Never resolved automatically by this runner. |
| `5` | Unexpected internal error — an RPC call itself failed unexpectedly (network, malformed response), or (see §9) `finalize_intake_batch` legitimately refused to close a batch while an item was still claimed/in-flight for a reason this runner does not have a dedicated code for. Always fail-closed, never a silent partial success. |

## 7. Kill switch (`ai_extraction_control`)

When `ai_extraction_control.enabled = false`, this runner detects it **before spending an RPC round-trip or a reservation** (a direct, typed read of the flag, not an inference from a failed call) and stops the batch with reason code exactly `AI_EXTRACTION_DISABLED` — distinct from the generic `AUTHORIZATION_OR_CONFIG_ERROR` every other reservation-layer rejection produces. Zero providers calls, zero reservations, ever, while the switch is off.

`configure_supervised_intake_control` and any change to `ai_extraction_control` are **explicit, separate operator actions** — this runner never calls either on its own, and never turns anything on for itself.

## 8. `stopped` vs `reconciliation_required`

- **`stopped`** (exit `3`): the batch's true state is fully known — every item is either resolved (succeeded/failed) or was never touched. Safe to leave as-is; a new batch (fresh idempotency key) can be started once the underlying condition (kill switch, budget, policy) is addressed.
- **`reconciliation_pending`/`reconciliation_required`** (exit `4`): at least one attempt's real outcome is genuinely unknown (the provider call may or may not have gone through) — this runner **never** guesses, never retries it, and never auto-resolves it. Resolving it requires the separate, explicit operator actions `reconcile_stale_intake_claims` (only after the claim's lease has expired) followed by `resolve_intake_attempt_reconciliation`. Do not start a new run against the same evidence until this is resolved.

## 9. Restart behavior

On startup, if a local claim-state file exists, the CLI **always re-reads the current server-side status** before trusting it (never blind local-file trust):

| Server-side attempt status | Behavior |
|---|---|
| `prepared` | Resumable — resumes at `begin_intake_attempt_call` (idempotent). Never re-claims, never calls the provider for a *different* attempt. |
| `calling` | **Blocked.** Exit `4`. The provider outcome is unknown; this runner will never re-drive it into a second provider call. |
| `completed` / `failed_retryable` / `failed_terminal` | Stale-resolved — a separate pass already resolved it since the file was written. The stale local file is cleared and the run proceeds normally. |
| `reconciliation_required` | Blocked. Exit `4`. |
| not found | Blocked. Exit `4` (cannot safely resume without knowing what happened). |

Re-running the CLI with the **same** batch idempotency key never creates a second batch — `create_supervised_intake_batch` replays the original result. A genuinely new batch requires a new idempotency key.

**Lost claim-state file:** if a claim succeeded server-side but the local file was never durably written (disk failure, etc.), that claim becomes permanently unreachable to any future run of this CLI — by design, since the plaintext claim token existed nowhere else. It sits as a `claimed`/`prepared` item until its lease expires and a separate `reconcile_stale_intake_claims` pass frees it. A later run of this CLI against the same batch will process every *other* remaining item normally, but `finalize_intake_batch` will then correctly refuse to close the batch while that one item is still in flight — surfaced as exit `5` (see §6). This is a safe, fail-closed outcome, not a corruption: nothing was double-processed, and the orphaned item is exactly where reconciliation expects to find it.

## 10. Forbidden operations (never do these from this CLI or by editing its output)

- Never set `ai_extraction_control.enabled = true` from this runner, from a script, or by hand, outside of an explicitly and separately authorized production change with its own approval.
- Never pass a provider-override, structured-output, confidence, or review-outcome field into a batch file — the input contract rejects all of them by name.
- Never manually retry a `failed_terminal` (non-retryable) item. A charged/potentially-charged failed attempt (e.g. `malformed_output`) is deliberately `retryable = false` — `authorize_intake_item_retry` has no cost-awareness of its own and trusts this flag completely. A future paid retry requires its own explicit financial/operator authorization, not something this CLI or its operator grants by editing the database.
- Never call `reconcile_stale_intake_claims`, `resolve_intake_attempt_reconciliation`, `configure_supervised_intake_control`, or `cancel_intake_batch` from an automated wrapper around this CLI — they are separate, explicitly human-invoked operator actions by design.
- Never commit, copy, or paste the contents of a claim-state file anywhere (§5).
- Never run this CLI against a production Supabase URL/key without a separate, explicit, phase-by-phase approval for that specific run.

## 11. Cleanup

- A successfully resolved run leaves no claim-state file behind (§5).
- `.supervised-intake/` is git-ignored; nothing under it should ever appear in `git status` as untracked-and-intended.
- If a run stops (§8) partway through and you are certain no further action is needed against that batch (e.g. it was a deliberate local test), the claim-state file can be deleted manually — but never while any item is still `claimed`/`calling` server-side without first confirming its resolution or explicitly accepting that it is left for reconciliation.

## 12. Evidence to keep after a canary run

For any real (non-local) canary run, before considering it closed, preserve:

- The exact batch input file used (it contains no secrets — see §3's forbidden-field list).
- The full stdout/stderr log of the run (already redacted — never contains a claim token, a service-role key, or a raw provider response).
- The final `supervised_intake_batches` row's `status` and `reason_code`, and every `supervised_intake_batch_items` row's `status`/`reason_code`/`retryable` for that batch.
- The corresponding `supervised_intake_events` rows for the batch (the append-only audit trail).
- Confirmation that `ai_extraction_control` and `supervised_intake_control` are in the intended post-run state.

Never preserve, log, or paste anywhere: a plaintext claim token, the service-role key, or raw provider request/response content.

## 13. Provider Failure Taxonomy v0

`lib/semantic-topic/provider-error-taxonomy.ts` classifies every way a real Anthropic provider call can fail, based **exclusively on the SDK's own structured `status` field** (never on error message text). This replaced an earlier design where every definitely-unbilled 4xx rejection (400/401/403/404) collapsed into one indistinguishable `provider_rejected_unbilled` string — the confirmed root cause of a real production incident where the actual HTTP status was permanently unrecoverable from stored logs.

| Category | HTTP | Billed | Retry policy |
|---|---|---|---|
| `authentication_failed` | 401 | unbilled | **never automatic** — account/config-level, batch stops |
| `permission_denied` | 403 | unbilled | **never automatic** — account/config-level, batch stops |
| `model_or_endpoint_not_found` | 404 | unbilled | **never automatic** — account/config-level, batch stops |
| `invalid_request_unbilled` | 400 | unbilled | **never automatic** — treated as config-level by default (no structured provider signal currently exists to prove a 400 was evidence-specific) |
| `provider_rejected_unbilled_unknown` | any other 4xx | unbilled | **never automatic** — defensive fallback, batch stops |
| `rate_limited` | 429 | uncertain | conservative — existing reconciliation path, unchanged |
| `provider_server_error` | 5xx | uncertain | conservative — existing reconciliation path, unchanged |
| `network_or_transport_uncertain` | none (timeout/network) | uncertain | conservative — existing reconciliation path, unchanged |
| `malformed_output_charged` | n/a (billed call, bad output) | billed | **never automatic** — unchanged from before this taxonomy |

**What actually happens at the item/batch level** (`decideItemOutcome`, `lib/semantic-topic/supervised-intake-runner.ts`): every one of the five never-automatic-unbilled categories stops the **whole batch** (`fail_item_and_stop_batch`, `stopReasonCode: 'AUTHORIZATION_OR_CONFIG_ERROR'`) rather than continuing to the next item — a bad key or missing model affects every remaining item identically, so burning through the rest of the batch one at a time would just repeat the identical failure. The failed item itself is stored with one of five new, specific `reason_code` values (migration `081`) — `PROVIDER_AUTHENTICATION_FAILED`, `PROVIDER_PERMISSION_DENIED`, `PROVIDER_MODEL_NOT_FOUND`, `PROVIDER_INVALID_REQUEST_UNBILLED`, `PROVIDER_REJECTED_UNBILLED_UNKNOWN` — always with `retryable = false`.

**A successful diagnosis never authorizes an automatic retry.** `authorize_intake_item_retry` (079) refuses any item whose `retryable` flag is not exactly `true`; none of the five categories above ever set it to `true`. Recovering an item stuck this way is a separate, explicit operator decision in its own gate — never something the diagnostic CLI below, or a passing diagnostic result, grants on its own.

## 14. Anthropic provider diagnostic CLI (`scripts/anthropic-provider-diagnostic.ts`)

A separate, minimal CLI for the one situation the redacted runner logs cannot resolve on their own: confirming *which* HTTP status a provider rejection actually was, after the fact, without touching the DB, without evidence data, and without more than one real (cheap) API call.

**Credential entry — never paste a key into chat, never pass it as a CLI argument:**

```powershell
scripts/anthropic-provider-diagnostic.ps1
```

The wrapper prompts for a typed `YES` confirmation, then the key via `Read-Host -AsSecureString` (never echoed), sets it as an environment variable **only for the lifetime of the one child `node` process it spawns**, and clears it again in a `finally` block that runs even on Ctrl+C or an error. The key is never written to a file, never appears in shell history, and is never passed as `--api-key` or any other argument.

**What it does:** exactly one `client.messages.create` call, `max_tokens: 1`, a fixed harmless prompt (`"Reply with the single word: ok"`), the exact same model identifier (`SEMANTIC_TOPIC_EXTRACTION_MODEL`) production extraction uses. No DB, no Supabase, no Vercel, no control-table read or write, no evidence data, no retry (`maxRetries: 0`).

**Maximum expected cost:** a handful of fixed-prompt input tokens plus at most 1 output token — a small fraction of a single cent, several orders of magnitude below any real extraction call.

**Interpreting the result** — the ONLY output is the structured, redacted classification (never the response text, never a raw provider error body):

| Exit code | Meaning |
|---|---|
| `0` | Success — the call completed. Key, model, and permissions are all working. |
| `1` | Config error — missing `--confirm-diagnostic`, or `ANTHROPIC_API_KEY` missing/empty. No call was attempted. |
| `2` | Provider failure, classified — see the printed `category`/`httpStatus`. This is the actual diagnosis. |
| `3` | Timeout or uncertain — no structured HTTP status available. Inconclusive; do not treat as confirming any specific cause. |
| `4` | Unexpected internal error. |

A `2` result tells you *which* category the real production failure most likely was (assuming the same key/model/network path) — it does **not** retry, resolve, or authorize retrying the original stuck evidence item. That remains a separate, explicitly authorized gate.

## 15. Identity-Linked Workspace Header Support v0 (superseded design, kept for history)

**Root cause of the real production `HTTP 400 invalid_request_unbilled` incident**, confirmed via a real diagnostic call and cross-checked against Anthropic's own documentation: the production Anthropic API key was an **identity-linked key** (Personal, scoped to "All workspaces" rather than one specific workspace). Anthropic requires every Messages API request made with a key of this type to carry the workspace it acts in via the `anthropic-workspace-id` request header; omitting it returns exactly the observed error: *"anthropic-workspace-id is required when authenticating with an identity-linked API key; send the id of the workspace this request acts in."* A malformed header value returns 400 `anthropic-workspace-id header must be a valid workspace ID.`; an unknown/inaccessible workspace returns 404. This is documented, expected Anthropic behavior for this key type, not a bug or an account/billing problem — a prior gate's Console read-only audit had already ruled out spend limits and credit exhaustion before this was found.

The original fix made `ANTHROPIC_WORKSPACE_ID` unconditionally required for every call, assuming the production key would stay identity-linked. **This assumption was abandoned** (see §16 below) once hands-on investigation confirmed the Anthropic Console UI cannot surface the Default Workspace's `wrkspc_` ID through any pure read-only action — the operational decision instead became: stop using an identity-linked key at all, and create a workspace-scoped one instead (which never needs this header in the first place). §16 describes the current, superseding design.

## 16. Explicit Anthropic Auth Scope Mode v0

**Design:** rather than assuming a key type, a new required environment variable, `ANTHROPIC_AUTH_SCOPE_MODE`, makes the choice explicit and closed:

| Value | Meaning | `ANTHROPIC_WORKSPACE_ID` | `anthropic-workspace-id` header |
|---|---|---|---|
| `workspace_scoped` | Key is scoped to exactly one workspace (chosen at key creation in the Console) | not read, not required | never sent |
| `identity_linked` | Key is NOT scoped to one workspace (e.g. "All workspaces") | required, validated (`wrkspc_...` format) | sent on every call |
| *(missing / anything else)* | — | — | **fail-closed**: `configuration_error`, zero provider calls |

The mode is **never inferred** from the key's own prefix, length, or any provider error message — always an explicit, separately-configured value (`lib/semantic-topic/anthropic-workspace-config.ts`, `resolveAnthropicAuthConfig()`).

**Fail-closed contract:** checked inside `runShadowExtraction` (`extraction-service.ts`) BEFORE any quota reservation or provider call — right alongside the existing oversized-input check — so a missing/unknown mode, or a missing/malformed workspace ID in `identity_linked` mode, can never consume a reservation or attempt a call that would fail identically for every remaining item in a batch. A cache hit is unaffected (it never calls the provider at all). The failed item is stored with reason_code `ANTHROPIC_WORKSPACE_CONFIG_ERROR` (the **same** migration-`082` code used for every sub-case — no new migration was needed to widen this), `retryable = false` (a permanent deployment misconfiguration), batch-stop `AUTHORIZATION_OR_CONFIG_ERROR`.

**Provider adapter** (`lib/semantic-topic/provider-adapter.ts`): `buildAnthropicClientOptions()` is the ONE shared request-builder both branches route through — `workspace_scoped` omits the `defaultHeaders` key entirely (not an empty object, not `undefined` — the key is simply absent); `identity_linked` adds it with the validated workspace ID.

**Diagnostic CLI:** `scripts/anthropic-provider-diagnostic.ps1` now first asks the operator to pick the mode via a **closed, validated choice** (`[1] workspace_scoped` / `[2] identity_linked`, a `while` loop that only accepts those two inputs — never free text). Only in `identity_linked` mode does it then prompt for the workspace ID, via its own separate `Read-Host -AsSecureString` call. In `workspace_scoped` mode, `ANTHROPIC_WORKSPACE_ID` is unconditionally cleared before the child process starts (even if a stale value is present in the parent shell from an earlier `identity_linked` run in the same terminal session), so it can never leak into the header decision. Both credentials are cleared in the same `finally` block as before; the mode itself is not sensitive and is echoed back to the operator for confirmation, but neither the key nor the workspace ID value/prefix/length/fingerprint ever appears in output.

**Production Vercel configuration (future, separately authorized gate — NOT performed by the gate that introduced this design):**
- `ANTHROPIC_AUTH_SCOPE_MODE=workspace_scoped`
- A **new** production API key, explicitly scoped to the Default Workspace at creation time (never "All workspaces")
- `ANTHROPIC_WORKSPACE_ID` should NOT be needed and should ideally not be set at all
- The old, identity-linked "replacement" key stays active until a successful diagnostic + deploy confirms the new key works — only then is it revoked, itself a separate, explicitly authorized step
- The env change and redeploy happen in their own dedicated production gate, never bundled with a code-only change
