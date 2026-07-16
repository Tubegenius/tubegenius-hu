// ============================================================
// WILLVIRAL — AI Provider Layer alap (Phase 1 #12, Fazis A)
// ============================================================
// Cel: egyetlen belepesi pont az AI-hivasokhoz, hogy a paid_results tabla
// provider/model/prompt_template_id/prompt_version/estimated_cost mezoi
// (migracio 021) vegre kitoltodjenek, es a jovoben masik providert (pl.
// OpenAI) is be lehessen kotni anelkul, hogy minden route-ot at kellene irni.
//
// FONTOS: ez a fazis meg NEM ir at egyetlen elo route-ot sem — csak a
// megosztott reteget hozza letre. A route-onkenti atallas kulon, egyesevel
// tortenik (lasd AI_PROVIDER_LAYER_REFACTOR_PLAN.md, Fazis B/C).

import Anthropic from '@anthropic-ai/sdk'
import { estimateCost } from '@/lib/credits'
import { MODELS } from '@/lib/models'
import '@/lib/prompts/catalog'
import { assertPromptTemplateRegistered } from '@/lib/prompts/template-registry'

export type AIProviderName = 'anthropic' | 'openai'

export interface AIProviderMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AICallInput {
  provider?: AIProviderName
  model: string
  system?: string
  messages: AIProviderMessage[]
  maxTokens: number
  promptTemplateId?: string
  promptVersion?: string
}

export interface AICallResult {
  text: string
  provider: AIProviderName
  model: string
  usage: { inputTokens: number; outputTokens: number }
  estimatedCost: number
  promptTemplateId: string | null
  promptVersion: string | null
}

const ALLOWED_MODELS = new Set<string>(Object.values(MODELS))
const MAX_OUTPUT_TOKENS = 8192
const MAX_PROMPT_CHARACTERS = 500_000

export function validateAICallInput(input: AICallInput): void {
  if (!ALLOWED_MODELS.has(input.model)) throw new Error(`Unsupported AI model: ${input.model}`)
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > MAX_OUTPUT_TOKENS) throw new Error('Invalid AI output token limit')
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 20) throw new Error('Invalid AI message count')
  const messageCharacters = input.messages.reduce((sum, message) => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim()) throw new Error('Invalid AI message')
    return sum + message.content.length
  }, 0)
  const totalCharacters = messageCharacters + (input.system?.length || 0)
  if (totalCharacters > MAX_PROMPT_CHARACTERS) throw new Error('AI prompt is too large')
  if (!input.promptTemplateId?.trim() || !input.promptVersion?.trim()) throw new Error('Every AI call must declare a versioned prompt template')
}

export function assertAICompletion(stopReason: string | null, text: string, inputTokens: number, outputTokens: number, maxTokens: number): void {
  if (stopReason === 'max_tokens') throw new Error(`AI response truncated at max token limit (${maxTokens})`)
  if (!text.trim()) throw new Error('AI provider returned an empty response')
  if (![inputTokens, outputTokens].every(value => Number.isFinite(value) && value >= 0)) throw new Error('AI provider returned invalid usage')
}

let anthropicClient: Anthropic | null = null
function getAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Anthropic is not configured')
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 })
  }
  return anthropicClient
}

async function callAnthropic(input: AICallInput): Promise<AICallResult> {
  const client = getAnthropicClient()
  const message = await client.messages.create({
    model: input.model,
    max_tokens: input.maxTokens,
    ...(input.system ? { system: input.system } : {}),
    messages: input.messages,
  })

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')

  const inputTokens = message.usage.input_tokens
  const outputTokens = message.usage.output_tokens
  assertAICompletion(message.stop_reason, text, inputTokens, outputTokens, input.maxTokens)

  return {
    text,
    provider: 'anthropic',
    model: input.model,
    usage: { inputTokens, outputTokens },
    estimatedCost: estimateCost(input.model, inputTokens, outputTokens),
    promptTemplateId: input.promptTemplateId || null,
    promptVersion: input.promptVersion || null,
  }
}

