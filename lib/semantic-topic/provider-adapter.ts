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
import { ANTHROPIC_WORKSPACE_ID_HEADER, getConfiguredAnthropicWorkspaceId } from './anthropic-workspace-config'

let semanticTopicAnthropicClient: Anthropic | null = null

// PFM Identity-Linked Workspace Header Support v0: the production Anthropic
// key is confirmed identity-linked (Personal / "All workspaces"), so every
// call must carry the anthropic-workspace-id header -- see
// anthropic-workspace-config.ts's own header for the full official contract
// and the design decision to make this REQUIRED rather than conditional.
// This check is defense-in-depth, not the primary gate: extraction-
// service.ts's runShadowExtraction() already fails closed on a missing/
// invalid workspace config BEFORE ever reaching a reservation or this
// function, exactly like it already does for ANTHROPIC_API_KEY above --
// this mirrors that exact existing pattern for the new config value, so
// this function is never the FIRST place either misconfiguration is caught
// in practice, only the last line of defense if it somehow were.
function getSemanticTopicAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Anthropic is not configured')
  const workspaceConfig = getConfiguredAnthropicWorkspaceId()
  if (!workspaceConfig.ok) throw new Error('Anthropic workspace is not configured')
  if (!semanticTopicAnthropicClient) {
    semanticTopicAnthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 60_000,
      // maxRetries: 0 is deliberate -- see module header comment.
      maxRetries: 0,
      // Added once, at client-construction time, for the ONE workspace this
      // deployment ever acts in -- never per-call, never derived from
      // caller-supplied input. Supplements (never overrides or duplicates)
      // the SDK's own required headers (x-api-key, anthropic-version,
      // content-type), which defaultHeaders leaves untouched.
      defaultHeaders: { [ANTHROPIC_WORKSPACE_ID_HEADER]: workspaceConfig.workspaceId },
    })
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
