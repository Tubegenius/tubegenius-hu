# Semantic Topic Identity v0 — Canonical Schema Contract (S1 + S2A)

Status: **S1 (schema-only, fully inert) + S2A (writerless audit/provenance schema + temporal hardening) implemented locally.** S1: `supabase/migrations/072_semantic_topic_identity_foundation.sql`. S2A: `supabase/migrations/073_semantic_topic_s2a_audit_and_temporal_hardening.sql`. Neither phase has an RPC, a trigger, a backfill, a cron, a route, a UI, a TypeScript caller, an AI/provider call, or any data write — S2A adds three new tables and hardens the temporal invariant on the S1 membership table, but nothing in either phase can create a single row of application data by itself (`service_role` is `SELECT`-only on every table this contract covers).

## 1. Source of truth and precedence

This contract reflects the single, final specification for this phase: **"PFM Semantic Topic Identity v0 — Final SQL Correctness Correction Gate."** It was preceded by two earlier, now-superseded design passes (a conceptual layer model, then a first exact-schema draft) recorded only in prior session memory — those are historical context, not a separate source of truth; wherever this document and that history would differ, this document and migration 072 win.

The decision to build this at all follows directly from a calibration-audit finding recorded against the existing Shadow Topic v0 pipeline (see `docs/architecture/shadow-topic-v0-contract.md`, and below, §9): the current single production `signal_clusters` row is semantically incoherent — it mixes ten unrelated stories under one `(category, seed_text)` fingerprint, because the scheduled-discovery capture path that populates it does no similarity check at all. Semantic Topic Identity is the planned replacement layer; S1 is only its schema foundation.

## 2. Scope — exactly two tables, nothing else

`semantic_topics` and `semantic_topic_membership`. No event table, no decision table, no lineage table, no scoring table, no lane table, no Creative DNA table. No RPC, no trigger, no backfill, no data write, no `ALTER` on any pre-existing table — not `signal_clusters`, not `signal_cluster_evidence`, not `signal_score_runs`/`signal_cluster_scores`, not `signal_evidence`, not the 070/071 scoring function, not the collector/control/seed tables, not `creator_memory`/`video_ideas`.

Explicitly **not** in S1 (deferred to a later phase, together with their writer RPCs): `semantic_topic_membership_events`, `topic_assignment_decisions`, `semantic_topic_lineage_operations` + `edges`. These arrive, if at all, only alongside the SECURITY DEFINER writer RPC that would populate them — following the same "empty validated schema first, writer later" pattern the Shadow Topic v0 069→070 migrations used.

## 3. Legacy discovery bucket vs. semantic topic — two different concepts, deliberately kept apart

`signal_clusters` (the existing legacy table) is a **discovery bucket**: a deterministic text-fingerprint grouping keyed on `(category, seed_text)`, produced by the scheduled-discovery capture path with no semantic similarity check. It is what the Shadow Topic v0 scoring pipeline (069–071) currently scores, and it is known to be semantically incoherent in production today.

`semantic_topics` is a **semantic identity**: a candidate real-world topic, asserted by a specific evidence-linking event and tracked through an explicit lifecycle (`candidate_singleton` → ... → `coherent`/`split_required`/`merge_candidate`/`superseded`/`archived`). The two concepts are intentionally not merged into one table and not cross-referenced by any FK in S1 — `semantic_topics` does not point at `signal_clusters`, and nothing in S1 alters how `signal_clusters` is populated or scored. The legacy discovery-bucket pipeline (collector, `signal_clusters`, Shadow Topic v0 scoring) continues to run completely unchanged after this migration.

## 4. `semantic_topics`

One row per candidate semantic topic identity.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | `gen_random_uuid()` |
| `lifecycle_status` | `TEXT NOT NULL DEFAULT 'candidate_singleton'` | `candidate_singleton` \| `corroborating` \| `coherent` \| `ambiguous` \| `split_required` \| `merge_candidate` \| `superseded` \| `archived` |
| `canonical_label` | `TEXT NOT NULL` | non-blank after `btrim` |
| `label_language` | `TEXT NOT NULL` | see §6 |
| `specificity` | `TEXT NOT NULL DEFAULT 'unknown'` | `specific` \| `generic` \| `unknown` |
| `creation_request_digest` | `TEXT NOT NULL` | 64 lowercase hex chars, `UNIQUE` — see §5 |
| `status_version` | `INTEGER NOT NULL DEFAULT 1` | `>= 1` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | see §7 |

