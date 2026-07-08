import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export type VideoIdeaWorkflowStatus =
  | 'new_idea'
  | 'validating'
  | 'validated'
  | 'ready_to_produce'
  | 'scheduled'
  | 'published'
  | 'audited'
  | 'rejected'
  | 'archived'

export type ProofSignalType =
  | 'similar_video'
  | 'competitor_video'
  | 'web_source'
  | 'trend_signal'
  | 'keyword_signal'
  | 'transcript'
  | 'manual_note'

export interface VideoIdeaRecord {
  id: string
  user_id: string
  title: string
  topic: string
  short_description: string | null
  niche: string | null
  platform: string | null
  language: string | null
  market: string | null
  country: string | null
  currency: string | null
  timezone: string | null
  content_format: string | null
  viral_score: number | null
  opportunity_score: number | null
  competition_score: number | null
  proof_summary: string | null
  video_package_id: string | null
  audit_result_id: string | null
  calendar_status: string | null
  publish_status: string | null
  workflow_status: VideoIdeaWorkflowStatus
  paid_result_reference: string | null
  input_hash: string | null
  created_at: string
  updated_at: string
}

export interface EnsureVideoIdeaInput {
  userId: string
  title?: string | null
  topic: string
  shortDescription?: string | null
  niche?: string | null
  platform?: string | null
  language?: string | null
  market?: string | null
  country?: string | null
  currency?: string | null
  timezone?: string | null
  contentFormat?: string | null
  keywords?: unknown[]
  viralScore?: number | null
  opportunityScore?: number | null
  competitionScore?: number | null
  proofSummary?: string | null
  workflowStatus?: VideoIdeaWorkflowStatus
  paidResultReference?: string | null
  inputHash?: string | null
  metadata?: Record<string, unknown>
}

export interface ProofSignalInput {
  userId: string
  videoIdeaId: string
  signalType: ProofSignalType
  sourceTool?: string | null
  sourceId?: string | null
  title?: string | null
  url?: string | null
  channelTitle?: string | null
  publishedAt?: string | null
  viewCount?: number | null
  relevanceScore?: number | null
  strength?: 'strong' | 'medium' | 'weak' | 'rejected' | null
  reason?: string | null
  payload?: Record<string, unknown>
}

function normalizeText(value: string | null | undefined) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildVideoIdeaInputHash(input: {
  userId: string
  topic: string
  platform?: string | null
  language?: string | null
  market?: string | null
}) {
  const raw = [
    input.userId,
    normalizeText(input.topic),
    input.platform || 'youtube',
    input.language || 'hu',
    input.market || 'HU',
  ].join('|')
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

// ensureVideoIdea mindig ír workflow_status-t (alapertelmezetten 'new_idea'-t,
// ha nincs megadva) — ez helyes a explicit user-akciónal (memory mentés,
// videocsomag keszites), de veszelyes egy automatikus, hattérben futó
// validáció (Similar Videos / Viral Score) hívásánál: ha nem vigyázunk,
// egy már 'ready_to_produce' ötletet visszaállíthatna 'new_idea'-ra.
// Ezt a két helpert kifejezetten az ilyen, NEM explicit-user-akció hívásokhoz
// hasznaljuk: lekérdezzük a jelenlegi státuszt, és sosem lépünk visszafelé.
const WORKFLOW_RANK: Record<VideoIdeaWorkflowStatus, number> = {
  new_idea: 0,
  validating: 1,
  validated: 2,
  ready_to_produce: 3,
  scheduled: 4,
  published: 5,
  audited: 6,
  rejected: -1,
  archived: -1,
}
const TERMINAL_STATUSES = new Set<VideoIdeaWorkflowStatus>(['rejected', 'archived', 'published', 'audited', 'scheduled'])

export async function getVideoIdeaWorkflowStatus(
  admin: SupabaseClient,
  userId: string,
  inputHash: string
): Promise<VideoIdeaWorkflowStatus | null> {
  const { data } = await admin
    .from('video_ideas')
    .select('workflow_status')
    .eq('user_id', userId)
    .eq('input_hash', inputHash)
    .single()
  return (data?.workflow_status as VideoIdeaWorkflowStatus) || null
}

export function forwardWorkflowStatus(
  current: VideoIdeaWorkflowStatus | null,
  candidate: VideoIdeaWorkflowStatus
): VideoIdeaWorkflowStatus {
  if (!current) return candidate
  if (TERMINAL_STATUSES.has(current)) return current
  return WORKFLOW_RANK[candidate] > WORKFLOW_RANK[current] ? candidate : current
}

export async function ensureVideoIdea(
  admin: SupabaseClient,
  input: EnsureVideoIdeaInput
): Promise<{ success: boolean; idea?: VideoIdeaRecord; error?: string; skipped?: boolean }> {
  try {
    const topic = input.topic?.trim()
    if (!topic) return { success: false, skipped: true, error: 'missing_topic' }

    const platform = input.platform || 'youtube'
    const language = input.language || 'hu'
    const market = input.market || 'HU'
    const inputHash = input.inputHash || buildVideoIdeaInputHash({
      userId: input.userId,
      topic,
      platform,
      language,
      market,
    })

    const payload = compactRecord({
      user_id: input.userId,
      title: (input.title || topic).trim(),
      topic,
      short_description: input.shortDescription || null,
      niche: input.niche || null,
      platform,
      language,
      market,
      country: input.country || null,
      currency: input.currency || (market === 'HU' ? 'HUF' : 'USD'),
      timezone: input.timezone || (market === 'HU' ? 'Europe/Budapest' : 'UTC'),
      content_format: input.contentFormat || null,
      keywords: input.keywords || [],
      viral_score: input.viralScore ?? null,
      opportunity_score: input.opportunityScore ?? null,
      competition_score: input.competitionScore ?? null,
      proof_summary: input.proofSummary || null,
      workflow_status: input.workflowStatus || 'new_idea',
      paid_result_reference: input.paidResultReference || null,
      input_hash: inputHash,
      metadata: input.metadata || {},
      updated_at: new Date().toISOString(),
    })

    const { data: existing } = await admin
      .from('video_ideas')
      .select('id')
      .eq('user_id', input.userId)
      .eq('input_hash', inputHash)
      .single()

    const query = existing?.id
      ? admin
        .from('video_ideas')
        .update(payload)
        .eq('id', existing.id)
        .eq('user_id', input.userId)
        .select('*')
        .single()
      : admin
        .from('video_ideas')
        .insert(payload)
        .select('*')
        .single()

    const { data, error } = await query

    if (error) return { success: false, error: error.message }
    return { success: true, idea: data as VideoIdeaRecord }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'unknown_error',
    }
  }
}

