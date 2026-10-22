# Migration 004 -- replay baseline table grants

`supabase/migrations/004_replay_baseline_table_grants.sql` is a normal migration of the chain, version 004.

* SHA-256 of the LF text of the file: `dd68ba25a48733840efea5b0ca9b6a28ac809b451a6ff0d46a2bb36a7d6cc89f`, pinned by
  `tests/004-replay-baseline-table-grants-migration-source-policy.test.ts`.
* The executable part (everything from the first `BEGIN;` line to the end) is byte-identical to the v4 candidate that was replayed in
  the isolated proofs on 2026-10-21 (SHA-256 of that v4 file: `4ce20764a97e3beb0e711f4272cd651273385e25209fed58ddc9e9e5f65fc0c2`;
  SHA-256 of the shared executable part: `1f92624ed211a7fcca67c9f822468fd49338de362bbf90a03c940d24b290c6cb`).
* Only comments differ from v4: the v4 header still described a local prototype and was corrected afterwards. This was verified by
  machine: byte equality of the executable part, equality of the comment-stripped code, equality of the PostgreSQL 17 parse trees and
  of the `DO` body, with controls showing that a one-privilege change in executable code would have been detected.
* The final file itself was replayed again, unchanged, in two new isolated CLI proofs (see "Evidence").

## What it is for

