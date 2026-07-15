import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { promoteToTrackedCandidate } from '@/lib/trend-tracking'
import {
  ensureVideoIdea,
  linkVideoIdeaToLegacyRecord,
  logVideoIdeaEvent,
  mapMemoryStateToWorkflowStatus,
  setVideoIdeaWorkflowStatus,
  fetchDecisiveVideoIdeas,
  matchRelatedOutcomes,
} from '@/lib/video-ideas/video-idea-service'
import type { TopicState, MemoryProofSignalSummary, MemoryInsight, VideoIdeaProofSignal, VideoIdeaEvent } from '@/types'
import { isOptionalTextWithinLimit, isScoreOrNull, topicInputTooLong } from '@/lib/api-input-validation'

const MEMORY_STATES: TopicState[] = ['saved', 'in_progress', 'completed', 'rejected']

function isMemoryState(value: unknown): value is TopicState {
  return typeof value === 'string' && MEMORY_STATES.includes(value as TopicState)
}

// GET: temak listazasa
export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  }

  const admin = createAdminClient()
  const { searchParams } = new URL(request.url)
  const state = searchParams.get('state') as TopicState | null
  // Korabban nem volt semmilyen limit — minden mentett tema egyszerre
  // toltodott be minden oldal-nyitaskor, plusz mindegyikhez lefutott a
  // Jaccard-insight szamitas (enrichMemoryItems). Ez egy ideiglenes,
  // egyszeru felso korlat valodi lapozas nelkul is.
  const limit = Math.min(Math.max(Number(searchParams.get('limit') || 200), 1), 500)

  let query = admin
    .from('creator_memory')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (state) {
    query = query.eq('state', state)
  }

  const { data, error } = await query

  if (error) {
    console.error('Memory GET error:', error)
    return NextResponse.json({ error: 'A tartalommemória betöltése sikertelen. Próbáld újra.' }, { status: 500 })
  }

  const items = data || []
  const enriched = await enrichMemoryItems(admin, user.id, items)

  return NextResponse.json({ items: enriched })
}

// Egy request-en belul egyszer keri le a proof signal-okat, eseményeket es a
// lezart-allapotu otlet-poolt, majd mindezt in-memory osztja szet a tetelek kozott —
// igy nem N+1 lekerdezes fut le, hanem konstans darabszamu.
async function enrichMemoryItems(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  items: Array<Record<string, unknown>>
) {
  const videoIdeaIds = Array.from(
    new Set(items.map(item => item.video_idea_id as string | null).filter((id): id is string => !!id))
  )

  const signalsByIdea = new Map<string, VideoIdeaProofSignal[]>()
  const eventsByIdea = new Map<string, VideoIdeaEvent[]>()

  if (videoIdeaIds.length > 0) {
    const [{ data: signals }, { data: events }] = await Promise.all([
      admin.from('video_idea_proof_signals').select('*').in('video_idea_id', videoIdeaIds),
      admin.from('video_idea_events').select('*').in('video_idea_id', videoIdeaIds).order('created_at', { ascending: false }),
    ])
    for (const signal of (signals as VideoIdeaProofSignal[] | null) || []) {
      const list = signalsByIdea.get(signal.video_idea_id) || []
      list.push(signal)
      signalsByIdea.set(signal.video_idea_id, list)
    }
    for (const event of (events as VideoIdeaEvent[] | null) || []) {
      const list = eventsByIdea.get(event.video_idea_id) || []
      if (list.length < 5) list.push(event)
      eventsByIdea.set(event.video_idea_id, list)
    }
  }

  const decisivePool = await fetchDecisiveVideoIdeas(admin, userId)

  return items.map(item => {
    const videoIdeaId = item.video_idea_id as string | null
    const signals = (videoIdeaId ? signalsByIdea.get(videoIdeaId) : undefined) || []
    const proofSignals: MemoryProofSignalSummary = {
      strong: signals.filter(s => s.strength === 'strong').length,
      medium: signals.filter(s => s.strength === 'medium').length,
      weak: signals.filter(s => s.strength === 'weak').length,
      rejected: signals.filter(s => s.strength === 'rejected').length,
      items: signals.slice(0, 5).map(s => ({
        signal_type: s.signal_type,
        title: s.title,
        url: s.url,
        strength: s.strength,
        source_tool: s.source_tool,
      })),
    }

    const match = matchRelatedOutcomes(item.topic as string, item.platform as string | null, decisivePool, videoIdeaId)
    const insight: MemoryInsight | null = match.positive || match.negative
      ? {
          positive: match.positive && { topic: match.positive.topic, workflow_status: match.positive.workflow_status, updated_at: match.positive.updated_at, overlap: match.positive.overlap },
          negative: match.negative && { topic: match.negative.topic, workflow_status: match.negative.workflow_status, updated_at: match.negative.updated_at, overlap: match.negative.overlap },
        }
      : null

    return {
      ...item,
      proof_signals: proofSignals,
      events: videoIdeaId ? eventsByIdea.get(videoIdeaId) || [] : [],
      insight,
    }
  })
}

