// decisions_digest_v2 -- versioned, stable aggregate digest over
// topic_assignment_decisions, for cheap append-only-integrity spot checks
// without needing to view/compare full row contents. Supersedes the
// undocumented ad hoc digest computed during the Audit Closure Gate, which
// could not be reproduced later precisely because it had no recorded
// formula or version marker -- this module exists so that never happens
// again for THIS digest.
//
// Formula (v2): 'v2:' + <row count> + ':' + SHA-256-hex of the UTF-8 bytes
// of the row body, where the row body is each row rendered as
//   <id>|<extraction_run_id>|<outcome>|<decision_digest>
// (pipe-delimited, exactly these four columns, using each row's own
// already-canonical decision_digest rather than re-hashing raw fields),
// rows joined by ';', ORDER BY id ascending. `id` ordering is
// DETERMINISTIC and UNIQUE (primary key) but explicitly NOT monotonic with
// created_at -- two decisions can be inserted in one order and have
// reversed created_at values (observed directly during the Audit Closure
// Gate), so created_at must never be used as the ordering key here.
//
// The 'v2:' prefix and row count are both part of the returned string (not
// just side information) so a future format change, or a row-count change
// a caller forgot to check separately, is never silently indistinguishable
// from this one. An empty table produces a stable, well-defined value
// (row body is the empty string) rather than an ambiguous or NULL result.
//
// See docs for the exact PostgreSQL reference formula and the parity test
// (tests/decisions-digest.test.ts) proving this implementation and that
// SQL formula produce identical output on the same fixture.
import { createHash } from 'node:crypto'
import type { SemanticTopicAdminClient } from './human-review-types'

export const DECISIONS_DIGEST_VERSION = 'v2'

export interface DecisionDigestRow {
  id: string
  extractionRunId: string
  outcome: string
  decisionDigest: string
}

// Pure function -- no I/O, so trivially unit-testable and reusable by
// anything that already has the rows in hand (e.g. a test fixture) without
// needing a DB round trip.
export function computeDecisionsDigestV2(rows: readonly DecisionDigestRow[]): string {
  // Sort on a COPY -- never mutate the caller's array. Plain string
  // comparison on the canonical hyphenated UUID text form: since every
  // UUID string in this comparison has hyphens at the same fixed
  // positions, the '-' characters can never be the first point of
  // difference between two distinct UUIDs, so lexicographic string
  // ordering here matches PostgreSQL's native `ORDER BY id` (uuid column,
  // compared by underlying byte value) -- verified empirically against the
  // real RPC-assigned ids in the DB-integration parity test, not assumed.
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const body = sorted.map((r) => `${r.id}|${r.extractionRunId}|${r.outcome}|${r.decisionDigest}`).join(';')
  const hash = createHash('sha256').update(body, 'utf8').digest('hex')
  return `${DECISIONS_DIGEST_VERSION}:${sorted.length}:${hash}`
}

export type FetchDecisionsDigestV2Result = { ok: true; digest: string; rowCount: number } | { ok: false; message: string }

// The only I/O this module performs: one read-only SELECT of exactly the
// four columns the formula uses. Never selects deterministic_signals,
// model_confidence, idempotency_key, or created_at -- none of those are
// part of the v2 formula, and idempotency_key in particular has been shown
// (Audit Closure Gate) to sometimes be a bare, undisplayable UUID.
export async function fetchDecisionsDigestV2(client: SemanticTopicAdminClient): Promise<FetchDecisionsDigestV2Result> {
  const { data, error } = await client.from('topic_assignment_decisions').select('id, extraction_run_id, outcome, decision_digest').order('id', { ascending: true })
  if (error) return { ok: false, message: error.message }
  const rows = (data ?? []) as { id: string; extraction_run_id: string; outcome: string; decision_digest: string }[]
  const digestRows: DecisionDigestRow[] = rows.map((r) => ({
    id: r.id,
    extractionRunId: r.extraction_run_id,
    outcome: r.outcome,
    decisionDigest: r.decision_digest,
  }))
  return { ok: true, digest: computeDecisionsDigestV2(digestRows), rowCount: digestRows.length }
}
