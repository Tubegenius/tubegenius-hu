# Semantic Topic Identity v0 — Canonical Schema Contract (S1)

Status: **S1 (schema-only, fully inert) implemented locally.** `supabase/migrations/072_semantic_topic_identity_foundation.sql`. No RPC, no trigger, no backfill, no cron, no route, no UI, no TypeScript caller, no AI/provider call, no data write in this phase — this migration cannot create a single row of application data by itself.

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
