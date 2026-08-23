// Semantic Topic Identity v0 -- S3A pinned extraction/quota constants.
//
// Every constant here is PINNED by the explicit "S3A AI Quota & Shadow
// Extraction Foundation" design-closure gate -- none of it is invented by
// this module, and none of it should be silently widened by a future edit.
// In particular this module deliberately does NOT import lib/models.ts
// MODELS.primary: that alias can change later for other features without a
// dedicated calibration/rollout gate for this layer, which would silently
// change what this layer actually pays for and what its cache/attempt-limit
// digests key on. A model change here requires editing this file directly.

export const SEMANTIC_TOPIC_EXTRACTION_PROVIDER = 'anthropic' as const
export const SEMANTIC_TOPIC_EXTRACTION_USAGE_TYPE = 'semantic_topic_extraction' as const
export const SEMANTIC_TOPIC_EXTRACTION_MODEL = 'claude-sonnet-4-6' as const

// Mirrors the two-branch CHECK on topic_extraction_runs (073 SS15): S3A only
// ever produces the ai_assisted branch (provider/model/prompt_version set,
// deterministic_extractor_version NULL) -- a deterministic extractor is a
// separate, unstarted phase.
export const SEMANTIC_TOPIC_EXTRACTION_METHOD = 'ai_assisted' as const

export const SEMANTIC_TOPIC_NORMALIZATION_VERSION = 1
export const SEMANTIC_TOPIC_EXTRACTION_SCHEMA_VERSION = 1

// Must match the id/version/locale registered in lib/prompts/catalog.ts
// (semanticTopicExtraction) -- asserted at call time via
// assertPromptTemplateRegistered, same governance as every other AI call in
// the app, even though this layer uses its own narrow provider adapter
// (see provider-adapter.ts) rather than lib/services/ai-provider-service.ts.
export const SEMANTIC_TOPIC_PROMPT_ID = 'semantic_topic_extraction'
export const SEMANTIC_TOPIC_PROMPT_VERSION = 'v1'
export const SEMANTIC_TOPIC_PROMPT_LOCALE = 'en-US' as const

// v0 pilot limits -- pinned server-side identically inside migration 075's
// reserve_ai_provider_units RPC. Declared here too ONLY so the TypeScript
// layer can present the same numbers without a DB round trip (e.g. for
// error messages); the RPC is the actual source of enforcement, this is not
// a second enforcement point.
export const AI_QUOTA_MAX_REQUESTS_PER_UTC_DAY = 10
export const AI_QUOTA_MAX_MICRO_USD_PER_UTC_DAY = 1_000_000 // exactly $1.000000
export const AI_QUOTA_MAX_FAILED_ATTEMPTS_PER_DIGEST = 3

// USD per 1,000,000 tokens -- Claude Sonnet 4.6 pricing, pinned identically
// (as a literal, not a shared import) inside the 075 RPC bodies. Rounding
// contract: micro-USD = ceil(tokens * price_per_million), always NUMERIC,
// never float/double, always rounded UP so an estimate can never undercount
// the true cost. See the migration 075 header comment for the unit
// derivation (tokens * price_per_million, USD/1e6-tokens, already equals
// micro-USD directly).
export const AI_QUOTA_PRICE_INPUT_PER_MILLION_USD = 3.0
export const AI_QUOTA_PRICE_OUTPUT_PER_MILLION_USD = 15.0

// Conservative v0 ceiling used to size the PRE-CALL reservation estimate AND
// sent as the actual `max_tokens` to the provider, so the output side can
// never itself exceed what was reserved for it.
export const AI_QUOTA_MAX_OUTPUT_TOKENS = 1024

// Correction-gate item 3: the pre-call INPUT token estimate is derived from
// the full UTF-8 BYTE length of the exact text sent to the provider (system
// + user prompt), never from a char/N heuristic. This is a provable upper
// bound for any byte-level BPE tokenizer (the class Claude uses): such a
// tokenizer's vocabulary always includes single-byte fallback tokens, so a
// token can never span zero bytes and #tokens can never exceed #bytes.
// AI_QUOTA_INPUT_TOKEN_SAFETY_MARGIN then adds a documented +15% on top of
// that already-conservative bound, purely to absorb any tokenizer edge case
// (e.g. a future vocabulary change) without re-deriving the math -- not
// because the byte bound itself is expected to be tight.
export const AI_QUOTA_INPUT_TOKEN_SAFETY_MARGIN = 1.15

// Hard fail-closed ceiling on the full system+user prompt's UTF-8 byte
// length, checked BEFORE any reservation or provider call. A single
// signal_evidence item (title + snippet) is always short in practice; this
// is generous headroom, not a tight fit, so a rejection here means the
// input is genuinely anomalous, not that a normal evidence item was cut off.
export const AI_QUOTA_MAX_INPUT_BYTES = 20_000

// Correction-gate item 4: reconcile_stale_ai_provider_reservations' own
// staleness thresholds, mirrored here only so the orchestrator can call it
// with explicit, documented values rather than relying on the RPC's own
// defaults matching by coincidence.
export const AI_QUOTA_RECONCILE_UNSTARTED_STALE_AFTER_SECONDS = 600
export const AI_QUOTA_RECONCILE_STARTED_STALE_AFTER_SECONDS = 300

// Correction-gate 2 (crash-window): how long a 'committed' reservation may
// sit with application_outcome still NULL before reconciliation treats the
// calling application as crashed between commit and
// finalize_ai_provider_reservation_outcome. Deliberately NOT instant --
// a fresh committed-but-unfinalized row is a completely normal, expected
// transient state for the few hundred milliseconds between the two RPC
// calls in the same synchronous request; only a row that outlives this
// window is treated as abandoned.
export const AI_QUOTA_RECONCILE_COMMITTED_UNFINALIZED_STALE_AFTER_SECONDS = 600

export type ExtractionRunMode = 'validation_only' | 'shadow_extraction' | 'supervised_assignment'