// POST: tema mentese/frissitese
export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  }

  const { topic, search_keyword, state, opportunity_score, viral_score, audit_score, audit_id, video_package_id, platform, notes, source_context, quality_status } = await request.json()

  if (typeof topic !== 'string' || !topic.trim()) {
    return NextResponse.json({ error: "Tema kotelezo" }, { status: 400 })
  }
  if (topicInputTooLong(topic)) return NextResponse.json({ error: 'A téma legfeljebb 300 karakter lehet' }, { status: 400 })
  if (state !== undefined && !isMemoryState(state)) return NextResponse.json({ error: 'Érvénytelen memóriaállapot' }, { status: 400 })
  if (![opportunity_score, viral_score, audit_score].every(isScoreOrNull)) return NextResponse.json({ error: 'A score értékeknek 0 és 100 közé kell esniük' }, { status: 400 })
  if (!isOptionalTextWithinLimit(notes, 5000) || !isOptionalTextWithinLimit(search_keyword, 300) || !isOptionalTextWithinLimit(source_context, 100) || !isOptionalTextWithinLimit(quality_status, 100)) return NextResponse.json({ error: 'Túl hosszú szöveges mező' }, { status: 400 })
  const isJunkTopic = topic.includes("#") || (topic.length > 100 && !opportunity_score && !viral_score)
  if (isJunkTopic) return NextResponse.json({ skipped: true })
  const admin = createAdminClient()

  const record: Record<string, unknown> = {
    user_id: user.id,
    topic,
    search_keyword: search_keyword || null,
    state: state || 'saved',
    opportunity_score: opportunity_score ?? null,
    viral_score: viral_score ?? null,
    platform: platform || 'youtube',
    notes: notes || null,
    updated_at: new Date().toISOString(),
  }
  if (audit_score !== undefined) record.audit_score = audit_score
  if (audit_id) record.audit_id = audit_id
  if (video_package_id) record.video_package_id = video_package_id
  if (source_context) record.source_context = source_context
  if (quality_status) record.quality_status = quality_status

  const { data, error } = await admin
    .from('creator_memory')
    .upsert(record, { onConflict: 'user_id,topic' })
    .select()
    .single()

  if (error) {
    console.error('Memory POST error:', error)
    return NextResponse.json({ error: 'A mentés sikertelen. Próbáld újra.' }, { status: 500 })
  }

  const ideaResult = await ensureVideoIdea(admin, {
    userId: user.id,
    title: topic,
    topic,
    platform: platform || 'youtube',
    opportunityScore: opportunity_score ?? null,
    viralScore: viral_score ?? null,
    workflowStatus: state === 'rejected' ? 'rejected' : state === 'completed' ? 'published' : 'new_idea',
    metadata: {
      source_context: source_context || 'creator_memory',
      search_keyword: search_keyword || null,
      quality_status: quality_status || null,
    },
  })

  if (ideaResult.idea?.id && data?.id) {
    await linkVideoIdeaToLegacyRecord(admin, {
      table: 'creator_memory',
      userId: user.id,
      recordId: data.id,
      videoIdeaId: ideaResult.idea.id,
    })
    await logVideoIdeaEvent(admin, {
      userId: user.id,
      videoIdeaId: ideaResult.idea.id,
      eventType: state === 'rejected' ? 'idea_rejected' : 'idea_saved',
      sourceTool: source_context || 'creator_memory',
      payload: { topic, search_keyword, state: state || 'saved' },
    })
  }

  // Amit a user explicit ment, azt limitáltan trackeljük (háttérfrissítés célra) —
  // hiba esetén nem törheti el a mentést.
  await promoteToTrackedCandidate({
    userId: user.id,
    candidateTopic: topic,
    opportunityScore: opportunity_score ?? null,
    force: true,
  }).catch(() => {})

  return NextResponse.json({ item: data })
}

// PATCH: allapot frissitese
export async function PATCH(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  }

  const { id, state, notes } = await request.json()
  if (typeof id !== 'string' || !id) return NextResponse.json({ error: 'Azonosító kötelező' }, { status: 400 })
  if (!isMemoryState(state)) return NextResponse.json({ error: 'Érvénytelen memóriaállapot' }, { status: 400 })
  if (!isOptionalTextWithinLimit(notes, 5000)) return NextResponse.json({ error: 'A jegyzet túl hosszú' }, { status: 400 })
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('creator_memory')
    .update({ state, notes, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) {
    console.error('Memory PATCH error:', error)
    return NextResponse.json({ error: 'Az állapot frissítése sikertelen. Próbáld újra.' }, { status: 500 })
  }

  // Allapotvaltas eseten a linkelt Video Idea workflow_status-at is szinkronizaljuk,
  // hogy a memoria-mozgas a kozponti adatmodellben (es a jovobeli tanulasi mintaban) is lathato legyen.
  if (state && data?.video_idea_id) {
    const targetStatus = mapMemoryStateToWorkflowStatus(state as 'saved' | 'in_progress' | 'completed' | 'rejected')
    const result = await setVideoIdeaWorkflowStatus(admin, {
      userId: user.id,
      videoIdeaId: data.video_idea_id,
      workflowStatus: targetStatus,
    })
    if (result.success && result.previous !== targetStatus) {
      await logVideoIdeaEvent(admin, {
        userId: user.id,
        videoIdeaId: data.video_idea_id,
        eventType: 'state_changed',
        sourceTool: 'creator_memory',
        payload: { from: result.previous, to: targetStatus, memory_state: state },
      })
    }
  }

  return NextResponse.json({ item: data })
}

// DELETE: tema torlese
export async function DELETE(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  }

  const { id } = await request.json()
  const admin = createAdminClient()

  const { error } = await admin
    .from('creator_memory')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    console.error('Memory DELETE error:', error)
    return NextResponse.json({ error: 'A törlés sikertelen. Próbáld újra.' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
