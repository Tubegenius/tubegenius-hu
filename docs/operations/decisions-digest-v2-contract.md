# `decisions_digest_v2` contract

A versioned, stable aggregate digest over `topic_assignment_decisions`, for
cheap append-only-integrity spot checks without displaying or comparing full
row contents.

## Why v2 exists

An earlier ad hoc "decisions_hash" value was reported during an audit gate
with no recorded formula or version marker. It could not later be
reproduced from any file, test, or memory record, even after systematically
testing 130+ plausible SQL/hash formulas against the unchanged underlying
rows. This was not evidence of data drift (row-level and append-only checks
in that same gate found none) -- it was purely an evidentiary gap caused by
an undocumented, unversioned, one-off computation. `decisions_digest_v2`
exists so that specific failure mode cannot recur for this digest: the
formula below is the single source of truth, versioned, and covered by a
parity test proving the Node and PostgreSQL implementations agree.

## Formula

```
v2:<row count>:<sha256 hex of body>
```

where `body` is:

```
<id>|<extraction_run_id>|<outcome>|<decision_digest>;<id>|<extraction_run_id>|<outcome>|<decision_digest>;...
```

- Exactly four columns per row: `id`, `extraction_run_id`, `outcome`,
  `decision_digest` (the row's own already-canonical SHA-256 decision
  digest, maintained by migrations 074/078 -- never re-hashing raw fields).
- Field delimiter: `|`. Row delimiter: `;`.
- `ORDER BY id` ascending -- `id` is deterministic and unique (primary
  key), but **not monotonic with `created_at`**: two decisions can be
  inserted in one order and end up with reversed `created_at` values
  (observed directly during the Audit Closure Gate). `created_at` must
  never be used as the ordering key for this digest.
- UTF-8 encoding, SHA-256, lowercase hex.
- An empty table produces `body = ''` (not NULL, not an error) --
  `v2:0:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
  is the well-defined digest of zero rows.
- The `v2:` prefix and row count are part of the returned string itself,
  not side information reported separately -- a future format change, or a
  row-count drift a caller forgot to check independently, is never silently
  indistinguishable from this contract.

## PostgreSQL reference implementation

```sql
SELECT 'v2:' || count(*)::text || ':' || encode(
  sha256(convert_to(
    coalesce(
      string_agg(
        format('%s|%s|%s|%s', id::text, extraction_run_id::text, outcome, decision_digest),
        ';' ORDER BY id
      ),
      ''
    ),
    'UTF8'
  )),
  'hex'
) AS decisions_digest_v2
FROM topic_assignment_decisions;
```

## Node.js reference implementation

See `lib/semantic-topic/decisions-digest.ts` (`computeDecisionsDigestV2` /
`fetchDecisionsDigestV2`). Parity between this SQL query and the Node
implementation, on the same fixture, is proven by
`tests/decisions-digest-db-integration.test.ts`.

## What this digest is (and is not) for

- It IS a cheap, redaction-safe way to confirm "the decisions table's
  content-relevant columns are unchanged" across two points in time,
  without ever needing to display or diff full row contents (which would
  risk leaking full UUIDs).
- It is NOT a substitute for the append-only DB-level protections
  (`UPDATE`/`DELETE` grants restricted to `postgres` only, `RLS` enabled
  and forced, no triggers) -- those are the actual enforcement mechanism;
  this digest is an observational convenience on top of them.
- It never appears in any CLI's raw output without going through that
  CLI's own redaction boundary first, even though the digest itself
  contains no UUIDs or secrets in its final hex form -- the row `id`/
  `extraction_run_id` values used to COMPUTE it are handled with the same
  care as everywhere else in this codebase.
