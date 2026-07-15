import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, createServerSupabaseClient } from '@/lib/supabase-server'
import { ensureVideoIdea } from '@/lib/video-ideas/video-idea-service'
import type { VideoIdeaWorkflowStatus } from '@/types'
import { isJsonWithinLimit, isOptionalTextWithinLimit, isPlainRecord, isScoreOrNull, topicInputTooLong } from '@/lib/api-input-validation'

const WORKFLOW_STATUSES: VideoIdeaWorkflowStatus[] = [
  'new_idea',
  'validating',
  'validated',
  'ready_to_produce',
  'scheduled',
  'published',
  'audited',
  'rejected',
  'archived',
]

function isWorkflowStatus(value: unknown): value is VideoIdeaWorkflowStatus {
  return typeof value === 'string' && WORKFLOW_STATUSES.includes(value as VideoIdeaWorkflowStatus)
}

export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const admin = createAdminClient()
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const view = searchParams.get('view')
  const defaultMax = view === 'calendar' ? 300 : 100
  const limit = Math.min(Math.max(Number(searchParams.get('limit') || 30), 1), defaultMax)

  let query = admin
    .from('video_ideas')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (status && isWorkflowStatus(status)) {
    query = query.eq('workflow_status', status)
  }

  // A Naptár korabban a "legutobbi 100 frissitett" limitre tamaszkodott, ami
  // egy regi utemezett tetelt eszrevetlenul kizarhatott, ha kozben 100+ ujabb,
  // nem-naptar-relevans Video Idea keletkezett. A view=calendar szerver oldali
  // szures csak a naptar szempontjabol tenylegesen relevans sorokat hozza le.
  if (view === 'calendar') {
    query = query.or('calendar_status.eq.scheduled,workflow_status.eq.ready_to_produce,workflow_status.eq.published')
  }

  const { data, error } = await query
  if (error) {
    console.error('Video ideas GET error:', error)
    return NextResponse.json({ error: 'A Video Idea-k betöltése sikertelen. Próbáld újra.' }, { status: 500 })
  }

  return NextResponse.json({ ideas: data || [] })
}

export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const body = await request.json()
  if (typeof body.topic !== 'string' || !body.topic.trim()) return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })
  if (topicInputTooLong(body.topic)) return NextResponse.json({ error: 'A téma legfeljebb 300 karakter lehet' }, { status: 400 })
  if (![body.viral_score, body.opportunity_score, body.competition_score].every(isScoreOrNull)) return NextResponse.json({ error: 'A score értékeknek 0 és 100 közé kell esniük' }, { status: 400 })
  if (body.metadata !== undefined && (!isPlainRecord(body.metadata) || !isJsonWithinLimit(body.metadata))) return NextResponse.json({ error: 'Érvénytelen vagy túl nagy metadata' }, { status: 400 })
  if (!isOptionalTextWithinLimit(body.short_description, 2000) || !isOptionalTextWithinLimit(body.proof_summary, 5000)) return NextResponse.json({ error: 'Túl hosszú szöveges mező' }, { status: 400 })

  const admin = createAdminClient()
  const result = await ensureVideoIdea(admin, {
    userId: user.id,
    title: body.title || body.topic,
    topic: body.topic,
    shortDescription: body.short_description || null,
    niche: body.niche || null,
    platform: body.platform || 'youtube',
    language: body.language || null,
    market: body.market || body.region || null,
    country: body.country || null,
    currency: body.currency || null,
    timezone: body.timezone || null,
    contentFormat: body.content_format || null,
    keywords: Array.isArray(body.keywords) ? body.keywords : [],
    viralScore: body.viral_score ?? null,
    opportunityScore: body.opportunity_score ?? null,
    competitionScore: body.competition_score ?? null,
    proofSummary: body.proof_summary || null,
    workflowStatus: isWorkflowStatus(body.workflow_status) ? body.workflow_status : 'new_idea',
    paidResultReference: body.paid_result_reference || null,
    // Publikus CRUD-ból nem fogadunk el kliens által választott deduplikációs hash-t.
    inputHash: null,
    metadata: body.metadata || {},
  })

  if (!result.success || !result.idea) {
    return NextResponse.json({ error: result.error || 'A Video Idea mentése nem sikerült' }, { status: 500 })
  }

  return NextResponse.json({ idea: result.idea })
}

export async function PATCH(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const { id, workflow_status, calendar_status, publish_status, scheduled_publish_date, calendar_notes } = await request.json()
  if (!id) return NextResponse.json({ error: 'Video Idea azonosító kötelező' }, { status: 400 })
  if (workflow_status && !isWorkflowStatus(workflow_status)) {
    return NextResponse.json({ error: 'Érvénytelen workflow státusz' }, { status: 400 })
  }
  if (!isOptionalTextWithinLimit(calendar_status, 50) || !isOptionalTextWithinLimit(publish_status, 50) || !isOptionalTextWithinLimit(calendar_notes, 5000)) return NextResponse.json({ error: 'Érvénytelen vagy túl hosszú naptármező' }, { status: 400 })
  if (scheduled_publish_date !== undefined && scheduled_publish_date !== null && (typeof scheduled_publish_date !== 'string' || !Number.isFinite(new Date(scheduled_publish_date).getTime()))) return NextResponse.json({ error: 'Érvénytelen publikálási dátum' }, { status: 400 })

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (workflow_status) update.workflow_status = workflow_status
  if (calendar_status !== undefined) update.calendar_status = calendar_status
  if (publish_status !== undefined) update.publish_status = publish_status
  if (scheduled_publish_date !== undefined) update.scheduled_publish_date = scheduled_publish_date
  if (calendar_notes !== undefined) update.calendar_notes = calendar_notes

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('video_ideas')
    .update(update)
    .eq('id', id)
    .eq('user_id', user.id)
    .select('*')
    .single()

  if (error) {
    console.error('Video ideas PATCH error:', error)
    return NextResponse.json({ error: 'A Video Idea frissítése sikertelen. Próbáld újra.' }, { status: 500 })
  }
  return NextResponse.json({ idea: data })
}
