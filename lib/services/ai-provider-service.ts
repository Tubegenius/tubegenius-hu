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

let anthropicClient: Anthropic | null = null
function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
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
  const provider = input.provider || 'anthropic'
  if (provider === 'anthropic') return callAnthropic(input)
  throw new Error(`Nem tamogatott AI provider: ${provider}`)
}

// Egyetlen, robusztus JSON-kinyero — a repoban eddig 6+ helyen ujraírt,
// eltero minosegu extractJson()-valtozatok helyett. Kezeli a ```json code
// fence-eket es mind objektum ({...}), mind tomb ([...]) alaku valaszokat.
export function extractJson<T = unknown>(text: string): T {
  const cleaned = text.replace(/```json|```/g, '').trim()

  const firstBrace = cleaned.indexOf('{')
  const firstBracket = cleaned.indexOf('[')
  const useBracket = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)

  const closeChar = useBracket ? ']' : '}'
  const start = useBracket ? firstBracket : firstBrace
  const end = cleaned.lastIndexOf(closeChar)

  const jsonSlice = start !== -1 && end !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned

  try {
    return JSON.parse(jsonSlice) as T
  } catch (error) {
    console.error('extractJson parse failed:', jsonSlice.slice(0, 1500))
    throw error
  }
}