Deliberately absent: a `UNIQUE` constraint on `canonical_label` (two topics may legitimately share a label — disambiguation is a semantic, not a textual, problem), a self-referencing `superseded_by_topic_id`/`split_from_topic_id` column (a normalized `operation_id` + `edges` model is the planned S2/S3 shape, not a half-built self-FK), any writer trigger, any lifecycle RPC, and any automatic `updated_at`-touching trigger.

## 5. `creation_request_digest` — request-idempotency only, not semantic identity

This field exists solely so that a retried creation request (same caller, same inputs, same call) does not create a duplicate row. It is **not** a semantic deduplication key: two different evidence items describing the same real-world phenomenon, submitted as two different creation requests, will legitimately produce two different `semantic_topics` rows with two different digests. Reconciling those two rows into one is a cross-evidence semantic problem — **DEFERRED_TO_S2** (embedding-similarity retrieval and/or manual-review adjudication, resolved through the `merge_candidate` lifecycle state, audited by whatever event/decision table S2 introduces). S1 has no writer, so no digest, duplicate or otherwise, can exist yet outside a test fixture.

## 6. `label_language` — v0-supported canonical BCP-47 subset

`CHECK (label_language ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$')` plus `CHECK (length(label_language) <= 15)`.

This is **a deliberately narrow, v0-supported subset of BCP-47** — not a general BCP-47 validator. It accepts: a 2–3 lowercase-letter primary subtag alone (`en`, `hu`, `id`, `und`); a primary subtag plus a 4-letter Titlecase script subtag (`zh-Hans`); a primary subtag plus a 2-letter uppercase region subtag (`pt-BR`); or all three combined (`zh-Hant-TW`). It rejects an empty string, an all-uppercase primary subtag (`ENG`), an underscore-separated locale (`hu_HU`), and a lowercase region subtag (`pt-br`) — case and separator matter, exactly as in real BCP-47, but subtag combinations and extensions (variants, extensions, private-use tags) beyond this fixed shape are out of scope and will be rejected even if they are valid BCP-47 in the abstract. Widening this regex, if a future language ever needs a shape outside it, is a schema change, not a runtime concern.

## 7. `updated_at` / `status_version` — S1 declares the field, S2 owns the behavior

Both columns exist in the S1 schema so that a future writer does not require a schema migration to start using them, but **S1 itself never writes a second row and never updates a first one** (there is no writer at all — see §10). The transactional semantics — that `status_version` increments exactly once per accepted lifecycle transition, and `updated_at` moves in the same transaction as any content or lifecycle change — are a S2 SECURITY DEFINER writer RPC's responsibility, not a DB trigger. No trigger enforces this in S1, and none should be inferred from the column's presence.

## 8. `semantic_topic_membership`

One row per (evidence, topic) assignment interval — the temporal join between evidence and semantic identity.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `semantic_topic_id` | `UUID NOT NULL FK → semantic_topics(id) ON DELETE RESTRICT` | |
| `signal_evidence_id` | `UUID NOT NULL FK → signal_evidence(id) ON DELETE RESTRICT` | |
| `valid_from` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `valid_to` | `TIMESTAMPTZ NULL` | `NULL` = currently active; `CHECK` requires `valid_to > valid_from` when set |
| `assignment_reason` | `TEXT NOT NULL` | `entity_event_match` \| `embedding_similarity` \| `manual_review_confirmed` \| `manual_review_override` |
| `confidence` | `NUMERIC(5,4) NOT NULL` | `0 <= confidence <= 1`, both endpoints allowed |
| `algorithm_version` | `INTEGER NOT NULL` | `>= 1` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

This is the **canonical membership source of truth** — an evidence item's current semantic topic is "the row with `valid_to IS NULL`," and its full assignment history is every row for that `signal_evidence_id` ordered by `valid_from`. There is no separate `_events` audit table in S1; the membership table itself is the history, via closed (`valid_to`-set) rows.

### Indexes

- `semantic_topic_membership_active_evidence_key` — `UNIQUE (signal_evidence_id) WHERE valid_to IS NULL`. Enforces **at most one active membership per evidence item**.
- `idx_semantic_topic_membership_active_topic` — `(semantic_topic_id) WHERE valid_to IS NULL`. Fast "current members of this topic" lookups.
- `idx_semantic_topic_membership_temporal` — `(semantic_topic_id, valid_from, valid_to)`. Fast historical/point-in-time queries.

