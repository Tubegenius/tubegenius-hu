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

let semanticTopicAnthropicClient: Anthropic | null = null

function getSemanticTopicAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Anthropic is not configured')
  if (!semanticTopicAnthropicClient) {
    semanticTopicAnthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 60_000,
      // maxRetries: 0 is deliberate -- see module header comment.
      maxRetries: 0,
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
const DEFINITELY_UNBILLED_STATUS_CODES = new Set([400, 401, 403, 404])

export function isDefinitelyUnbilledProviderError(err: unknown): boolean {
  return err instanceof Anthropic.APIError && typeof err.status === 'number' && DEFINITELY_UNBILLED_STATUS_CODES.has(err.status)
}

// Never log raw provider text or the prompt -- only a short, bounded,
// secret-free classifier, per the S3A gate's audit-field contract.
export function classifyProviderError(err: unknown): string {
  if (isDefinitelyUnbilledProviderError(err)) return 'provider_rejected_unbilled'
  if (err instanceof Error) {
    const message = err.message || ''
    const name = err.name || ''
    if (name === 'AbortError' || /timeout/i.test(message)) return 'timeout'
    if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(message)) return 'network_error'
    if (/rate.?limit/i.test(message) || /429/.test(message)) return 'rate_limited'
    if (/JSON|extractJson|no JSON object or array|is empty/i.test(message)) return 'malformed_output'
    if (/truncated at max token limit/i.test(message)) return 'max_tokens_truncated'
    return 'provider_error'
  }
  return 'unknown_error'
}
