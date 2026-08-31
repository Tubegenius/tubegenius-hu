// Semantic Topic Identity v0 -- S3A. Narrow Anthropic call adapter.
//
// Deliberately does NOT reuse lib/services/ai-provider-service.ts's
// callAIProvider()/callAnthropic(): that module's shared client is
// constructed with `maxRetries: 1` (Anthropic SDK-internal retry on
// transient errors). This layer's quota model assumes exactly one provider
// attempt per reservation -- reserve -> mark_attempt_started -> exactly one
// call -> commit/outcome_unknown (see ai-quota.ts and extraction-service.ts).
// A silent SDK-level retry would let a single reservation cover an unknown
// number of real HTTP calls to Anthropic, which the quota layer's actual-
// cost accounting has no way to see or bound. This is the "szűk adapter"
// the S3A gate requires instead of silently reusing the shared client.
//
// What IS reused, because it carries no retry/model coupling:
// assertAICompletion (pure validation of stop_reason/usage) and extractJson
// (pure text->JSON extraction with the same repair heuristics used
// elsewhere in the app) from ai-provider-service.ts.
import Anthropic from '@anthropic-ai/sdk'
import { assertAICompletion, extractJson } from '@/lib/services/ai-provider-service'
import { SEMANTIC_TOPIC_EXTRACTION_MODEL } from './extraction-config'
import { ANTHROPIC_WORKSPACE_ID_HEADER, resolveAnthropicAuthConfig, type AnthropicAuthConfigResult } from './anthropic-workspace-config'

let semanticTopicAnthropicClient: Anthropic | null = null

// PFM Anthropic Explicit Workspace-Scoped Authentication Mode gate: the
// SHARED request-builder both auth-scope branches route through (Section B
// of that gate) -- the ONLY place that decides whether the
// anthropic-workspace-id header is present on the constructed client.
// 'workspace_scoped': the header key is entirely OMITTED from the returned
// options object (not sent as empty/undefined -- omitted), matching the
// official docs' own "Omit the header for a single-workspace key".
// 'identity_linked': the header is added via defaultHeaders, applied once
// at client-construction time for the one workspace this deployment acts
// in -- never per-call, never derived from caller-supplied input.
// Never logs its input or output -- the caller (getSemanticTopicAnthropicClient
// below) is the only consumer, and it only ever uses the return value to
// construct a real Anthropic client, never to print anything.
export function buildAnthropicClientOptions(authConfig: Extract<AnthropicAuthConfigResult, { ok: true }>): NonNullable<ConstructorParameters<typeof Anthropic>[0]> {
  const base: NonNullable<ConstructorParameters<typeof Anthropic>[0]> = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 60_000,
    // maxRetries: 0 is deliberate -- see module header comment.
    maxRetries: 0,
  }
  if (authConfig.mode === 'identity_linked') {
    // Supplements (never overrides or duplicates) the SDK's own required
    // headers (x-api-key, anthropic-version, content-type), which
    // defaultHeaders leaves untouched.
    return { ...base, defaultHeaders: { [ANTHROPIC_WORKSPACE_ID_HEADER]: authConfig.workspaceId } }
  }
  return base
}

// This check is defense-in-depth, not the primary gate: extraction-
// service.ts's runShadowExtraction() already fails closed on a missing/
// unknown auth-scope-mode or missing/invalid workspace config BEFORE ever
// reaching a reservation or this function, exactly like it already does
// for ANTHROPIC_API_KEY above -- this mirrors that exact existing pattern,
// so this function is never the FIRST place a misconfiguration is caught
// in practice, only the last line of defense if it somehow were.
function getSemanticTopicAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Anthropic is not configured')
  const authConfig = resolveAnthropicAuthConfig()
  if (!authConfig.ok) throw new Error('Anthropic auth scope mode is not configured')
  if (!semanticTopicAnthropicClient) {
    semanticTopicAnthropicClient = new Anthropic(buildAnthropicClientOptions(authConfig))
  }
  return semanticTopicAnthropicClient
}

export interface ExtractionProviderCallResult {
  rawText: string
  parsedJson: unknown
  inputTokens: number
  outputTokens: number
}

export async function callAnthropicForExtraction(
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number,
): Promise<ExtractionProviderCallResult> {
  const client = getSemanticTopicAnthropicClient()
  const message = await client.messages.create({
    model: SEMANTIC_TOPIC_EXTRACTION_MODEL,
    max_tokens: maxOutputTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')

  const inputTokens = message.usage.input_tokens
  const outputTokens = message.usage.output_tokens
  assertAICompletion(message.stop_reason, text, inputTokens, outputTokens, maxOutputTokens)

  const parsedJson = extractJson(text)

  return { rawText: text, parsedJson, inputTokens, outputTokens }
}

// Correction-gate item 5: distinguishes a provider response we are HIGHLY
// confident was never billed (a pure pre-generation validation rejection --
// 400 invalid_request_error, 401 authentication_error, 403 permission_error,
// 404 not_found_error) from every other failure mode (429 rate-limit, any
// 5xx, timeout, network error), which stays in the conservative "uncertain"
// bucket (committed_unknown) even though some of those are ALSO very likely
// zero-cost -- when in doubt, this layer always assumes cost may have been
// incurred rather than assuming it wasn't (see migration 075 header (2)).
//
// PROVIDER FAILURE TAXONOMY v0: this used to be the only classification
// available, and it discarded the real HTTP status the moment it confirmed
// membership in DEFINITELY_UNBILLED_STATUS_CODES -- every 4xx in that set
// collapsed into the single indistinguishable string 'provider_rejected_
// unbilled', which is the confirmed root cause of why a real production
// failure could never be diagnosed past "some 4xx happened". The real
// classification now lives in provider-error-taxonomy.ts's
// classifyProviderFailure(), which preserves the exact status. This
// function and DEFINITELY_UNBILLED_STATUS_CODES stay here, unchanged, only
// because provider-error-taxonomy.ts deliberately re-declares its own copy
// of the status set (see that module's header) to stay independently
// unit-testable with zero dependency on this file.
const DEFINITELY_UNBILLED_STATUS_CODES = new Set([400, 401, 403, 404])

export function isDefinitelyUnbilledProviderError(err: unknown): boolean {
  return err instanceof Anthropic.APIError && typeof err.status === 'number' && DEFINITELY_UNBILLED_STATUS_CODES.has(err.status)
}