### Temporal non-overlap — DEFERRED_TO_S2

The partial unique index above guarantees only that an evidence item has **at most one currently-active** membership. It does **not** guarantee that an evidence item's full history of *closed* intervals never overlaps in time (e.g. two rows both claiming `valid_from=T1, valid_to=T3` and `valid_from=T2, valid_to=T4` with `T1<T2<T3<T4`). A true non-overlap guarantee would need `EXCLUDE USING gist (signal_evidence_id WITH =, tstzrange(valid_from, valid_to) WITH &&)`, which requires the `btree_gist` extension. **That extension is not installed by this migration and not assumed to be installed anywhere.** `TEMPORAL_NON_OVERLAP = DEFERRED_TO_S2`.

Because S1 has no writer (see §10), this is a structurally inert gap today — no code path can insert a membership row, let alone an overlapping one. Before any S2 writer RPC is allowed to write to this table, it must either (a) perform an application-level overlap check inside the same transaction, serialized behind a `pg_advisory_xact_lock` keyed on the evidence id, or (b) a separately approved migration must add the `btree_gist` exclusion constraint. One of those two is a hard prerequisite for the S2 writer, not an optional hardening step.

## 9. Lifecycle — states declared, runtime transitions DEFERRED_TO_S2

The eight `lifecycle_status` values are declared and `CHECK`-enforced as a closed set, but **no code enforces which transitions between them are legal** (e.g. that `archived` cannot go back to `candidate_singleton`). S1 is schema-only: any value in the enum can be written to any row at any time by a direct (test-only, since `service_role` has no `INSERT`/`UPDATE`) write. State-machine enforcement is a S2 writer-RPC responsibility. `LIFECYCLE_RUNTIME_ENFORCEMENT = DEFERRED_TO_S2`.

## 10. No writer in S1 — structurally, not just by convention

Both tables grant `service_role` **`SELECT` only**. `anon`/`authenticated`/`PUBLIC` have zero privileges on either table. There is no sequence, no function, no trigger associated with either table. This means: **no application code path, however buggy, can write a row to either table today** — not through the app's normal Supabase client (which authenticates as `service_role` or an end-user JWT, never as `postgres`), and not through any existing RPC (069–071's `run_shadow_topic_scoring` never references these tables). The only way a row can exist in either table right now is a manual `postgres`-privileged `INSERT`, which is exactly what the test fixtures in §12 do and nothing else does.

## 11. Security / grant matrix (as implemented in 072)

| | `semantic_topics` | `semantic_topic_membership` |
|---|---|---|
| Owner | `postgres` | `postgres` |
| RLS enabled + forced | yes | yes |
| Policies | 0 | 0 |
| `anon`/`authenticated`/`PUBLIC` | 0 grants | 0 grants |
| `service_role` | **`SELECT` only** | **`SELECT` only** |
| `service_role` INSERT/UPDATE/DELETE | none | none |
| Sequences | none | none |
| Functions | none | none |
| Triggers | none | none |

The 045/046/047 security baseline (function-execution hardening, default-privilege hardening, RLS auto-enable) is untouched by this migration — 072 adds two new tables under that same baseline, it does not alter the baseline itself.

## 12. Fail-closed migration contract

072 follows the same fail-closed idempotency pattern as 069 (Shadow Topic v0 schema): a `DO` block per table checks existence first. If the table is absent, it runs the `CREATE` branch (table + indexes + RLS + grant). If the table is already present, it runs a `VALIDATE` branch that never executes DDL/DCL — it only compares the live column/constraint/index/RLS/policy/grant state against the exact expected shape, and `RAISE EXCEPTION`s on any mismatch (drift), with no auto-repair and no `DROP`/`RECREATE`.

072 adds one more layer ahead of both per-table blocks: a **global topology gate**. It counts how many of the two target tables currently exist. `0` means both blocks will take the `CREATE` branch; `2` means both will take the `VALIDATE` branch; `1` (a partially-applied prior attempt) triggers an immediate `RAISE EXCEPTION` before either per-table block runs, so a half-applied state can never proceed into a `CREATE` on the missing table. Verified locally: running 072 twice against a clean DB is a byte-exact no-op on the second run (confirmed via the DB-integration re-run test, §13), and forcing a 1-of-2 state (dropping one table only) causes the gate to raise before any DDL executes, leaving the surviving table completely untouched (the whole migration is one `BEGIN`/`COMMIT` transaction).

