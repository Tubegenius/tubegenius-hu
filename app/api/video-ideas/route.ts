import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, createServerSupabaseClient } from '@/lib/supabase-server'
import { ensureVideoIdea } from '@/lib/video-ideas/video-idea-service'
import type { VideoIdeaWorkflowStatus } from '@/types'

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
  const limit = Math.min(Math.max(Number(searchParams.get('limit') || 30), 1), 100)

  let query = admin
    .from('video_ideas')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (status && isWorkflowStatus(status)) {
    query = query.eq('workflow_status', status)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ideas: data || [] })
}

export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const body = await request.json()
  if (!body.topic) return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })

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
    inputHash: body.input_hash || null,
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

  const { id, workflow_status, calendar_status, publish_status } = await request.json()
  if (!id) return NextResponse.json({ error: 'Video Idea azonosító kötelező' }, { status: 400 })
  if (workflow_status && !isWorkflowStatus(workflow_status)) {
    return NextResponse.json({ error: 'Érvénytelen workflow státusz' }, { status: 400 })
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (workflow_status) update.workflow_status = workflow_status
  if (calendar_status !== undefined) update.calendar_status = calendar_status
  if (publish_status !== undefined) update.publish_status = publish_status

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('video_ideas')
    .update(update)
    .eq('id', id)
    .eq('user_id', user.id)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ idea: data })
}
