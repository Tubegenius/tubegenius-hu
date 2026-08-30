// Shared operator-CLI security/redaction/guard layer.
//
// Reused by every service-role-only administrative CLI in this codebase
// (currently: post-completion-review-recovery.ts and
// execute-approved-review.ts, both under scripts/). Extracted into one
// module so there is exactly ONE implementation of each safety-critical
// primitive here -- two "almost identical" copies drifting apart is
// exactly the failure class that caused the original UUID-redaction leak
// (see the post-completion-review-recovery remediation commit history).
//
// What stays deliberately duplicated in each CLI script instead of being
// imported from here: the Node-version preflight block (runs BEFORE
// register()/any dynamic import, so it cannot depend on this module having
// loaded) and each script's own minimal `shortenUuidsFallback` used only in
// its top-level `.catch()` (must still redact even if the dynamic import of
// this very module failed, so it cannot depend on that import having
// succeeded either). Both are small, self-evidently-correct constants, not
// security policy -- the actual policy logic (what counts as a secret
// field, what counts as a confirmed production target) lives here, once.

// ===========================================================================
// Central display/logging redactor -- the ONLY function anything on an
// operator CLI's output boundary may pass a value through before printing
// it. Never used to shape a value used for an actual DB/RPC call --
// exclusively a display-time transform, applied last, right before
// JSON.stringify/console.log/console.error.
// ===========================================================================

// Broader than any strict version-specific UUID validation pattern a caller
// might use for argument parsing -- this one exists purely to FIND and
// shorten any UUID-shaped substring wherever it appears, not to validate
// one, so it deliberately matches any RFC-4122-shaped string regardless of
// version/variant nibble.
const ANY_UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

// Key names whose VALUE is always fully masked, never merely shortened --
// matched case-insensitively, underscores/hyphens ignored, so
// 'SUPABASE_SERVICE_ROLE_KEY', 'serviceRoleKey', and 'service-role-key' are
// all treated identically.
// 'workspaceid' added by the Identity-Linked Workspace Header Support gate:
// an Anthropic workspace ID is not an API secret (see anthropic-workspace-
// config.ts's own header for why), but is still fully masked here rather
// than merely UUID-shortened -- that gate's own Section D/H requires the
// diagnostic CLI's output to show neither the value NOR a prefix/length/
// fingerprint of it, which only full masking (not shortenUuids' 8-char
// prefix) satisfies.
const SECRET_FIELD_NAME_FRAGMENTS = ['servicerolekey', 'apikey', 'authorization', 'password', 'secret', 'token', 'bearer', 'jwt', 'credential', 'workspaceid']

function isSecretFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '')
  return SECRET_FIELD_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}

function shortenUuids(value: string): string {
  return value.replace(ANY_UUID_REGEX, (match) => `${match.slice(0, 8)}…`)
}

// Recursively walks objects/arrays/strings. Never mutates its input --
// always returns a fresh value, so the caller's own (un-redacted) copy,
// used for real logic elsewhere, is never at risk of being silently altered
// by a logging call.
export function redactForDisplay(value: unknown): unknown {
  if (typeof value === 'string') return shortenUuids(value)
  if (Array.isArray(value)) return value.map((item) => redactForDisplay(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSecretFieldName(key) ? '[redacted]' : redactForDisplay(val)
    }
    return out
  }
  return value
}

// ===========================================================================
// Project-identity guard -- pure string parsing, no I/O. Exists so a CLI
// can refuse to proceed unless the operator's own --confirm-production
// value matches the project the service client will actually talk to, and
// so a localhost/127.0.0.1 target can never be confirmed as "production" no
// matter what string is passed.
// ===========================================================================
export type ProjectIdentity =
  | { kind: 'local'; host: string }
  | { kind: 'remote'; projectRef: string }
  | { kind: 'unrecognized'; host: string }

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export function resolveProjectIdentity(supabaseUrl: string): ProjectIdentity {
  let parsed: URL
  try {
    parsed = new URL(supabaseUrl)
  } catch {
    return { kind: 'unrecognized', host: supabaseUrl }
  }
  const host = parsed.hostname.toLowerCase()
  if (LOCAL_HOSTS.has(host)) return { kind: 'local', host }
  // Supabase-hosted project URLs are always <project-ref>.supabase.co --
  // the leftmost label is the project ref, never guessed at, never derived
  // from anything other than this exact, documented URL shape.
  const match = /^([a-z0-9]+)\.supabase\.co$/.exec(host)
  if (match) return { kind: 'remote', projectRef: match[1] }
  return { kind: 'unrecognized', host }
}

// Fail-closed comparison: a 'local' or 'unrecognized' identity can never be
// confirmed as production, regardless of what string the operator passes.
export function projectGuardPasses(identity: ProjectIdentity, confirmProduction: string): boolean {
  return identity.kind === 'remote' && identity.projectRef === confirmProduction
}