## 13. DB-integration tests

`tests/semantic-topic-identity-schema-db-integration.test.ts` — same pattern as the existing `shadow-topic-score-schema-db-integration.test.ts`: runs only against the existing local Docker Supabase stack (`supabase_db_WillViralFinal`), skips entirely (not a failure) when that stack is unavailable, uses direct `postgres`-privileged `psql` fixture inserts (there being no writer RPC to call instead), and uses `SET ROLE` for real grant-boundary checks. Covers: fresh-migration table count, second-run no-op, the 1-of-2 topology exception, column/constraint/index drift fail-closed, 0 `NOT VALID` constraints, every `CHECK` domain (lifecycle, specificity, language accept/reject matrix, digest format/uniqueness, assignment_reason, confidence bounds, algorithm_version, `valid_to > valid_from`), the active-membership partial unique index (rejects a second concurrently-active row, allows multiple closed historical rows for the same evidence), FK `RESTRICT` behavior, and the full RLS/policy/grant matrix including `service_role`/`anon`/`authenticated` `SET ROLE` checks. It explicitly does **not** claim to test temporal non-overlap across closed intervals — per §8, that guarantee does not exist in S1, and the test suite documents this rather than asserting a false pass.

## 14. What this migration explicitly does not do

No AI/provider call, no backfill of any existing `signal_clusters`/`signal_evidence` data into these tables, no scoring, no use in any ranking or recommendation surface, no change to the collector/cron/control tables, no change to `creator_memory`/`video_ideas`, no change to the Creator Lane, no new route, and no change to the currently-live, semantically-mixed legacy `signal_clusters` cluster or its Shadow Topic v0 V1/V2 scores — those remain exactly as they are today: a known-incoherent, immutable diagnostic artifact (see `docs/architecture/shadow-topic-v0-contract.md` §13), not a data source this migration reads from or writes to.

---

# S2A — Writerless Audit/Provenance Schema + Temporal Hardening

S2A adds three new, still-writerless tables and closes the S1 `TEMPORAL_NON_OVERLAP = DEFERRED_TO_S2` gap. It does **not** add a writer RPC — that is S2B/S2C. Canonical source: "PFM Semantic Topic Identity v0 — S2 Final Pre-Implementation Correctness Gate."

## 15. `topic_extraction_runs` — one row per terminal extraction attempt

**Terminal, immutable model (not start/finish):** `status` is `CHECK (status IN ('completed', 'failed'))` — there is no `processing` value in the schema. The table records only settled attempts; a crash/timeout that never reaches a settlement is tracked by the provider-reservation system (059–066), not here. There is **no** `invalidated_at` or `superseded_by_extraction_run_id` — the table is genuinely INSERT-only, never UPDATE, so calling it immutable is not just a claim no code path contradicts.

**Two-layer provenance**, replacing the earlier single "input_snapshot" idea:
- `source_snapshot` / `source_snapshot_digest` — built **by a future RPC directly from the live `signal_evidence` row**, never accepted as client JSON. Digest computed server-side.
- `normalized_extraction_input` / `normalized_input_digest` — the actual normalized text the extractor consumed; caller-supplied (normalization happens in the application layer), but the digest is recomputed server-side from the supplied text, so it is at least self-consistent (though it cannot prove the normalization *process* was correct).

**Provider/model/prompt pairing** — explicit two-branch, fully-closed CHECK: `deterministic` requires `provider`/`model`/`prompt_version` all `NULL` and `deterministic_extractor_version` set; `ai_assisted` requires all three non-blank (length-bounded) and `deterministic_extractor_version NULL`. No partial combination on either branch is legal.

**Cache identity** — `extraction_config_digest` (hash of `extraction_method, normalization_version, extraction_schema_version, provider, model, prompt_version, deterministic_extractor_version`) plus `(signal_evidence_id, normalized_input_digest)` forms the cache key. A **partial unique index** (`topic_extraction_runs_completed_cache_key`, `WHERE status = 'completed'`) allows at most one completed result per exact cache key, while `failed` attempts may retry indefinitely under fresh `idempotency_key`s. `idempotency_key` remains pure request-idempotency, unrelated to cache identity.

