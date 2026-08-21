# Shadow Topic v0 — Canonical Schema & Computation Contract

Status: **S1 (schema-only) + S2 (deterministic scoring RPC, corrected to v2) implemented locally.** S1: `supabase/migrations/069_shadow_topic_score_schema.sql`. S2: `supabase/migrations/070_run_shadow_topic_scoring.sql` (v1, **provenance-defective, see §13 — do not use for calibration**) corrected by `supabase/migrations/071_fix_shadow_topic_snapshot_provenance.sql` (v2, `algorithm_version=2`, `input_snapshot_schema_version=2`; same function identity `public.run_shadow_topic_scoring(timestamptz, timestamptz, text) RETURNS jsonb`). No cron, no route, no UI, no TypeScript caller in this phase. `ranking_eligible` is hard-`false` for every row the v0 RPC can ever produce, in both v1 and v2.

## 1. Source of truth and precedence

This contract consolidates three chat-delivered specification documents, in increasing priority (a later document corrects/overrides an earlier one wherever they conflict):

1. **"PFM Shadow Topic v0 — Végleges Séma- és Számítási Szerződés"** — base contract. Established the two-table minimalist scope, the eligibility/aggregation rules, the `input_digest`-based reproducibility decision (over a junction table), and the initial `signal_score_runs` / `signal_cluster_scores` column drafts.
2. **"PFM Shadow Topic v0 — Final Schema Closure Gate"** — corrected the base contract: replaced the single `raw_freshness`/`confidence_value` model with three separate raw metrics and per-component (freshness/velocity) confidence buckets; introduced the `input_snapshot` JSONB provenance mechanism and its canonical serialization rules; issued a `HOLD` pending a natural production observation-run audit.
3. **"PFM Shadow Topic v0 — Final Technical Correction Gate"** — highest-priority technical corrections, reflected exactly in this document and in migration 069: added `algorithm_config_snapshot`/`algorithm_config_schema_version` (the config itself is now archived, not just its hash); converted `freshness_coverage`/`velocity_coverage` to `GENERATED ALWAYS AS ... STORED` columns; added the missing non-negativity CHECKs; added `scs_max_observed_at_pairing`; corrected the grant matrix to **`SELECT`-only** for `service_role` on both tables (superseding document 1's `INSERT`/`UPDATE` grants — all future writes go through SECURITY DEFINER RPCs, not direct table grants); specified exact timestamp/large-integer snapshot precision rules; and issued the final `TECHNICAL_SCHEMA_STATUS = GO` / `IMPLEMENTATION_TIMING_STATUS = HOLD_UNTIL_OBSERVATION_AUDIT_PASS` verdict.

The `HOLD` was lifted after a real production `observation_stats` collector run passed its integrity audit (7 evidence, 21 `signal_observations`, all schedules correctly transitioned to `daily` cadence, 0 orphans, 0 duplicates, 0 stuck runs, provider ledger integrity confirmed) — timing status is now `GO`, which is what authorized this S1 implementation.

## 2. Scope — exactly two tables, nothing else

`signal_score_runs` and `signal_cluster_scores`. No third table (no junction/provenance table — reproducibility is achieved via `input_digest` + `input_snapshot` instead, see §6). No RPC, no trigger, no backfill, no data write, and no `ALTER` on any pre-existing `signal_*` table in this migration.

Explicitly **not** in v0 (from document 1's closing list, still valid): `signal_evidence_scores`, `signal_personalized_ranks`, `profiles.default_content_strategy_mode`, any entertainment-score field, a Creative DNA field, API/UI, score-computation code, provider calls, cron integration, RPC logic, `normalized_freshness`/`normalized_velocity` columns, a composite/final score column, experimental novelty/saturation fields, a junction/provenance table, a `skipped` run status, `cohort_key`, `normalization_status`.

## 3. `signal_score_runs`

One row per score computation run (a specific `(score_profile, algorithm_version, algorithm_config_hash, evaluation_time, input_cutoff)` combination).

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | `gen_random_uuid()` |
| `score_profile` | `TEXT NOT NULL` | fixed to `'shadow_topic_v0'` in v0 |
| `layer` | `TEXT NOT NULL` | fixed to `'cluster_topic'` in v0 |
| `algorithm_version` | `INTEGER NOT NULL` | `>= 1` |
| `algorithm_config_hash` | `TEXT NOT NULL` | SHA-256 of the canonical `algorithm_config_snapshot`, 64 lowercase hex chars |
| `algorithm_config_snapshot` | `JSONB NOT NULL` | the config itself, archived (not just its hash) |
| `algorithm_config_schema_version` | `INTEGER NOT NULL` | `>= 1` |
| `evaluation_time` | `TIMESTAMPTZ NOT NULL` | the formula's reference "now" — explicit parameter, never `now()` |
| `input_cutoff` | `TIMESTAMPTZ NOT NULL` | no input newer than this may enter the computation; `<= evaluation_time` |
| `status` | `TEXT NOT NULL DEFAULT 'processing'` | `processing` \| `completed` \| `failed` — no `skipped` (v0 has no cron/automated trigger, every run is an explicit direct call) |
| `error_class` | `TEXT` | only when `status='failed'` |
| `idempotency_key` | `TEXT NOT NULL` | caller-supplied, non-blank, globally unique |
| `started_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | doubles as "computed_at" — no separate column for that |
| `completed_at` | `TIMESTAMPTZ` | required iff status is terminal |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

No `skipped` status: v0 has no cron/automated trigger, so there is no code path that would produce a "nothing to compute, skipping" run — every run starts from an explicit, direct call.

## 4. `signal_cluster_scores`

One row per `(score_run, cluster)` pair — the diagnostic, non-ranking raw-component snapshot.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `score_run_id` | `UUID NOT NULL FK → signal_score_runs(id) ON DELETE RESTRICT` | |
| `signal_cluster_id` | `UUID NOT NULL FK → signal_clusters(id) ON DELETE RESTRICT` | |
| `evidence_count` | `INTEGER NOT NULL` | all evidence types (youtube_video/serper_news/serper_web) — "topic breadth," not "measurement breadth" |
| `source_breadth` | `INTEGER NOT NULL` | distinct `signal_sources` backing the cluster; `<= evidence_count` |
| `youtube_evidence_count` | `INTEGER NOT NULL` | `<= evidence_count`; only YouTube evidence has `published_at` + a measurable metric time series |
| `median_discovery_lag_hours` | `NUMERIC(12,4)` | see §5 |
| `median_observation_age_hours` | `NUMERIC(12,4)` | see §5 |
| `median_average_view_velocity_per_hour` | `NUMERIC(20,6)` | see §5 |
| `freshness_eligible_evidence_count` | `INTEGER NOT NULL` | `<= youtube_evidence_count` |
| `velocity_eligible_evidence_count` | `INTEGER NOT NULL` | `<= youtube_evidence_count` |
| `freshness_coverage` | `NUMERIC(5,4) GENERATED ALWAYS AS (...) STORED` | `freshness_eligible_evidence_count / youtube_evidence_count`, `0` when the denominator is `0` |
| `velocity_coverage` | `NUMERIC(5,4) GENERATED ALWAYS AS (...) STORED` | same shape, velocity variant |
| `freshness_confidence_class` | `TEXT NOT NULL` | `unknown` \| `proxy` \| `measured` |
| `velocity_confidence_class` | `TEXT NOT NULL` | `unknown` \| `proxy` \| `measured` |
| `freshness_exclusion_reason` | `TEXT` | `NULL` or `'no_eligible_evidence'` |
| `velocity_exclusion_reason` | `TEXT` | `NULL` or `'no_eligible_evidence'` |
| `ranking_eligible` | `BOOLEAN NOT NULL DEFAULT false` | **hard-`false` in v0**, `CHECK`-enforced |
| `input_snapshot` | `JSONB NOT NULL` | see §6 |
| `input_digest` | `TEXT NOT NULL` | SHA-256 of the canonical `input_snapshot` serialization, 64 lowercase hex chars |
| `input_snapshot_schema_version` | `INTEGER NOT NULL` | `>= 1` |
| `max_observed_at` | `TIMESTAMPTZ` | latest `observed_at` among the snapshot's `selected_for_calculation=true` observations; `NULL` iff both eligible counts are `0` |
| `sampling_policy` | `TEXT NOT NULL` | fixed to `'scheduled_only'` in v0 |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

`(score_run_id, signal_cluster_id)` is `UNIQUE` — a cluster is scored at most once per run. There is no `normalized_freshness`/`normalized_velocity`/final-score/personalized-rank column, no `cohort_key`, no `normalization_status` — none of these exist in v0.

**Cluster status is not filtered.** v0 deliberately scores clusters in every `signal_clusters.status` (`active`/`stale`/`merged`/`rejected`) for full-lifecycle diagnostic coverage — safe because `ranking_eligible` is always `false`. `cluster_status_snapshot` (alongside `cluster_category_snapshot`) lives inside `input_snapshot`, not as a separate scalar column, so a future analysis can filter on it via a JSONB path query without a schema change.

## 5. Signal formulas — exact, no decay/weighting/composite

Three independent raw metrics, no composite score, computed to full precision and rounded (Postgres default round-half-away-from-zero) only at the final stored value:

```
discovery_lag_hours(evidence) =
  GREATEST(0, EXTRACT(EPOCH FROM (first_seen_at - published_at)) / 3600)

observation_age_hours(evidence) =
  GREATEST(0, EXTRACT(EPOCH FROM (evaluation_time - latest_eligible_observed_at)) / 3600)

average_view_velocity_per_hour(evidence) =
  latest_eligible_view_count /
  GREATEST(
    EXTRACT(EPOCH FROM (latest_eligible_observed_at - published_at)) / 3600,
    minimum_age_hours   -- 1.0, a config-hash-versioned constant, not a DB column
  )
```

The cluster-level `median_*` value is the statistical median (average of the two middle values on an even count) of the per-evidence values across the **eligible** evidence set for that bucket.

### Eligibility (exact, non-negotiable definitions)

- **Freshness eligibility** = evidence has `published_at IS NOT NULL` **and** has at least one eligible observation (see below). Both freshness raw fields share this one gate (a documented, intentionally conservative trade-off: `discovery_lag_hours` alone would not technically need an observation, but the strict CHECK-pairing requires a single shared gate for both freshness fields).
- **Velocity eligibility** = the same eligible-observation condition **and** `published_at IS NOT NULL` (needed as the formula's denominator).
- **"Eligible observation"** = `metric_type='youtube_view_count'`, `cadence IN ('daily','weekly','early8h')` (never `on_demand` — scheduled and on-demand sampling must never silently mix), `observed_at <= input_cutoff`.
- **"Latest eligible observation"** (per evidence) = the eligible observation row with the maximum `observed_at`. Tie-break on equal `observed_at`: `observed_at DESC, bucket_start DESC, id ASC` (deterministic, `id` is a non-semantic final tiebreaker).
- `published_at <= evaluation_time` is also required; a future-dated `published_at` excludes the evidence from both buckets (folded into the generic `no_eligible_evidence` reason, no separate v0 enum value).

Because both bucket's eligibility conditions are currently identical, `freshness_eligible_evidence_count` and `velocity_eligible_evidence_count` are mathematically always equal in this formula version. This is **not** redundancy to collapse — a future formula version could decouple them (e.g. if `discovery_lag_hours` drops its observation requirement) without a schema change, since they are already two independent columns.

### Confidence thresholds (per component, independently)

| Eligible count | `*_confidence_class` |
|---|---|
| `0` | `unknown` |
| `1`–`2` | `proxy` |
| `>= 3` | `measured` |

There is **no** `confidence_value NUMERIC` field in v0 — a numeric confidence score without a validated formula would suggest false precision.

### Precision / rounding

| Field | Type | Rationale |
|---|---|---|
| `median_discovery_lag_hours` | `NUMERIC(12,4)` | up to ~10⁸ hours, 4 decimals ≈ 0.36s resolution |
| `median_observation_age_hours` | `NUMERIC(12,4)` | same |
| `median_average_view_velocity_per_hour` | `NUMERIC(20,6)` | room for very large view counts, 6-decimal rate precision |

All intermediate computation (per-evidence values, the median itself) is done at full precision; only the final stored median is rounded, at INSERT time, to the declared scale.

## 6. Reproducibility — `input_snapshot` + `input_digest`, no junction table

**Decision (document 1, §6, evidence-backed):** the append-only, immutable chain `signal_evidence → signal_cluster_evidence` means `evidence_count`/`source_breadth` are fully reproducible from `input_cutoff` alone — no junction table needed there. `signal_observations`, however, has a live `UPDATE` grant and its `apply_signal_observation_batch` RPC does perform idempotent-retry upserts on the same natural key — theoretically allowing a later value change on an already-read row, even though the collector's `next_due_at`/`last_observed_at` guard makes this practically a retry-only path today.

Rather than building a full FK-based junction/provenance table for this theoretical-only risk, `signal_cluster_scores` freezes the complete, actually-used evidence/observation values into a JSONB `input_snapshot`, hashed into `input_digest`. This makes any future drift **detectable** (recomputing with the same `input_cutoff` and getting a different digest is a signal) without paying the complexity cost of a junction table for a risk that has not been observed in practice. If a future natural-cron audit finds a genuine (non-retry) value change on an existing `signal_observations` natural key, this decision must be revisited and a junction table introduced in a follow-up migration.

### `input_snapshot` shape (top level)

**`schema_version` (this document's original design, only correctly implemented from v2 onward — see §13):**

```json
{
  "schema_version": 2,
  "cluster_id": "...",
  "cluster_category_snapshot": "tech_ai",
  "cluster_status_snapshot": "active",
  "evaluation_time": "2026-08-20T00:00:00.000000Z",
  "input_cutoff": "2026-08-20T00:00:00.000000Z",
  "evidence": [ ... ],
  "observations": [ ... ]
}
```

**Evidence element**: `evidence_id`, `evidence_type`, `source_id`, `published_at`, `first_seen_at`, `cluster_link_created_at`, `eligibility.freshness.{eligible,reason}`, `eligibility.velocity.{eligible,reason}`.

**Observation element**: `observation_id`, `evidence_id`, `metric_type`, `cadence`, `bucket_start`, `observed_at`, `metric_value` (decimal **string**, never a JSON number), `selected_for_calculation` (boolean — at most one `true` per evidence, marking the tie-break winner; the snapshot carries *every* cutoff-eligible-cadence observation per evidence, not just the winner). **This was always the design intent of this document, but v1/070 shipped without `metric_value` in the observation element — see §13. Only v2 (`input_snapshot_schema_version=2`) actually satisfies this paragraph.**

**Controlled `eligibility.reason` enum** (snapshot-internal, not a DB CHECK): `not_youtube_evidence`, `missing_published_at`, `published_after_evaluation_time`, `linked_after_input_cutoff`, `first_seen_after_input_cutoff`, `no_scheduled_view_observation`; `reason=null` when `eligible=true`.

### Canonical serialization rules (writer responsibility, not DB-enforced)

- Every object's keys lexicographically sorted.
- `evidence[]` sorted by `evidence_id`; `observations[]` sorted by `(evidence_id, observed_at, observation_id)`; eligibility ID lists lexicographically sorted.
- **Timestamps**: `YYYY-MM-DDTHH:mm:ss.ffffffZ` — always UTC, always exactly 6 fractional-second digits (zero-padded), never truncated to milliseconds. The writer must take the Postgres `timestamptz`'s microsecond-precision textual form directly (e.g. `to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`) and must **never** route it through a JavaScript `Date` object, which is millisecond-precision only. Affected fields: `evaluation_time`, `input_cutoff`, `first_seen_at`, `published_at`, `cluster_link_created_at`, `bucket_start`, `observed_at`.
- **Large integers**: `metric_value` is a decimal string (`"128340"`, `"0"` or a positive value without a leading zero, never negative) — never converted to an IEEE-754 JS `Number`, which loses precision above 2⁵³. Any downstream arithmetic (e.g. the velocity formula) must parse it as an arbitrary-precision integer/BigInt or let NUMERIC/decimal arithmetic own the division, never a native floating-point cast.
- `input_digest` = SHA-256 of the canonical, whitespace-free, sorted-key JSON string — computed by the writer **before** the value is written into the `JSONB` column, never derived from Postgres's own internal JSONB representation afterward (which does not guarantee byte-stable key order/whitespace).
- `algorithm_config_hash` = SHA-256 of the canonically serialized `algorithm_config_snapshot`, same rules.

## 7. Schema-enforced vs. writer/RPC-enforced — full honesty matrix

| Invariant | Enforced by |
|---|---|
| Freshness/velocity NULL-pairing, confidence threshold, non-negativity, upper bounds | **schema** (`CHECK`) |
| `freshness_coverage`/`velocity_coverage` exact value from counts | **schema** (`GENERATED ... STORED`) |
| `max_observed_at` NULL-pairing | **schema** (`CHECK`) |
| `(score_run_id, signal_cluster_id)` written at most once | **schema** (`UNIQUE`) |
| `ranking_eligible = false` | **schema** (`CHECK`) |
| `input_snapshot`/`algorithm_config_snapshot` is a JSON object; digest/hash format (64 hex) | **schema** (`CHECK`) — form only, not content |
| Run-status pairing (`error_class`/`completed_at`) | **schema** (`CHECK`) |
| `input_digest`/`algorithm_config_hash` is *actually* the corresponding snapshot's hash | **future RPC + integration test** |
| Snapshot internal consistency (scalar counts match snapshot arrays, exactly one `selected_for_calculation=true` per eligible evidence, tie-break correctness) | **future RPC + integration test** |
| `max_observed_at <= input_cutoff` (cross-table) | **future RPC** (not a native cross-table CHECK) |
| Score written only to a `processing` run; `completed` only after the full batch | **future RPC** |
| `(score_profile, algorithm_version) → 1 config_hash`, concurrency-safe | **future RPC** (`pg_advisory_xact_lock`, or a future registry table) |
| Direct `INSERT`/`UPDATE`/`DELETE` from `service_role` | **excluded structurally** — no grant exists |

## 8. Security / grant matrix (as implemented in 069)

| | `signal_score_runs` | `signal_cluster_scores` |
|---|---|---|
| Owner | `postgres` | `postgres` |
| RLS enabled + forced | yes (automatic via the 047 `ensure_rls` event trigger) | yes |
| Policies | 0 | 0 |
| `anon`/`authenticated`/`PUBLIC` | 0 grants | 0 grants |
| `service_role` | **`SELECT` only** | **`SELECT` only** |
| `service_role` INSERT/UPDATE/DELETE | none | none |
| `DELETE` (anyone) | none | none |

All future writes happen exclusively through SECURITY DEFINER (`postgres`-owned) RPCs, following the `reserve_provider_units`/`apply_signal_observation_batch` pattern (059–066) — `service_role` will only ever hold `EXECUTE` on those functions, never a direct table grant. This is a correction from document 1 (which proposed `INSERT`/`UPDATE` table grants for `service_role`) — document 3 supersedes it.

## 9. Lane separation

Shadow Topic v0 is the foundation of the **evidence-led** intelligence layer only.

- `entertainment_led` never reads or writes a Shadow Topic score; the scoring pipeline never reads legacy `viral_score`/`opportunity_score`/`competition_score` fields. There is no shared computation path between the two lanes.
- S1 introduces no user-facing materialization and no `creator_memory`/`video_ideas` change. The only existing structural touchpoint between the Creator Lane model and the `signal_*`/Shadow Topic world is `video_ideas.linked_signal_cluster_id` (067) — nullable, and constrained (`video_ideas_signal_cluster_requires_evidence_lock`) to only ever be set on a locked, `evidence_led` `video_ideas` row. A future user-facing connection must respect that same constraint; `entertainment_led` content is never required to carry a `signal_cluster_id`.
- `profiles.default_content_strategy_mode` and any `entertainment_led`-side personalized-ranking table remain out of scope — later, separate product/onboarding work, not gated by this document.

## 10. `ranking_eligible = false` — the v0 boundary

Every row this schema can hold is diagnostic. `ranking_eligible BOOLEAN NOT NULL DEFAULT false` with `CHECK (ranking_eligible = false)` makes this a database-level guarantee, not just an application convention — even a future application bug attempting to flip it to `true` is rejected at the schema level. No composite/final score, no personalized rank, no user-facing "predictive score" exists anywhere in this schema.

## 11. Known v0 limitations

- Cluster identity is a deterministic text fingerprint (category/topic/seed), not a similarity-clustering algorithm — it is not paraphrase-tolerant.
- `signal_entities`/`signal_cluster_members` (entity-level matching) remain unwritten by any current code path; Shadow Topic v0 does not depend on them and does not populate them.
- `(score_profile, algorithm_version) → single config_hash` is not database-enforced in this schema-only phase; a future RPC must add a concurrency-safe guard (advisory lock or a registry table).
- `max_observed_at <= input_cutoff` and full snapshot-vs-scalar consistency are not native CHECK constraints (PostgreSQL cannot cross-table CHECK, and JSONB-path CHECKs here would be fragile/expensive) — both are future RPC + integration-test responsibilities.
- No composite/final score, no ranking, no user-facing surface exists in v0 by design.

## 12. S2 — `run_shadow_topic_scoring` RPC (implemented, `070_run_shadow_topic_scoring.sql`)

This section supersedes §7's `(score_profile, algorithm_version) → single config_hash` limitation and §9's "future RPC" placeholders — S2 closes them. It documents only the points that were **finalized** during the S2 design-correction pass; §1–11 remain the schema-level source of truth.

**Identity**: `public.run_shadow_topic_scoring(p_evaluation_time timestamptz, p_input_cutoff timestamptz, p_idempotency_key text) RETURNS jsonb`. `LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp`, owner `postgres`, `EXECUTE` granted to `service_role` only (`anon`/`authenticated`/`PUBLIC` = 0). Every table reference is `public.`-qualified; every built-in used (`sha256`, `convert_to`, `to_json`, `hashtextextended`, `pg_advisory_xact_lock`) is `pg_catalog.`-qualified.

**Concurrency**: `pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('shadow_topic_v0:1', 0))` is taken as the very first step. Because this is a transaction-scoped lock, it holds until COMMIT/ROLLBACK — **the entire RPC execution serializes** across concurrent calls, not just the config/insert section. This is a deliberate v0 trade-off (no cron/route in this phase, negligible cost at current data volumes), not an oversight.

**Eligibility reason enum actually reachable in v0** (both freshness and velocity always share the same eligibility/reason per evidence, since v0 uses an identical condition for both): the base evidence query already excludes anything outside the cutoff (`signal_cluster_evidence.created_at`, `signal_evidence.first_seen_at`), so `linked_after_input_cutoff` and `first_seen_after_input_cutoff` are **structurally unreachable** and are not produced by this RPC. The four reachable values, in strict `CASE` precedence order (first match wins):

1. `not_youtube_evidence`
2. `missing_published_at`
3. `published_after_evaluation_time`
4. `no_scheduled_view_observation`
5. *(none of the above)* → `eligible = true`, `reason = null`

**`youtube_evidence_count`**: counts `evidence_type = 'youtube_video'` within the cutoff-valid evidence set **regardless of `published_at`**. A missing or future `published_at` stays in this denominator and is excluded only from `freshness/velocity_eligible_evidence_count` — it lowers `freshness_coverage`/`velocity_coverage`, it does not vanish from the count. Verified by test (`4 evidence with 1 missing published_at → coverage=0.7500`, not `1.0000`).

**Observation event-time cutoff, not ingestion-time**: `observed_at <= p_input_cutoff` is the only temporal gate on `signal_observations` — there is no separate "was this row already in the database by wall-clock time X" concept. A `signal_observations` row inserted by the collector *after* a given `run_shadow_topic_scoring` call, whose `observed_at` nonetheless satisfies the cutoff, is picked up by any *later* run with that same `input_cutoff` value (a re-run is not literally possible under the current semantic-dup UNIQUE for the exact same tuple, but a fresh run with a later `input_cutoff` covering the same window would see it). The `input_snapshot` freezes exactly what a given run actually saw, which is what makes each run individually auditable — it does not claim to represent "the database as of a wall-clock instant."

**Selection tie-break = snapshot order** (deliberately unified, a refinement over the earlier draft's plain-ascending wording): `observed_at DESC, bucket_start DESC, id ASC`, applied identically both to pick the per-evidence winning observation (`selected_for_calculation = true`) and to order the `observations[]` array within each `evidence_id` group (itself ordered `evidence_id ASC`). The first row in every per-evidence group in the snapshot is always the selected one.

**Canonical JSON**: hand-built `format()` text templates in fixed, manually-verified lexicographic key order (never `jsonb_build_object(...)::text` — empirically confirmed non-deterministic key ordering in this Postgres version, see prior design-gate notes). Every scalar is encoded via `pg_catalog.to_json(value)::text` (proven correct for quotes/backslash/Unicode/control characters — `signal_clusters.category` has no CHECK constraint and cannot be assumed pre-sanitized). `input_digest`/`algorithm_config_hash` are `encode(sha256(convert_to(<that same text>, 'UTF8')), 'hex')` — computed from and stored (via `::jsonb`) from the identical text expression, never two independently-built values.

**Atomic error model**: the RPC runs as one transaction. Any `RAISE EXCEPTION` (input validation, config-hash conflict, non-`completed` existing run for the same idempotency key, semantic-tuple conflict, or any unexpected error) aborts the entire call — no `RETURN` is reached, so the caller receives a SQL exception, not a JSONB payload, and nothing is committed. `signal_score_runs.status = 'failed'` remains schema-legal but this RPC never writes or commits it. Only two `outcome` values are ever returned: `"completed"` (fresh run) and `"replayed"` (idempotent replay of a prior `completed` run, verified to match on `score_profile`/`algorithm_version`/`algorithm_config_hash`/`evaluation_time`/`input_cutoff` before being trusted).

## 13. S2 correction — v1 provenance defect and the v2 fix (`071_fix_shadow_topic_snapshot_provenance.sql`)

**The v1/070 defect.** §6 of this document always specified that the observation element must carry `metric_value` as a decimal string, precisely so the stored `input_snapshot` alone is sufficient to recompute a score even if the source `signal_observations` row is later modified. The v1 implementation (070) did not do this — its `observation_json` canonical-text builder omitted `metric_value` entirely, and therefore `input_digest` (a hash of that same canonical text) was **not sensitive to `metric_value` either**. Concretely: a v1 `input_snapshot` is not self-contained, and any "reproducibility" demonstrated against a v1 row by re-reading current `signal_observations` values is not proof of anything — it is just reading the still-unchanged live value, not verifying the frozen snapshot.

**Consequence for existing v1 data.** The first (and, as of this writing, only) production Shadow Topic run, `signal_score_runs.id = 6853aa21-dbdf-4ec0-a6d9-6ba7f83d39c6` (`algorithm_version=1`, `input_snapshot_schema_version=1`), is **not calibratable** and must be treated as a provenance-incomplete audit record, not a usable data point. It is preserved exactly as-is — `signal_score_runs`/`signal_cluster_scores` are append-only and `071` performs zero DML — and must **never** be claimed to be reproducible from its own snapshot. Any future calibration or score-quality audit must exclude every row with `input_snapshot_schema_version < 2`.

**The v2 fix.** `071_fix_shadow_topic_snapshot_provenance.sql` replaces only the `run_shadow_topic_scoring` function body (fail-closed: it only ever transitions the known v1 legacy body hash to the known-good v2 body hash, no-ops if already v2, and raises and rolls back on any other body/ACL/owner/search_path it doesn't recognize). It changes:

- `algorithm_version`: `1` → `2`.
- `input_snapshot_schema_version`: `1` → `2` (also carried explicitly as a field inside `algorithm_config_snapshot`, so a v2 config alone makes its own snapshot shape unambiguous).
- `algorithm_config_schema_version`: `1` → `2` (the config JSON's own structure gained a field, which is a config-schema change in its own right).
- `algorithm_config_hash`: recomputed from the new config canonical text (new hash, since the config text changed).
- Advisory lock key: `shadow_topic_v0:1` → `shadow_topic_v0:2` (v1 and v2 calls no longer serialize against each other — there is no reason to, since a v1 call can never happen again once 071 is applied).
- The observation element in the snapshot now includes `metric_value`, satisfying §6 as originally written. Every cutoff-eligible observation carries it (not just the selected one), as a JSON string, built directly from `NUMERIC` (`trim_scale(round(metric_value, 0))::text` — never a JS/floating-point round-trip), so values above 2⁵³ survive byte-exact with no scientific notation.
- The score formula's mathematics (medians, eligibility, coverage) are **unchanged** — this is a reproducibility-contract fix, not an algorithm fix. `algorithm_version` bumps anyway, because the *meaning* of "the input this run saw" materially changed, and v1/v2 results must never be silently compared or averaged together.

**Isolation guarantees (enforced by the existing per-version scoping, not new code):** the `(score_profile, algorithm_version) → single config_hash` invariant is scoped to the caller's own `algorithm_version`, so the v1 row never collides with a v2 call. Calling the v2 RPC with the v1 run's exact `idempotency_key` does not replay it — the idempotency lookup finds a `completed` row whose `algorithm_version` differs from the caller's, and raises the existing "different semantic parameters" exception. A v1 run can never be silently reinterpreted as v2.

`ranking_eligible` remains hard-`false` in v2, exactly as in v1 — §10's guarantee is untouched by this correction.
