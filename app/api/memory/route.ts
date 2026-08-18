import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { promoteToTrackedCandidate } from '@/lib/trend-tracking'
import {
  ensureVideoIdea,
  logVideoIdeaEvent,
  mapMemoryStateToWorkflowStatus,
  setVideoIdeaWorkflowStatus,
  fetchDecisiveVideoIdeas,
  matchRelatedOutcomes,
  linkVideoIdeaToLegacyRecord,
} from '@/lib/video-ideas/video-idea-service'
import type { TopicState, MemoryProofSignalSummary, MemoryInsight, VideoIdeaProofSignal, VideoIdeaEvent } from '@/types'
import { isOptionalTextWithinLimit, isScoreOrNull, topicInputTooLong } from '@/lib/api-input-validation'
import { upsertCreatorMemory, getCreatorMemoryByLaneFilter, assertValidLaneFilter } from '@/lib/creator-lane/lane-service'

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
  const stateParam = searchParams.get('state')
  if (stateParam !== null && !isMemoryState(stateParam)) return NextResponse.json({ error: 'Érvénytelen memóriaállapot' }, { status: 400 })
  const state = stateParam as TopicState | null
  // Korabban nem volt semmilyen limit — minden mentett tema egyszerre
  // toltodott be minden oldal-nyitaskor, plusz mindegyikhez lefutott a
  // Jaccard-insight szamitas (enrichMemoryItems). Ez egy ideiglenes,
  // egyszeru felso korlat valodi lapozas nelkul is.
  const limit = Math.min(Math.max(Number(searchParams.get('limit') || 200), 1), 500)

  // Explicit lane-szures: ?lane= nelkul kizarolag a legacy/pending
  // (content_lane IS NULL) rekordokat adjuk vissza — nincs implicit
  // "minden lane" mod. Mai kliens sosem kuld lane-t, es minden meglevo sor
  // ma is NULL-lane, tehat ez byte-pontosan ugyanazt a talalati halmazt
  // adja, mint korabban; ervenytelen lane ertek fail-closed 400-at kap.
  const laneParam = searchParams.get('lane')
  let contentLane: 'evidence_led' | 'entertainment_led' | null
  try {
    contentLane = assertValidLaneFilter(laneParam)
  } catch {
    return NextResponse.json({ error: 'Érvénytelen lane paraméter' }, { status: 400 })
  }

  let items: Record<string, unknown>[]
  try {
    items = await getCreatorMemoryByLaneFilter(admin, { userId: user.id, contentLane, state: state || undefined, limit })
  } catch (error) {
    console.error('Memory GET error:', error)
    return NextResponse.json({ error: 'A tartalommemória betöltése sikertelen. Próbáld újra.' }, { status: 500 })
  }
  try {
    const enriched = await enrichMemoryItems(admin, user.id, items)
    return NextResponse.json({ items: enriched })
  } catch (error) {
    console.error('Memory enrichment error:', error)
    return NextResponse.json({ error: 'A memória bizonyítékainak betöltése sikertelen.' }, { status: 500 })
  }
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
    const [{ data: signals, error: signalsError }, { data: events, error: eventsError }] = await Promise.all([
      admin.from('video_idea_proof_signals').select('*').eq('user_id', userId).in('video_idea_id', videoIdeaIds),
      admin.from('video_idea_events').select('*').eq('user_id', userId).in('video_idea_id', videoIdeaIds).order('created_at', { ascending: false }),
    ])
    if (signalsError || eventsError) throw new Error('memory_enrichment_load_failed')
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
    const insight: MemoryInsight | null = match.published || match.rejected
      ? {
          published: match.published && { topic: match.published.topic, workflow_status: match.published.workflow_status, updated_at: match.published.updated_at, overlap: match.published.overlap },
          rejected: match.rejected && { topic: match.rejected.topic, workflow_status: match.rejected.workflow_status, updated_at: match.rejected.updated_at, overlap: match.rejected.overlap },
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
  if (platform !== undefined && !['youtube', 'youtube_long', 'youtube_shorts', 'tiktok', 'instagram_reels', 'facebook_reels'].includes(platform)) return NextResponse.json({ error: 'Érvénytelen platform' }, { status: 400 })
  if (!isOptionalTextWithinLimit(notes, 5000) || !isOptionalTextWithinLimit(search_keyword, 300) || !isOptionalTextWithinLimit(source_context, 100) || !isOptionalTextWithinLimit(quality_status, 100)) return NextResponse.json({ error: 'Túl hosszú szöveges mező' }, { status: 400 })
  const isJunkTopic = topic.includes("#") || (topic.length > 100 && !opportunity_score && !viral_score)
  if (isJunkTopic) return NextResponse.json({ skipped: true })
  const admin = createAdminClient()

  const ideaResult = await ensureVideoIdea(admin, {
    userId: user.id,
    title: topic.trim(),
    topic: topic.trim(),
    platform: platform || 'youtube',
    opportunityScore: opportunity_score ?? null,
    viralScore: viral_score ?? null,
    workflowStatus: mapMemoryStateToWorkflowStatus((state || 'saved') as 'saved' | 'in_progress' | 'completed' | 'rejected'),
    metadata: {
      source_context: source_context || 'creator_memory',
      search_keyword: search_keyword || null,
      quality_status: quality_status || null,
    },
  })
  if (!ideaResult.success || !ideaResult.idea?.id) return NextResponse.json({ error: 'A központi videóötlet mentése sikertelen.' }, { status: 500 })

  // A creator_memory.content_lane nem resze a jelenlegi publikus POST
  // szerzodesnek (nincs UI, ami lane-t valasztana) — ezert ez a hivo
  // mindig a lane nelkuli (pending) agat celozza az RPC-ben, byte-pontosan
  // megorizve a korabbi viselkedest. Az UJ alkalmazaskod ezt az
  // upsert_creator_memory() RPC-t hasznalja minden creator_memory
  // INSERT/UPDATE-hez (sajat, tervezett irasi utvonalkent) — a 067 EXPAND
  // fazisban a ket uj, lane-particionalt partial unique index
  // (idx_creator_memory_user_topic_pending / idx_creator_memory_user_topic_lane)
  // a regi globalis (user_id,topic) unique constraint (creator_memory_user_id_topic_key)
  // MELLETT letezik, nem helyette — az a regi alkalmazas
  // .upsert({onConflict:'user_id,topic'}) kompatibilitasa miatt marad meg,
  // es a nyers PostgREST hivas erre a constraintra tovabbra is talal
  // megfelelo unique objektumot 068 (CONTRACT) alkalmazasaig. Ha ez az RPC
  // valaha nem-null contentLane-nel hivodna ugyanarra a temara, amelyre
  // mar letezik lane-es vagy pending sor, a meg jelenlevo regi constraint
  // miatt fail-closed lane_conflict_pending_contract hibat adna — de ez a
  // hivas itt mindig contentLane: null-lal tortenik, tehat ezt nem
  // erintheti (lasd lib/creator-lane/lane-service.ts upsertCreatorMemory()).
  const upsertResult = await upsertCreatorMemory(admin, {
    userId: user.id,
    topic: topic.trim(),
    contentLane: null,
    searchKeyword: search_keyword || null,
    state: state || 'saved',
    opportunityScore: opportunity_score ?? null,
    viralScore: viral_score ?? null,
    platform: platform || 'youtube',
    notes: notes || null,
    auditScore: audit_score !== undefined ? audit_score : null,
    auditId: audit_id || null,
    videoPackageId: video_package_id || null,
    sourceContext: source_context || null,
    qualityStatus: quality_status || null,
  })

  if (!upsertResult.success) {
    console.error('Memory POST error:', upsertResult.error)
    return NextResponse.json({ error: 'A mentés sikertelen. Próbáld újra.' }, { status: 500 })
  }
  const data = upsertResult.row as Record<string, unknown> & { id?: string; video_idea_id?: string | null }

  if (data?.id) {
    const linkResult = await linkVideoIdeaToLegacyRecord(admin, {
      table: 'creator_memory',
      userId: user.id,
      recordId: data.id,
      videoIdeaId: ideaResult.idea.id,
    })
    if (!linkResult.success) {
      console.error('Memory POST video_idea_id link error:', linkResult.error)
      return NextResponse.json({ error: 'A videóötlet-kapcsolat mentése sikertelen.' }, { status: 500 })
    }
    data.video_idea_id = ideaResult.idea.id
  }

  if (data?.id) {
    const eventResult = await logVideoIdeaEvent(admin, {
      userId: user.id,
      videoIdeaId: ideaResult.idea.id,
      eventType: state === 'rejected' ? 'idea_rejected' : 'idea_saved',
      sourceTool: source_context || 'creator_memory',
      payload: { topic: topic.trim(), search_keyword, state: state || 'saved' },
    })
    if (!eventResult.success) return NextResponse.json({ error: 'A memóriaesemény naplózása sikertelen.' }, { status: 500 })
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
    if (!result.success) return NextResponse.json({ error: 'A központi videóötlet állapotának frissítése sikertelen.' }, { status: 500 })
    if (result.previous !== targetStatus) {
      const eventResult = await logVideoIdeaEvent(admin, {
        userId: user.id,
        videoIdeaId: data.video_idea_id,
        eventType: 'state_changed',
        sourceTool: 'creator_memory',
        payload: { from: result.previous, to: targetStatus, memory_state: state },
      })
      if (!eventResult.success) return NextResponse.json({ error: 'Az állapotváltozás naplózása sikertelen.' }, { status: 500 })
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
  if (typeof id !== 'string' || !id) return NextResponse.json({ error: 'Azonosító kötelező' }, { status: 400 })
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('creator_memory')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id')

  if (error) {
    console.error('Memory DELETE error:', error)
    return NextResponse.json({ error: 'A törlés sikertelen. Próbáld újra.' }, { status: 500 })
  }
  if (!data?.length) return NextResponse.json({ error: 'A memóriaelem nem található.' }, { status: 404 })

  return NextResponse.json({ success: true })
}