Tables created by migrations 001..003 get their Data-API-role DML privileges only from the *legacy default privileges* of the
platform; no migration grants them explicitly. Migration 044 (157 keepers) and migration 090 (23 `authenticated` / 200
`service_role` DML keepers, 81 column ACLs, 82 RLS tables) assert exactly those privileges. A replay on an environment that
no longer hands out the legacy defaults (the platform's new default, Supabase CLI with `auto_expose_new_tables = false`)
is therefore expected to fail at **044**, before 090. That expectation comes from reading the code of 044; the failure of a replay
without 004 was never demonstrated (see "Not proven").

004 supplies, for 14 tables created by 001..003, the 64 baseline DML privileges (25 role/table pairs) that 044 and 090 pin --
nothing else. They are the 044-time keepers on these tables plus `profiles`; later migrations narrow them exactly as in the original
history (041 `profiles`, 067 and 068 `creator_memory`, 039 `video_packages`).

## The four accepted ACL states (fail-closed)

004 reads the COMPLETE table-level ACL (every non-owner grantee, privilege and grant option) of the 14 tables. All 14 tables
must be in the same ONE of these states, otherwise the migration raises and stops without changing anything:

| State | Exact shape | What 004 does |
|---|---|---|
| `EMPTY` | no non-owner ACL entry at all (an all-revoked state; **not** what the platform or the CLI produces) | grants the 64 baseline DML privileges, verifies the result exactly |
| `PLATFORM-NEW` | PG >= 17 only: `anon`, `authenticated`, `service_role` each hold exactly `MAINTAIN, REFERENCES, TRIGGER, TRUNCATE` (no DML), no other grantee, no grant option -- the state the real Supabase CLI 2.117.0 produced with `auto_expose_new_tables = false` | grants **only** the 64 baseline DML privileges (no wide grant, no `anon` DML), keeps the four non-DML privileges, verifies the result exactly |
| `LEGACY` | `anon`, `authenticated`, `service_role` each hold all privileges (`MAINTAIN` only on PG >= 17), nothing else (the legacy auto-expose default; the state the CLI produced with `auto_expose_new_tables = true`) | no change |
| `FINAL` | the already-migrated production/staging table ACL (verified identical on both on 2026-10-20) | no change |

Anything else -- a missing or extra privilege, `anon` DML, `PUBLIC` or any other grantee, a grant option, a mixed state across
tables, PG < 17 with the PLATFORM-NEW shape -- raises. No right is silently skipped.

**`PLATFORM-NEW` is not a safe resting state.** The retained `TRUNCATE` and `REFERENCES` (and `TRIGGER` / `MAINTAIN`) privileges of
`anon` / `authenticated` / `service_role` are not protected by RLS (RLS does not restrict `TRUNCATE` or `REFERENCES`). The state is
acceptable only as the intermediate state of an isolated replay; migration 090 revokes exactly these four privileges later in the
chain, and the final ACL must equal production exactly (090 contract, no `anon` / `PUBLIC` access).

## Re-running

The block is not idempotent on its own output. After it has supplied the baseline (`EMPTY` or `PLATFORM-NEW` input) the ACL matches
none of the four states until 090 has run, so a second run before 044 raises (nothing is widened); after the whole chain it sees
`FINAL` and changes nothing. A failed run rolls back as a whole (single transaction).

## Dependency on 044 and 090

* 004 must run before 011 (versions 004..010 were unused; it sorts after 003). It touches only tables created by 001..003.
* 044 validates that its 157 keeper tuples exist (`MISSING_LOCAL`).
* 090 validates the 23 / 200 DML keeper digests and revokes the four non-DML privileges on every public relation.
* 004 does not touch: `anon` / `PUBLIC` DML, grant options, `ALTER DEFAULT PRIVILEGES`, functions, sequences, column ACLs, the
  095 tables, or any existing migration file.

## Existing environments: how 004 appears

* **Staging** has a CLI migration history. 004 would be a *retroactive* migration there (its version is older than the newest
  applied one): `supabase db push` refuses it unless `--include-all` is given. If it were applied anyway, 004 sees the `FINAL`
  state and changes nothing (re-evaluated on the post-090 state of isolated stacks: the whole public-schema ACL unchanged).
  Whether and how staging's history should learn about 004 is an open operations question. `supabase db push --include-all` and
  `supabase migration repair` are operator options only; each would need its own separate, explicit approval, and this document does
  not recommend either. Nothing in this repository applies migrations to staging.
* **Production** has **no CLI migration history** (migrations were applied with `psql` in single transactions). `supabase db push`
  must never be run against production: it would treat every migration as pending. 004 is not applied to production by any
  automation, and recording it in a history would be a separate, explicit decision.
* No workflow applies migrations to a hosted database: `.github/workflows/quality.yml` runs `supabase start` on a disposable local
  stack and uses `docker exec` against that local container only (no `db push`, no `link`, no remote secrets). The source test checks
  the workflow text.

## Evidence and its limits

Proven on 2026-10-21 in isolated, throw-away environments (nothing touched a shared or hosted database; raw logs are kept outside
the repository):

* Real Supabase CLI 2.117.0 (the CI pin), temporary project with its own `project_id` and ports, DB-only stack, PostgreSQL 17.6
  (image pin 17.6.1.167); not this repository's `supabase/config.toml`. Applied in two steps: `supabase start` with 001..003, then
  `supabase migration up --local` for 004 and 011..091.
  * `auto_expose_new_tables = false`: the ACL read from the catalog right before 004 was exactly `PLATFORM-NEW` (14 tables x 3 roles x 4
    privileges = 168 tuples); 004 -> 232 = 64 DML + 168 non-DML; 044 and 090 passed; the final ACL, the 090 digests, the 82-table
    DML matrix and the 77 function ACLs equal the production catalog read on 2026-10-20; retained non-DML privileges 0; no `anon` /
    `PUBLIC` access.
  * `auto_expose_new_tables = true`: the ACL right before 004 was exactly `LEGACY` (336 tuples); 004 reported nothing to supply and
    left the 336 unchanged; 044 and 090 passed; the same final-ACL equality as above.
* Earlier, with the v4 candidate (same executable bytes): the CLI `false` case once more, and raw PostgreSQL images in the `EMPTY` and
  `LEGACY` states with the same final result.
* The `FINAL` branch, evaluated on each successful post-090 state, changed nothing.

The source test is not runtime evidence: it reads files only and cannot execute the SQL. It pins the file bytes, checks the text
structure (with negative controls on in-memory broken copies), the data constants, the static dependency on 044 / 090 and the
workflow text (`tests/004-replay-baseline-table-grants-migration-source-policy.test.ts`).

Not proven (open evidence gaps, none of them closed by the runs above):

* The failure of a replay without 004 at 044 was never demonstrated; it is inferred from the code of 044.
* Migrations 092..095 together with 004 were not replayed.
* No hosted project (staging or production) was replayed or touched.
* The CLI runs used a temporary project configuration and a DB-only stack, not the full repository configuration.