**`structured_output`** (only present when `status='completed'`) must conform to the `topic_extraction_output_v1` contract — enforced by CHECK as far as a non-subquery expression allows: object type, **no unknown top-level keys** (`structured_output - ARRAY[...] = '{}'`), required scalar fields present/typed/length-bounded, `label_language` against the same S1 BCP-47 subset regex, `specificity`/`content_format` enums, `confidence` range, `subject_entities`/`supporting_spans` array-typed with bounded length, and the embedded `extraction_schema_version` cross-checked against the column. Per-element structure inside the arrays (e.g. each `supporting_spans` object's own shape) is **not** DB-enforceable via CHECK (Postgres CHECK constraints cannot contain subqueries or set-returning functions) — that remains an S2B/RPC responsibility. `supporting_spans` elements are `{source_field, quoted_text}` only — **no offsets** (avoids UTF-16/codepoint/Postgres-index ambiguity); `quoted_text` is expected, not DB-enforced, to be a verbatim substring of the corresponding `source_snapshot` field.

`estimated_cost_usd`/`input_tokens`/`output_tokens` are **diagnostic only**, not wired to the collector's `signal_provider_daily_budgets`/`reserve_provider_units` system in any way in S2A (see §18).

## 16. `topic_assignment_decisions` — one row per settled assignment decision

`UNIQUE(extraction_run_id)` — exactly one decision per extraction, 1:1. `outcome IN ('CREATE_NEW', 'ATTACH_EXISTING', 'QUARANTINE')`, paired with `semantic_topic_id`/`resulting_membership_id` (both NULL iff `QUARANTINE`, both NOT NULL otherwise). `decision_reason` is a 7-value enum; S2's own (not-yet-written) RPC will in practice only ever produce `no_similar_topic_found` and `exact_entity_match` — `embedding_similarity_match` and the `manual_review_*` values are schema-reserved for S3. No `invalidated_at` — same immutability stance as `topic_extraction_runs`.

## 17. `semantic_topic_membership_events` — append-only decision-provenance log

Complements (does not duplicate) the S1 membership table's own temporal history: the membership table records *what was true when*, this table records *why a transition happened and under which decision*. `related_assignment_decision_id` is **`NOT NULL`** — every event, including any future manual correction, must carry a real `topic_assignment_decisions` row; there is no audit-free nullable escape hatch. `event_type IN ('attached', 'detached', 'reassigned')`.

## 18. `semantic_topic_membership.assignment_reason` — `topic_creation_seed` added

The original 072 four-value enum (`entity_event_match`, `embedding_similarity`, `manual_review_confirmed`, `manual_review_override`) had no value that correctly describes a `CREATE_NEW` topic's first membership — it isn't a *match* to anything pre-existing. S2A adds a fifth value, **`topic_creation_seed`**, via a fail-closed `DROP CONSTRAINT`/`ADD CONSTRAINT` pair that only proceeds from the exact, byte-verified 072 legacy definition (or is a no-op if already corrected) — any other observed definition is `DEFINITION_DRIFT`, migration aborts, no auto-repair.

## 19. Temporal non-overlap — `DEFERRED_TO_S2` closed

### `btree_gist` install — fail-closed preflight, not just post-install validation

Before any DDL runs, the `NOT EXISTS` branch checks **two facts from the live catalog**: `pg_available_extension_versions` genuinely offers the expected version (`1.7`) on this PostgreSQL installation, and the target schema (`extensions` — the same convention `pgcrypto` already uses) exists. ("No `btree_gist` already installed in a different schema" is not a separate query — `pg_extension` can hold at most one row per extension name per database, so reaching this branch at all already proves that fact.) Either preflight failure is `RAISE EXCEPTION` before `CREATE EXTENSION` is ever issued. An already-present extension is checked for exact `(extversion, extnamespace)` match and left untouched otherwise (`RAISE EXCEPTION` on mismatch, never `ALTER`/`DROP EXTENSION`).

**The `VERSION` clause and its `WARNING` — documented precisely, not just described.** Command actually run when the extension is absent:

```sql
CREATE EXTENSION btree_gist WITH SCHEMA extensions;
```

An earlier draft of this migration also appended `VERSION '1.7'`. Running that variant (`CREATE EXTENSION btree_gist WITH SCHEMA extensions VERSION '1.7';`) as the `postgres` role — confirmed non-superuser on both local (`supabase_admin` holds superuser locally) and production — produces, verbatim, from the **PostgreSQL server's own `CREATE EXTENSION` DDL processing** (not psql, not the extension's install script):

