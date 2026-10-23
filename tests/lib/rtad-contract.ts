// Pure, DB-free parsing/validation of record_topic_assignment_decision's
// full contract row, as produced by
// tests/semantic-topic-s2a-audit-temporal-db-integration.test.ts's
// verifyRtadContract(). Kept separate from that (stateful, Docker-gated)
// test file so this logic -- especially the boolean-text comparison, which
// is exactly where a real bug lived (see PARSE FORMAT NOTE below) -- can be
// covered by a genuinely DB-free unit test, without importing a module that
// makes real Docker/DB calls at collection time.
//
// PARSE FORMAT NOTE: every field in the row is produced by explicit SQL
// `||` text concatenation, including `::text` casts of boolean columns
// (prosecdef, has_function_privilege(...)). Postgres's own boolean-to-text
// cast renders 'true'/'false' -- this is NOT the same as psql's `-A -t`
// display abbreviation ('t'/'f'), which only applies to a raw boolean
// COLUMN value psql prints directly, never to a value already cast to text
// inside the query itself. Comparing these fields against 't'/'f' is a real
// bug (confirmed live via CI on 2026-09-28: the previous version of this
// check compared svcExec/anonExec/authExec against 't'/'f' while comparing
// secdef -- built via the exact same `::text` cast -- against 'true'/
// 'false' in the same function, an internal inconsistency that was the
// actual root cause). It was NOT evidence that CREATE OR REPLACE FUNCTION
// fails to preserve an existing function's ACL -- Postgres's documented
// ACL-preservation guarantee for REPLACE was never actually disproven; the
// check was simply misreading its own correct SQL output.

export interface RtadContractRow {
  hash: string
  owner: string
  secdef: string
  volatility: string
  searchPath: string
  svcExec: string
  anonExec: string
  authExec: string
}

export function parseRtadContractRow(row: string): RtadContractRow {
  const [hash, owner, secdef, volatility, searchPath, svcExec, anonExec, authExec] = row.trim().split('|')
  return { hash, owner, secdef, volatility, searchPath, svcExec, anonExec, authExec }
}

// Every boolean-shaped field here is compared against the literal
// 'true'/'false' text Postgres's own `::text` cast produces -- never
// against psql's 't'/'f' display abbreviation (see PARSE FORMAT NOTE
// above). Returns the list of contract violations found (empty = the full
// contract holds): body hash, owner, SECURITY DEFINER, volatility,
// search_path, and exact ACL (service_role EXECUTE, anon/authenticated
// explicitly NOT).
export function checkRtadContract(fields: RtadContractRow, expectedHash: string): string[] {
  const { hash, owner, secdef, volatility, searchPath, svcExec, anonExec, authExec } = fields
  const problems: string[] = []
  if (hash !== expectedHash) problems.push(`body_hash=${hash} (expected ${expectedHash})`)
  if (owner !== 'postgres') problems.push(`owner=${owner} (expected postgres)`)
  if (secdef !== 'true') problems.push(`secdef=${secdef} (expected true)`)
  if (volatility !== 'v') problems.push(`volatility=${volatility} (expected v)`)
  if (searchPath !== 'search_path=public, pg_temp') problems.push(`search_path="${searchPath}" (expected "search_path=public, pg_temp")`)
  if (svcExec !== 'true') problems.push('service_role is missing EXECUTE')
  if (anonExec !== 'false') problems.push('anon unexpectedly has EXECUTE')
  if (authExec !== 'false') problems.push('authenticated unexpectedly has EXECUTE')
  return problems
}