export async function logVideoIdeaEvent(
  admin: SupabaseClient,
  input: {
    userId: string
    videoIdeaId: string
    eventType: string
    sourceTool?: string | null
    payload?: Record<string, unknown>
  }
) {
  try {
    await admin.from('video_idea_events').insert({
      user_id: input.userId,
      video_idea_id: input.videoIdeaId,
      event_type: input.eventType,
      source_tool: input.sourceTool || null,
      payload: input.payload || {},
    })
  } catch {}
}

export async function addVideoIdeaProofSignal(admin: SupabaseClient, input: ProofSignalInput) {
  try {
    const { data, error } = await admin
      .from('video_idea_proof_signals')
      .insert({
        user_id: input.userId,
        video_idea_id: input.videoIdeaId,
        signal_type: input.signalType,
        source_tool: input.sourceTool || null,
        source_id: input.sourceId || null,
        title: input.title || null,
        url: input.url || null,
        channel_title: input.channelTitle || null,
        published_at: input.publishedAt || null,
        view_count: input.viewCount ?? null,
        relevance_score: input.relevanceScore ?? null,
        strength: input.strength || null,
        reason: input.reason || null,
        payload: input.payload || {},
      })
      .select('id')
      .single()

    if (error) return { success: false, error: error.message }
    return { success: true, id: data?.id as string | undefined }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'unknown_error',
    }
  }
}

export async function linkVideoIdeaToLegacyRecord(
  admin: SupabaseClient,
  input: {
    table: 'creator_memory' | 'video_packages'
    userId: string
    recordId: string
    videoIdeaId: string
  }
) {
  try {
    await admin
      .from(input.table)
      .update({ video_idea_id: input.videoIdeaId })
      .eq('id', input.recordId)
      .eq('user_id', input.userId)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'unknown_error',
    }
  }
}

// ============================================================
// CREATOR MEMORY MELYITES — "ez korabban bejott/nem jott be nalad"
// ============================================================

// Csak PATCH-bol (explicit allapotvaltas) hasznaljuk. Szandekosan NEM 'ready_to_produce',
// mert a Command Center azt a "van kesz gyartasi csomag" jelzesre hasznalja
// (app/api/dashboard/summary/route.ts readyIdeas szurese) — egy puszta memoria-mozgas
// nem jelent tenyleges csomagot.
const MEMORY_STATE_TO_WORKFLOW: Record<'saved' | 'in_progress' | 'completed' | 'rejected', VideoIdeaWorkflowStatus> = {
  saved: 'validated',
  in_progress: 'validating',
  completed: 'published',
  rejected: 'rejected',
}

export function mapMemoryStateToWorkflowStatus(
  state: 'saved' | 'in_progress' | 'completed' | 'rejected'
): VideoIdeaWorkflowStatus {
  return MEMORY_STATE_TO_WORKFLOW[state] || 'new_idea'
}

