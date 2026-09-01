// PFM Anthropic Provider Failure Taxonomy v0 -- safe, DISPLAY-ONLY error
// detail for the diagnostic CLI. Deliberately its own module, separate from
// provider-error-taxonomy.ts: that module's classifyProviderFailure() is
// the ONLY thing production code (extraction-service.ts, decideItemOutcome)
// may ever branch on, and it must never carry provider-supplied free text.
// This module exists for the OPPOSITE, narrower purpose -- giving a human
// operator enough sanitized detail to actually diagnose a 400 (which
// invalid_request_error the API returned, and a short redacted excerpt of
// why) without ever letting that detail reach a business-logic decision, a
// production DB row, or a runtime log. scripts/anthropic-provider-
// diagnostic.ts is the ONLY caller (enforced by
// tests/anthropic-provider-diagnostic.test.ts's own source-policy checks on
// extraction-service.ts and supervised-intake-runner.ts).
import Anthropic from '@anthropic-ai/sdk'

export interface SafeProviderErrorDetail {
  // The provider's own closed-ish error-type string (e.g.
  // 'invalid_request_error', 'authentication_error') -- Anthropic's own
  // vocabulary, not free text, but still never used for branching (the
  // taxonomy's httpStatus/category remain the only decision inputs).
  providerErrorType: string | null
  // At most 300 characters of the provider's message, with every secret-
  // shaped substring masked, every UUID shortened to an 8-char prefix, every
  // control character stripped. Display-only.
  sanitizedMessage: string | null
}

const MAX_SANITIZED_MESSAGE_LENGTH = 300

// Broader than a strict credential format -- exists purely to find and mask
// anything that LOOKS like it could be a secret, matching operator-cli-
// security.ts's own "err on the side of masking" philosophy for its secret-
// field-name list, just applied to message TEXT instead of object keys here.
const SECRET_LIKE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/gi, // Anthropic API keys
  /sk-[A-Za-z0-9_-]{20,}/gi, // generic secret-key-shaped tokens
  /sb_secret_[A-Za-z0-9_-]{5,}/gi, // Supabase secret keys
  /sb_publishable_[A-Za-z0-9_-]{5,}/gi, // Supabase publishable keys (still masked -- never worth the risk of an exception here)
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT-shaped
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi, // Authorization: Bearer ...
  /\b(?:api[_-]?key|authorization|token|secret|password|credential)["'\s:=]+[A-Za-z0-9._-]{8,}/gi, // "key: <value>"-shaped
]

// Same UUID shape operator-cli-security.ts's own redactForDisplay() looks
// for -- shortened to an 8-char prefix here too, never fully removed (an
// 8-char prefix is still useful for cross-referencing a specific incident
// without exposing the full identifier).
const ANY_UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

// Anthropic request IDs (req_...) -- masked entirely (not shortened like a
// UUID), per this module's own explicit contract: a request ID is an
// opaque support-ticket-style correlator, not something a prefix of is
// independently useful for, and masking it fully avoids any ambiguity.
const REQUEST_ID_REGEX = /\breq_[A-Za-z0-9]{6,}\b/gi

function stripControlCharacters(text: string): string {
  // Removes CR/LF and any other C0/C1 control character, collapsing them to
  // a single space -- a sanitized message must always be a single
  // printable line, never able to inject fake log lines or terminal
  // control sequences into an operator's console.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ')
}

function maskSecrets(text: string): string {
  let masked = text
  for (const pattern of SECRET_LIKE_PATTERNS) {
    masked = masked.replace(pattern, '[redacted]')
  }
  return masked
}

function shortenUuids(text: string): string {
  return text.replace(ANY_UUID_REGEX, (match) => `${match.slice(0, 8)}…`)
}

function maskRequestIds(text: string): string {
  return text.replace(REQUEST_ID_REGEX, '[request-id-redacted]')
}

// Pure function -- sanitizes a raw provider message string. Exported
// separately from extractSafeProviderErrorDetail() purely so tests can
// exercise the sanitization rules in isolation from Anthropic.APIError
// construction.
export function sanitizeProviderErrorMessage(rawMessage: string): string {
  let sanitized = rawMessage
  sanitized = stripControlCharacters(sanitized)
  sanitized = maskSecrets(sanitized)
  sanitized = shortenUuids(sanitized)
  sanitized = maskRequestIds(sanitized)
  sanitized = sanitized.trim()
  if (sanitized.length > MAX_SANITIZED_MESSAGE_LENGTH) {
    sanitized = sanitized.slice(0, MAX_SANITIZED_MESSAGE_LENGTH) + '…'
  }
  return sanitized
}

// The ONLY function that reads err.error/err.message -- everything else in
// this codebase's failure-handling path (classifyProviderFailure and every
// caller of it) never touches these fields. Never reads err.request_id
// directly into the output either (the request ID, if it appears at all,
// only ever does so already masked, via maskRequestIds() over the message
// text above).
export function extractSafeProviderErrorDetail(err: unknown): SafeProviderErrorDetail {
  if (!(err instanceof Anthropic.APIError)) {
    return { providerErrorType: null, sanitizedMessage: null }
  }

  // Anthropic's documented error response envelope (platform.claude.com/
  // docs/en/api/errors#error-shapes) is:
  //   {"type":"error","error":{"type":"invalid_request_error","message":"..."},"request_id":"req_..."}
  // The SDK's APIError.error property is set to this WHOLE envelope
  // (error.js: `this.error = error` where `error` is the raw parsed JSON
  // body) -- so the actual error-type vocabulary value lives one level
  // deeper, at err.error.error.type, not err.error.type (which is always
  // just the literal string "error", the envelope's own discriminant).
  let providerErrorType: string | null = null
  // Deliberately NOT err.message here: the SDK's own APIError.makeMessage()
  // (error.js) builds that string as `${status} ${msg}`, where `msg` falls
  // back to JSON.stringify(the WHOLE envelope) whenever error.message (one
  // level, not two) is undefined on the envelope itself -- which it always
  // is, since the real message lives at envelope.error.message. Using
  // err.message here would have leaked the raw, unsanitized envelope JSON
  // (including request_id and any provider-echoed field) into a value this
  // module then only partially re-sanitizes by pattern -- reading the
  // proper nested field directly is both more accurate AND safer.
  let rawMessage: string | null = null
  const envelope = err.error
  if (envelope && typeof envelope === 'object' && 'error' in envelope) {
    const inner = (envelope as { error: unknown }).error
    if (inner && typeof inner === 'object') {
      if ('type' in inner && typeof (inner as { type: unknown }).type === 'string') {
        // Anthropic's own error `type` vocabulary (e.g. 'invalid_request_error')
        // -- a short, closed-ish identifier, not free text, but still only
        // ever used for DISPLAY here, never for branching.
        providerErrorType = (inner as { type: string }).type
      }
      if ('message' in inner && typeof (inner as { message: unknown }).message === 'string') {
        rawMessage = (inner as { message: string }).message
      }
    }
  }

  const sanitizedMessage = rawMessage ? sanitizeProviderErrorMessage(rawMessage) : null

  return { providerErrorType, sanitizedMessage }
}