// Egyelore csak az Anthropic ag van bekotve — a transcript route OpenAI
// Whisper-hivasa (fajl-alapu, nem szoveges chat completion) mas alaku API,
// azt kulon fazisban erdemes idehozni, nem ezen az interfeszen keresztul.
export async function callAIProvider(input: AICallInput): Promise<AICallResult> {
  validateAICallInput(input)
  assertPromptTemplateRegistered(input.promptTemplateId!, input.promptVersion!)
  const provider = input.provider || 'anthropic'
  if (provider === 'anthropic') return callAnthropic(input)
  throw new Error(`Nem tamogatott AI provider: ${provider}`)
}

// Egyetlen, robusztus JSON-kinyero — a repoban eddig 6+ helyen ujraírt,
// eltero minosegu extractJson()-valtozatok helyett. Kezeli a ```json code
// fence-eket es mind objektum ({...}), mind tomb ([...]) alaku valaszokat.
export function extractJson<T = unknown>(text: string): T {
  if (typeof text !== 'string' || !text.trim()) throw new Error('AI response is empty')
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()

  const firstBrace = cleaned.indexOf('{')
  const firstBracket = cleaned.indexOf('[')
  const useBracket = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)

  const closeChar = useBracket ? ']' : '}'
  const start = useBracket ? firstBracket : firstBrace
  const end = cleaned.lastIndexOf(closeChar)

  if (start === -1 || end === -1 || end <= start) throw new Error('AI response contains no JSON object or array')

  const rawSlice = cleaned.slice(start, end + 1)

  // Claude alkalmanként a promptban tiltott sortoreseket is beszur egy-egy
  // string ertek (pl. "narration") belsejebe, ami nyers JSON.parse-t elrontana —
  // csak a stringliteralokon belul csereljuk le, nem az egesz valaszon.
  const jsonSlice = rawSlice.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, match => match.replace(/\r?\n/g, ' '))

  try {
    return JSON.parse(jsonSlice) as T
  } catch (error) {
    // Beta Hardening Test (2026-07-11) elo mereses: ~4%-ban Claude egy nem-escapelt
    // idezojelet tesz egy JSON string ERTEKEBE (pl. "...de az "sokkal konnyebb"
    // tulhajtas..."), ami ezen a ponton torne el a nyers JSON.parse-t. Nem a
    // temahossz/maxTokens a gyokerok (korabbi feltetelezes), rovid temakon is
    // eloall. Mielott feladnank, megprobaljuk automatikusan escapelni a string
    // ertekek BELSEJEBEN talalhato, nem strukturalis idezojeleket.
    const repaired = repairUnescapedInnerQuotes(jsonSlice)
    if (repaired !== jsonSlice) {
      try {
        return JSON.parse(repaired) as T
      } catch {
        // a javitasi kiserlet sem sikerult — az eredeti hibat dobjuk tovabb
      }
    }
    console.error('extractJson parse failed:', jsonSlice.slice(0, 1500))
    throw error
  }
}

// Egy karakterenkenti allapotgep: JSON stringen BELUL minden olyan `"`-t,
// amit nem strukturalisan ertelmes karakter (`,` `}` `]` `:` vagy a string
// vege) kovet, nem-escapelt belso idezojelnek tekint es escapeli — a valodi
// lezaro idezojeleket (amiket strukturalis karakter kovet) erintetlenul hagyja.
function repairUnescapedInnerQuotes(input: string): string {
  let result = ''
  let inString = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inString && ch === '\\') {
      result += ch + (input[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') {
      if (!inString) {
        inString = true
        result += ch
        continue
      }
      let j = i + 1
      while (j < input.length && /\s/.test(input[j])) j++
      const next = j < input.length ? input[j] : undefined
      const isRealClose = next === undefined || next === ',' || next === '}' || next === ']' || next === ':'
      if (isRealClose) {
        inString = false
        result += ch
      } else {
        result += '\\"'
      }
      continue
    }
    result += ch
  }
  return result
}