```
WARNING:  only superusers can specify extension versions, ignoring version "1.7" and installing the default version
```

The clause is silently dropped and the default version installs instead — which happens to equal `1.7` here only because it is the *only* version `pg_available_extension_versions` currently offers for `btree_gist` on this PostgreSQL build, not because the clause took effect. The migration therefore does not pass `VERSION` at all (it would be theater), and instead makes the guarantee real via a **post-install self-check in the same transaction** — `extversion`/`extnamespace` are re-read immediately after `CREATE EXTENSION` and compared against the expected values; any mismatch `RAISE EXCEPTION`s. Verified locally by forcing both failure modes: an unavailable-version preflight failure leaves `pg_extension` with **zero** `btree_gist` rows (never reached `CREATE EXTENSION`), and a forced post-install self-check failure (extension genuinely installs as `1.7`, self-check deliberately told to expect something else) *also* leaves zero rows afterward — proving the single-transaction rollback undoes the extension creation itself, not just the error propagation.

### The `EXCLUDE` constraint — a real unbounded range, not an `infinity` sentinel

```sql
ALTER TABLE semantic_topic_membership ADD CONSTRAINT semantic_topic_membership_no_overlap
  EXCLUDE USING gist (
    signal_evidence_id WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&
  );
```

An earlier draft used `tstzrange(valid_from, coalesce(valid_to, 'infinity'::timestamptz), '[)')`. That is a real, storable `timestamptz` value standing in for "no upper bound" — not PostgreSQL's native unbounded-range representation, and nothing stopped a caller from writing the literal `'infinity'` timestamp into `valid_to` directly. The corrected form passes `valid_to` straight through: PostgreSQL's range constructor treats a `NULL` bound as genuinely unbounded (`upper_inf(...)` returns true, confirmed locally), which participates correctly in `&&` overlap comparisons without a sentinel value anywhere.

That alone doesn't stop `'infinity'`/`'-infinity'` from being written as an *explicit* value, so two more `CHECK` constraints close that gap directly, added via the same fail-closed CREATE/VALIDATE pattern (with a real precheck over existing rows before either is added):

- `semantic_topic_membership_valid_from_finite` — `CHECK (isfinite(valid_from))`
- `semantic_topic_membership_valid_to_finite` — `CHECK (valid_to IS NULL OR isfinite(valid_to))`

Verified locally: `valid_from`/`valid_to` = `infinity` or `-infinity` are all rejected (the `-infinity` `valid_to` case is caught by the pre-existing 072 `valid_to > valid_from` CHECK before it would even reach the new guard — both agree the row is invalid). An **empty range** can never be constructed either way: the only way a `tstzrange` becomes empty is a lower bound `>=` the upper bound, which the 072 `valid_to > valid_from` CHECK already excludes independently of the range-type machinery.

A mandatory **overlap precheck** (a real self-join over the live table, using the same finite `tstzrange` expression as the constraint itself) runs immediately before `ADD CONSTRAINT` and `RAISE EXCEPTION`s if any pre-existing overlapping pair is found — the constraint is never added over already-invalid data. Half-open `[valid_from, valid_to)` semantics mean **touching, non-overlapping intervals are explicitly allowed** (`[a,b)` followed by `[b,c)`). Verified locally: active–active, active–historical, and historical–historical overlaps for the same `signal_evidence_id` are all rejected; two genuinely concurrent overlapping inserts resolve to exactly one success. This constraint is defense-in-depth alongside (not a replacement for) whatever advisory-lock discipline a future S2B writer RPC also implements.

`TEMPORAL_NON_OVERLAP` is no longer `DEFERRED_TO_S2` as of this migration — it is closed at the schema level, for every current and future write path, including ones that don't yet exist.

## 20. Phase boundaries (S2A / S2B / S2C / S3)

