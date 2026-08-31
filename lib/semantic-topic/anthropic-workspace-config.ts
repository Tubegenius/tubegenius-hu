// PFM Anthropic Identity-Linked Workspace Header Support v0.
//
// Official Anthropic contract (audited during this gate from
// platform.claude.com/docs/en/manage-claude/authentication#select-a-workspace
// and platform.claude.com/docs/en/manage-claude/workspaces, both fetched
// live -- not recalled from training data): a personal or service-account
// API key that is NOT scoped to a single workspace ("identity-linked",
// multi-workspace key -- exactly this repo's confirmed production key type:
// Personal / "All workspaces", per the Console Read-Only Verification Gate
// that preceded this one) must send the workspace it acts in on EVERY
// Messages API request, via the `anthropic-workspace-id` request header,
// value = the `wrkspc_`-prefixed workspace ID (e.g.
// `wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ`). A single-workspace-scoped key must
// OMIT the header (the workspace is implied by the key itself).
//
// Omitting the header on an identity-linked key returns HTTP 400
// invalid_request_error: "anthropic-workspace-id is required when
// authenticating with an identity-linked API key; send the id of the
// workspace this request acts in." -- the EXACT message this repo's own
// diagnostic CLI observed against real production traffic (see
// docs/operations/supervised-intake-runbook.md), now confirmed by the
// official docs to be the documented, expected behavior for this key type,
// not a bug or misconfiguration on Anthropic's side.
// A malformed header value returns 400 "anthropic-workspace-id header must
// be a valid workspace ID." An unknown/inaccessible workspace returns 404
// `Workspace <id> not found.`.
//
// Design decision, SUPERSEDED (PFM Anthropic Explicit Workspace-Scoped
// Authentication Mode -- Local Contract Remediation Gate): the original
// design here made ANTHROPIC_WORKSPACE_ID unconditionally required for
// every call, reasoning that there was "no reliable way to detect a key's
// scope" so an identity-linked key should just be assumed. That reasoning
// is now moot for a different reason: the Console's own UI cannot surface
// the Default Workspace's ID at all (confirmed by hands-on operator
// investigation -- neither the Workspaces list, nor a workspace-scoped
// key's own detail view, ever shows a `wrkspc_` value for the Default
// Workspace; only a real API response header or the Admin API's raw JSON
// would, and making either was out of scope for that investigation). The
// operational decision is therefore to STOP using an identity-linked
// ("All workspaces") key at all for the next production key, and instead
// create one explicitly scoped to a single workspace (Default) -- a
// workspace-scoped key never needs or sends this header in the first
// place (see the module header above: "A single-workspace-scoped key must
// OMIT the header"). ANTHROPIC_AUTH_SCOPE_MODE (below) makes this an
// EXPLICIT, closed, fail-closed server-side choice rather than an assumed
// default, so a future key-type change (either direction) is caught by a
// deliberate config decision, never silently inferred from the key's own
// opaque string (still explicitly out of scope, unchanged from before).
//
// Sensitivity: a workspace ID is NOT an API secret (it grants no access on
// its own -- the API key is still what authenticates), but per this gate's
// own Section H it is still treated as an operator identifier that must be
// redacted from CLI output and logs, same as any other internal ID. See
// operator-cli-security.ts's SECRET_FIELD_NAME_FRAGMENTS, which this module
// relies on (a field literally named `workspaceId`/`workspace_id` is fully
// masked, not merely shortened like a UUID) -- deliberately stricter than
// this module's own reasonCode-only failure shape below.

// Documented ID shape: `wrkspc_` followed by what the docs' own examples
// show as a fixed-length, alphanumeric (Crockford-base32-shaped) suffix.
// Deliberately permissive on exact length/charset (10-64 alphanumeric
// characters after the prefix) -- this is a FORMAT sanity check on an
// operator-supplied config value, not an attempt to validate against
// Anthropic's precise, undocumented ID-generation alphabet. A workspace ID
// that fails this check is refused fail-closed before any provider call;
// one that passes is not guaranteed to exist or be accessible (only a real
// call can confirm that -- see the 404 case in this module's own header).
const WORKSPACE_ID_FORMAT_REGEX = /^wrkspc_[A-Za-z0-9]{10,64}$/

// The exact, official header name (case as documented; HTTP headers are
// case-insensitive on the wire, but this is the canonical spelling every
// official example uses) -- a single source of truth so provider-adapter.ts
// and the diagnostic CLI can never spell it differently from each other.
export const ANTHROPIC_WORKSPACE_ID_HEADER = 'anthropic-workspace-id'

export type AnthropicWorkspaceConfigResult =
  | { ok: true; workspaceId: string }
  | { ok: false; reasonCode: 'anthropic_workspace_id_missing' }
  | { ok: false; reasonCode: 'anthropic_workspace_id_invalid_format' }