export interface DecisiveVideoIdea {
  id: string
  topic: string
  platform: string | null
  workflow_status: VideoIdeaWorkflowStatus
  viral_score: number | null
  updated_at: string
}

const DECISIVE_STATUSES: VideoIdeaWorkflowStatus[] = ['published', 'audited', 'rejected']
const STOPWORDS = new Set([
  'hogy', 'mert', 'akkor', 'ezt', 'azt', 'ilyen', 'olyan', 'ehhez', 'ahhoz',
  'video', 'videot', 'videos', 'the', 'and', 'this', 'that', 'with', 'from', 'your',
])

// Csak a "dontes utani" allapotu otletek relevansak tanulasi mintanak —
// egy meg validalatlan otletnek nincs kimenetele, amit tanulsagkent lehetne mutatni.
export async function fetchDecisiveVideoIdeas(
  admin: SupabaseClient,
  userId: string,
  limit = 300
): Promise<DecisiveVideoIdea[]> {
  const { data } = await admin
    .from('video_ideas')
    .select('id, topic, platform, workflow_status, viral_score, updated_at')
    .eq('user_id', userId)
    .in('workflow_status', DECISIVE_STATUSES)
    .order('updated_at', { ascending: false })
    .limit(limit)
  return (data as DecisiveVideoIdea[] | null) || []
}

function topicTokens(topic: string): Set<string> {
  return new Set(
    normalizeText(topic)
      .split(' ')
      .filter(word => word.length >= 4 && !STOPWORDS.has(word))
  )
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const word of a) {
    if (b.has(word)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

const OVERLAP_THRESHOLD = 0.34

export interface RelatedOutcomeMatch {
  topic: string
  workflow_status: VideoIdeaWorkflowStatus
  updated_at: string
  overlap: number
}

export interface RelatedOutcomes {
  positive?: RelatedOutcomeMatch
  negative?: RelatedOutcomeMatch
}

// Egy adott tema es egy mar lezart-allapotu otlethalmaz osszevetese —
// tiszta fuggveny, hogy egy request-en belul egyszer lekert pool-t
// tobb creator_memory tetelre is ujra lehessen hasznalni N+1 lekerdezes nelkul.
export function matchRelatedOutcomes(
  topic: string,
  platform: string | null | undefined,
  pool: DecisiveVideoIdea[],
  excludeVideoIdeaId?: string | null
): RelatedOutcomes {
  const tokens = topicTokens(topic)
  if (tokens.size === 0) return {}

  let bestPositive: RelatedOutcomeMatch | undefined
  let bestNegative: RelatedOutcomeMatch | undefined

  for (const candidate of pool) {
    if (excludeVideoIdeaId && candidate.id === excludeVideoIdeaId) continue
    const overlap = jaccardOverlap(tokens, topicTokens(candidate.topic))
    if (overlap < OVERLAP_THRESHOLD) continue
    const platformBonus = platform && candidate.platform === platform ? 0.05 : 0
    const score = overlap + platformBonus

    if (candidate.workflow_status === 'rejected') {
      if (!bestNegative || score > bestNegative.overlap) {
        bestNegative = { topic: candidate.topic, workflow_status: candidate.workflow_status, updated_at: candidate.updated_at, overlap: score }
      }
    } else {
      if (!bestPositive || score > bestPositive.overlap) {
        bestPositive = { topic: candidate.topic, workflow_status: candidate.workflow_status, updated_at: candidate.updated_at, overlap: score }
      }
    }
  }

  return { positive: bestPositive, negative: bestNegative }
}

export async function setVideoIdeaWorkflowStatus(
  admin: SupabaseClient,
  input: { userId: string; videoIdeaId: string; workflowStatus: VideoIdeaWorkflowStatus }
): Promise<{ success: boolean; previous?: VideoIdeaWorkflowStatus | null; error?: string }> {
  try {
    const { data: existing } = await admin
      .from('video_ideas')
      .select('workflow_status')
      .eq('id', input.videoIdeaId)
      .eq('user_id', input.userId)
      .single()

    const { error } = await admin
      .from('video_ideas')
      .update({ workflow_status: input.workflowStatus, updated_at: new Date().toISOString() })
      .eq('id', input.videoIdeaId)
      .eq('user_id', input.userId)

    if (error) return { success: false, error: error.message }
    return { success: true, previous: (existing?.workflow_status as VideoIdeaWorkflowStatus) || null }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'unknown_error' }
  }
}

export async function markVideoIdeaReadyToProduce(
  admin: SupabaseClient,
  input: {
    userId: string
    videoIdeaId: string
    videoPackageId: string
  }
) {
  try {
    await admin
      .from('video_ideas')
      .update({
        video_package_id: input.videoPackageId,
        workflow_status: 'ready_to_produce',
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.videoIdeaId)
      .eq('user_id', input.userId)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'unknown_error',
    }
  }
}
