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
// Design decision (this gate, Section B): WillViral's Anthropic usage is a
// single deployment, one account, one confirmed identity-linked key. There
// is no reliable code-level way to detect a key's scope without a separate
// Admin API call this layer has no reason to make, and guessing key TYPE
// from the key's own prefix/length is explicitly out of scope (see this
// gate's own instruction) -- a key's opaque string never reveals its scope.
// ANTHROPIC_WORKSPACE_ID is therefore made REQUIRED for every WillViral
// Anthropic Messages API call (production extraction AND the diagnostic
// CLI), rather than conditional on a separate "identity-linked mode" flag
// that would add an untested, unused code path for a deployment shape this
// app does not have today. If WillViral ever moves to a workspace-scoped
// key, revisit this decision then -- it is not designed around that
// hypothetical now.
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
