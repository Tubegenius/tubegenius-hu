// Safety gate for DB-integration test files that make REAL, non-rolled-back
// writes against a Postgres target (schema/function-body mutations, not just
// disposable data rows -- e.g. the "migration 076 -- dual-function hash-gate"
// narrative in semantic-topic-canonical-input-timestamp-v2-db-integration.
// test.ts, which cycles record_topic_extraction_run/reserve_ai_provider_units
// through legacy/corrected/tampered bodies as real commits).
//
// This is deliberately a SEPARATE, stricter gate from the plain
// `stackAvailable` probe every *-db-integration.test.ts file already uses
// (a bare `select 1` against whatever container name is hardcoded) -- that
// probe only answers "is a Postgres reachable", not "am I explicitly
// authorized to mutate state on it for real". Without this gate, a plain
// `npx vitest run` / `npm test` on a developer's machine would silently
// connect to and mutate a long-lived local dev stack the instant one happened
// to be running, which is exactly the incident this module exists to
// prevent (see the 2026-09-28 handover: an accidental real run against
// supabase_db_WillViralFinal left it cycling through legacy/tampered
// function bodies for real, discovered only via a later CI diff).
//
// Zero top-level side effects (no process.env read at module-eval time, no
// child_process/Docker/network calls anywhere in this file) -- safe to
// import from a plain, DB-free unit test alongside the real DB-integration
// file, without ever attempting a connection.

export interface StatefulDbTargetEnv {
  PFM_STATEFUL_DB_TARGET?: string
  PFM_STATEFUL_DB_CONFIRM?: string
  PFM_STATEFUL_DB_REQUIRED?: string
}

export interface StatefulDbTargetResult {
  allowed: boolean
  container?: string
  reason: string
}

// Deliberately an exact, deliberate-to-type literal rather than a bare
// truthy check ("1"/"true") -- a throwaway truthy value is too easy to have
// set for an unrelated reason and forget about. Whoever wires this up (a CI
// job's own env block, for its own fresh, torn-down-afterward stack; never a
// developer's shell profile) has to type this exact phrase on purpose.
export const STATEFUL_DB_CONFIRM_TOKEN = 'yes-mutate-disposable-target'

// Container names that are NEVER an acceptable stateful-test target,
// regardless of confirmation token -- these are the known name(s) of the
// long-lived, shared local dev stack in this project (confirmed via
// `docker ps` on 2026-09-28: `supabase_db_WillViralFinal`, up for days,
// shared across everything a developer runs locally). A CI job that starts
// its own fresh, disposable stack via `supabase start` gets a container
// with this SAME default name (it is derived from the project, not
// randomized) -- such a job MUST rename its container to something
// distinct (e.g. embedding the run id) before pointing PFM_STATEFUL_DB_TARGET
// at it. This denylist is absolute and does not depend on confirmation --
// no token can override it, on purpose.
const DENYLISTED_CONTAINER_NAMES = new Set(['supabase_db_WillViralFinal'])

/**
 * Resolves whether state-mutating DB-integration scenarios may run, and
 * against which container. Both PFM_STATEFUL_DB_TARGET (the exact container
 * name -- there is no default; it is NEVER inferred or guessed) and
 * PFM_STATEFUL_DB_CONFIRM (must equal STATEFUL_DB_CONFIRM_TOKEN exactly) are
 * required, AND the named container must not be one of
 * DENYLISTED_CONTAINER_NAMES. Absent authorization, `allowed` is false --
 * callers must treat that as "skip entirely, make zero Docker/DB calls",
 * not "fall back to some other target".
 */
export function resolveStatefulDbTarget(env: StatefulDbTargetEnv = process.env as StatefulDbTargetEnv): StatefulDbTargetResult {
  const container = env.PFM_STATEFUL_DB_TARGET?.trim()
  const confirm = env.PFM_STATEFUL_DB_CONFIRM?.trim()

  if (!container) {
    return { allowed: false, reason: 'PFM_STATEFUL_DB_TARGET is not set -- state-mutating DB-integration scenarios are skipped by default, on every machine, until explicitly opted in' }
  }
  if (DENYLISTED_CONTAINER_NAMES.has(container)) {
    return {
      allowed: false,
      container,
      reason: `"${container}" is the known long-lived local dev stack -- explicitly refused regardless of confirmation. Point stateful tests at a distinct, genuinely disposable container (e.g. a freshly-started CI stack renamed to include its run id), never this name.`,
    }
  }
  if (confirm !== STATEFUL_DB_CONFIRM_TOKEN) {
    return {
      allowed: false,
      container,
      reason: confirm
        ? `PFM_STATEFUL_DB_CONFIRM does not match the required exact token (expected "${STATEFUL_DB_CONFIRM_TOKEN}")`
        : 'PFM_STATEFUL_DB_CONFIRM is not set',
    }
  }
  return { allowed: true, container, reason: 'explicit target and confirmation both present, and the container is not denylisted' }
}

/**
 * True only when the CALLER'S environment explicitly declares that stateful
 * DB-integration scenarios are REQUIRED to run (set only by the dedicated CI
 * job that starts its own disposable stack for exactly this purpose -- never
 * by a developer's shell or by the shared `regression` job, which excludes
 * this file entirely). When this is true and resolveStatefulDbTarget() is
 * not `allowed`, or the schema turns out to be incomplete, the caller must
 * FAIL LOUDLY (throw, failing the whole test file / CI job) instead of
 * silently skipping -- skipping would hide the fact that these tests never
 * actually ran, in the one context where they are specifically expected to.
 */
export function isStatefulDbRequired(env: StatefulDbTargetEnv = process.env as StatefulDbTargetEnv): boolean {
  return env.PFM_STATEFUL_DB_REQUIRED === '1'
}