- **S2A** (this migration): the three audit tables, the `assignment_reason` enum correction, `btree_gist` + the `EXCLUDE` constraint. Zero RPCs, zero provider/quota changes.
- **S2B** (not started): the two writer RPCs (`record_topic_extraction_run`, `record_topic_assignment_decision`) implemented and tested locally against **synthetic, deterministic-only** payloads. No production, no provider.
- **S2C** (not started): the S2B RPCs applied to production, inert — no application caller exists yet.
- **S3** (not started): the AI-provider/quota contract (a real architectural change to the existing `reserve_provider_units` RPC and its `usage_type`/`provider` CHECK constraints — confirmed by code audit to be non-trivial, not a simple additive row), an application-layer extraction service, and a controlled, explicitly-approved shadow replay over the 10 existing production evidence rows.

## 21. S2A DB-integration tests

`tests/semantic-topic-s2a-audit-temporal-db-integration.test.ts` — same local-Docker-only, direct-`postgres`-fixture pattern as the 072 suite (still no writer RPC to call). Covers: the 3-table topology gate (0/3, 3/3, every partial state), byte-exact second-run no-op across all six migration sub-blocks (three tables, `assignment_reason`, `btree_gist`, the finite-timestamp guard, the `EXCLUDE` constraint), the `assignment_reason` legacy→corrected transition and its `DEFINITION_DRIFT` rejection, all 5 `assignment_reason` values, `btree_gist` version/schema, the `EXCLUDE` constraint's exact (infinity-free) definition and its drift rejection, the overlap precheck (including a real forced-overlap scenario), active–active/active–historical/historical–historical overlap rejection, adjacent-interval acceptance, a real concurrent-insert race, the finite-timestamp guard (`infinity`/`-infinity` on both `valid_from` and `valid_to` rejected, `NULL valid_to` confirmed genuinely unbounded via `upper_inf(...)`, empty-range impossibility), every `topic_extraction_runs` pairing/domain/digest/cache-identity/structured-output-shape CHECK, `topic_assignment_decisions` outcome/reason/pairing/uniqueness/FK behavior, `semantic_topic_membership_events`' `NOT NULL` decision-reference enforcement, and the full RLS/policy/grant matrix (including `SET ROLE` checks) across all three new tables.

## 22. Cross-migration test isolation — schema-state-aware self-skip

`tests/semantic-topic-identity-schema-db-integration.test.ts` (the 072 suite) shares the same local Docker database as the 073 suite. Its destructive topology-gate and drift-fail-closed tests re-run the **072 file standalone** and require a byte-exact "no drift" result from that — a result 073 permanently changes once applied (073 adds FK-dependent tables onto `semantic_topic_membership`/`semantic_topics`, so a raw `DROP TABLE` would fail; 073 also legitimately extends `assignment_reason` to five values, so 072's own unchanged VALIDATE branch will forever see that as drift, correctly, since a later migration really did move the goalposts). One 072 test (`does NOT reject overlapping closed historical intervals...`) similarly asserts a documented S1-era gap that 073's `EXCLUDE` constraint intentionally closes.

None of that is corrected by having the 072 suite drop and rebuild 073's objects around itself — that was tried and rejected: it risks racing any other suite touching the same tables, and a suite that dies mid-test (a real risk with `ON_ERROR_STOP=1` fixture setup) can leave 073 permanently absent for everything that runs afterward. Instead, the 072 suite follows the exact convention `creator-lane-s1-legacy-compat-db-integration.test.ts` already established for the 067-vs-068 case: it detects the live schema state via one marker query (the literal text of `semantic_topic_membership_assignment_reason_check` — legacy 4-value vs. corrected 5-value) and self-skips only the state-incompatible describe blocks/tests with `describe.skip`/`it.skip` plus a `console.warn` explaining why and how to actually exercise them (temporarily remove 073, `supabase db reset`, run, restore, reset again) — the same pattern `describeIfLocalDb` already uses for a missing Docker stack. It never drops, alters, or rebuilds a single 073 object. Every non-destructive 072 invariant (column matrix, individual domain `CHECK`s, FK `RESTRICT`, the partial-unique active-membership index, the RLS/grant/`SET ROLE` matrix) runs unconditionally in both states, since 073 doesn't change any of those facts about the 072 tables themselves. Verified locally in both states: pre-073, all 61 tests run (0 skipped); post-073, 51 run and 10 self-skip with the expected warning, and the full repository-wide suite passes with 073's own objects provably undisturbed throughout.
