import crypto from 'crypto'
import { createServerClient } from '@supabase/ssr'

export type PaidToolType =
  | 'viral_score'
  | 'similar_videos'
  | 'opportunity_engine'
  | 'video_audit'
  | 'video_package'
  | 'script_extract'
  | 'transcript_extract'
  | 'content_gap'
  | 'analyzer'
  | 'keyword_research'
  | 'competitor_tracker'
  | 'outlier_detector'
  | 'title_studio'
  | 'thumbnail_studio'
  | 'seo_optimizer'
  | 'opportunity_explain'
  | 'channel_audit'

export type PaidResultCacheStatus = 'fresh' | 'stale_saved' | 'miss'

export interface PaidResultRecord {
  id: string
  user_id: string
  tool_type: PaidToolType
  input_hash: string
  normalized_input: string
  original_input: string
  main_category: string | null
  specific_focus: string | null
  region: string | null
  language: string | null
  platform: string | null
  result_json: unknown
  summary_json: unknown
  credit_cost: number
  status: 'completed' | 'failed' | 'refreshed' | 'archived'
  created_at: string
  updated_at: string
  last_opened_at: string
  last_refreshed_at: string
  fresh_until: string | null
  source_run_id: string | null
  linked_video_idea_id: string | null
  provider: string | null
  model: string | null
  prompt_template_id: string | null
  prompt_version: string | null
  estimated_cost: number | null
}

function adminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return [] }, setAll() {} } }
  )
}

function stableStringify(value: unknown): string {
  if (value == null) return ''
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  return '{' + Object.keys(obj).sort().map(key => key + ':' + stableStringify(obj[key])).join('|') + '}'
}

export function normalizePaidResultInput(input: unknown): string {
  return stableStringify(input)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s|:{}\[\],_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildPaidResultHash(input: {
  userId: string
  toolType: PaidToolType
  normalizedInput: string
  mainCategory?: string | null
  specificFocus?: string | null
  region?: string | null
  language?: string | null
  platform?: string | null
}) {
  const raw = [
    input.userId,
    input.toolType,
    input.normalizedInput,
    input.mainCategory || '',
    input.specificFocus || '',
    input.region || '',
    input.language || '',
    input.platform || '',
  ].join('|')
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function paidCacheStatus(record: Pick<PaidResultRecord, 'fresh_until' | 'last_refreshed_at'>): PaidResultCacheStatus {
  if (record.fresh_until && new Date(record.fresh_until).getTime() >= Date.now()) return 'fresh'
  return 'stale_saved'
}

export function paidResultResponseMeta(record: PaidResultRecord) {
  return {
    from_paid_result: true,
    cache_status: paidCacheStatus(record),
    requires_credit: false,
    last_analyzed_at: record.last_refreshed_at || record.created_at,
    paid_result_id: record.id,
  }
}

export async function getPaidResultById(userId: string, id?: string | null): Promise<PaidResultRecord | null> {
  if (!id) return null
  try {
    const { data } = await adminClient()
      .from('paid_results')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'completed')
      .single()
    return data as PaidResultRecord | null
  } catch {
    return null
  }
}

export async function getPaidResultByHash(params: {
  userId: string
  toolType: PaidToolType
  inputHash: string
}): Promise<PaidResultRecord | null> {
  try {
    const { data } = await adminClient()
      .from('paid_results')
      .select('*')
      .eq('user_id', params.userId)
      .eq('tool_type', params.toolType)
      .eq('input_hash', params.inputHash)
      .eq('status', 'completed')
      .single()
    return data as PaidResultRecord | null
  } catch {
    return null
  }
}

export async function openPaidResult(record: PaidResultRecord): Promise<PaidResultRecord> {
  try {
    const now = new Date().toISOString()
    await adminClient().from('paid_results').update({ last_opened_at: now }).eq('id', record.id).eq('user_id', record.user_id)
    return { ...record, last_opened_at: now }
  } catch {
    return record
  }
}

export async function savePaidResult(input: {
  userId: string
  toolType: PaidToolType
  inputHash: string
  normalizedInput: string
  originalInput: string
  mainCategory?: string | null
  specificFocus?: string | null
  region?: string | null
  language?: string | null
  platform?: string | null
  resultJson: unknown
  summaryJson?: unknown
  creditCost?: number
  freshForHours?: number
  sourceRunId?: string | null
  linkedVideoIdeaId?: string | null
  provider?: string | null
  model?: string | null
  promptTemplateId?: string | null
  promptVersion?: string | null
  estimatedCost?: number | null
}): Promise<{ success: boolean; record?: PaidResultRecord; error?: string }> {
  try {
    const now = new Date().toISOString()
    const freshUntil = input.freshForHours
      ? new Date(Date.now() + input.freshForHours * 3600000).toISOString()
      : null
    const { data, error } = await adminClient()
      .from('paid_results')
      .upsert({
        user_id: input.userId,
        tool_type: input.toolType,
        input_hash: input.inputHash,
        normalized_input: input.normalizedInput,
        original_input: input.originalInput,
        main_category: input.mainCategory || null,
        specific_focus: input.specificFocus || null,
        region: input.region || null,
        language: input.language || null,
        platform: input.platform || null,
        result_json: input.resultJson,
        summary_json: input.summaryJson || {},
        credit_cost: input.creditCost || 0,
        status: 'completed',
        updated_at: now,
        last_opened_at: now,
        last_refreshed_at: now,
        fresh_until: freshUntil,
        source_run_id: input.sourceRunId || null,
        ...(input.linkedVideoIdeaId !== undefined ? { linked_video_idea_id: input.linkedVideoIdeaId } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.promptTemplateId !== undefined ? { prompt_template_id: input.promptTemplateId } : {}),
        ...(input.promptVersion !== undefined ? { prompt_version: input.promptVersion } : {}),
        ...(input.estimatedCost !== undefined ? { estimated_cost: input.estimatedCost } : {}),
      }, { onConflict: 'user_id,tool_type,input_hash' })
      .select('*')
      .single()

    if (error) return { success: false, error: error.message }
    return { success: true, record: data as PaidResultRecord }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'unknown error' }
  }
}
