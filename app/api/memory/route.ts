import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { promoteToTrackedCandidate } from '@/lib/trend-tracking'
import { ensureVideoIdea, linkVideoIdeaToLegacyRecord, logVideoIdeaEvent } from '@/lib/video-ideas/video-idea-service'
import type { TopicState } from '@/types'

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

  let query = admin
    .from('creator_memory')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })

  if (state) {
    query = query.eq('state', state)
  }

  const { data, error } = await query

  if (error) {
    console.error('Memory GET error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ items: data })
}

// POST: tema mentese/frissitese
export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  }

  const { topic, search_keyword, state, opportunity_score, viral_score, audit_score, audit_id, video_package_id, platform, notes, source_context, quality_status } = await request.json()

  if (!topic) {
    return NextResponse.json({ error: "Tema kotelezo" }, { status: 400 })
  }
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
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const ideaResult = await ensureVideoIdea(admin, {
    userId: user.id,
    title: topic,
    topic,
    platform: platform || 'youtube',
    opportunityScore: opportunity_score ?? null,
    viralScore: viral_score ?? null,
    workflowStatus: state === 'rejected' ? 'rejected' : state === 'completed' ? 'validated' : 'new_idea',
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
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('creator_memory')
    .update({ state, notes, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
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
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