// Reads ONLY the real process environment (never .env/.env.local -- matches
// every other credential/config read in this layer, e.g. provider-
// adapter.ts's own ANTHROPIC_API_KEY read). Pure function of its input --
// the optional `env` parameter exists solely so tests can supply a
// synthetic environment without mutating the real process.env. Never logs,
// throws, or returns the raw configured value on a failure branch -- a
// caller that needs to report *why* uses the reasonCode, never a value, so
// an invalid workspace ID can never leak into a log line or error message
// through this function.
export function getConfiguredAnthropicWorkspaceId(env: Record<string, string | undefined> = process.env): AnthropicWorkspaceConfigResult {
  const raw = env.ANTHROPIC_WORKSPACE_ID
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (trimmed.length === 0) {
    return { ok: false, reasonCode: 'anthropic_workspace_id_missing' }
  }
  if (!WORKSPACE_ID_FORMAT_REGEX.test(trimmed)) {
    return { ok: false, reasonCode: 'anthropic_workspace_id_invalid_format' }
  }
  return { ok: true, workspaceId: trimmed }
}

// ===========================================================================
// Explicit auth-scope-mode contract (PFM Anthropic Explicit Workspace-Scoped
// Authentication Mode -- Local Contract Remediation Gate).
//
// ANTHROPIC_AUTH_SCOPE_MODE is a new, REQUIRED, closed-vocabulary server
// config value with exactly two valid values:
//
//   'workspace_scoped' -- the configured API key is scoped to exactly one
//     workspace (chosen when the key was created in the Console). The
//     workspace is then implied by the key itself: ANTHROPIC_WORKSPACE_ID
//     is NOT read, NOT required, and the anthropic-workspace-id header is
//     NEVER sent -- sending it anyway would be at best redundant and, per
//     the official docs' own phrasing ("Omit the header for a single-
//     workspace key"), is not a documented-safe thing to do regardless.
//
//   'identity_linked' -- the configured API key is a personal or service-
//     account key NOT scoped to a single workspace (e.g. "All workspaces").
//     ANTHROPIC_WORKSPACE_ID becomes required again, validated exactly as
//     getConfiguredAnthropicWorkspaceId() above already does, and the
//     header is sent on every call. This is the ORIGINAL (pre-this-gate)
//     unconditional behavior, now reachable only via an explicit opt-in.
//
// Any other value (missing, empty/whitespace, or an unrecognized string)
// is a configuration_error -- fail-closed, zero provider calls, exactly
// like a missing/invalid workspace ID already was. The mode string itself
// is never derived from the API key's own shape (prefix/length/error
// message) -- it is always an explicit, separately-configured value.
export type AnthropicAuthScopeMode = 'workspace_scoped' | 'identity_linked'

const KNOWN_AUTH_SCOPE_MODES = new Set<string>(['workspace_scoped', 'identity_linked'] satisfies AnthropicAuthScopeMode[])

export type AnthropicAuthConfigReasonCode =
  | 'auth_scope_mode_missing'
  | 'auth_scope_mode_unknown'
  | 'anthropic_workspace_id_missing'
  | 'anthropic_workspace_id_invalid_format'

export type AnthropicAuthConfigResult =
  | { ok: true; mode: 'workspace_scoped' }
  | { ok: true; mode: 'identity_linked'; workspaceId: string }
  | { ok: false; reasonCode: AnthropicAuthConfigReasonCode }

// The ONE function both provider-adapter.ts and the diagnostic CLI call to
// decide (a) whether a call may proceed at all and (b) whether the
// anthropic-workspace-id header belongs on it. Pure function of its input
// (env override for tests, same pattern as getConfiguredAnthropicWorkspaceId
// above); never logs, never returns a raw invalid value on any failure
// branch.
export function resolveAnthropicAuthConfig(env: Record<string, string | undefined> = process.env): AnthropicAuthConfigResult {
  const rawMode = env.ANTHROPIC_AUTH_SCOPE_MODE
  const mode = typeof rawMode === 'string' ? rawMode.trim() : ''
  if (mode.length === 0) {
    return { ok: false, reasonCode: 'auth_scope_mode_missing' }
  }
  if (!KNOWN_AUTH_SCOPE_MODES.has(mode)) {
    return { ok: false, reasonCode: 'auth_scope_mode_unknown' }
  }
  if (mode === 'workspace_scoped') {
    return { ok: true, mode: 'workspace_scoped' }
  }
  // mode === 'identity_linked'
  const workspaceResult = getConfiguredAnthropicWorkspaceId(env)
  if (!workspaceResult.ok) {
    return { ok: false, reasonCode: workspaceResult.reasonCode }
  }
  return { ok: true, mode: 'identity_linked', workspaceId: workspaceResult.workspaceId }
}
