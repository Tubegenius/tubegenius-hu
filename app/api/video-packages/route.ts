import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { promoteToTrackedCandidate } from '@/lib/trend-tracking'
import { ensureVideoIdea, linkVideoIdeaToLegacyRecord, logVideoIdeaEvent, markVideoIdeaReadyToProduce } from '@/lib/video-ideas/video-idea-service'
import { getPaidResultById } from '@/lib/paid-results/paid-results-service'
import { isJsonWithinLimit, isPlainRecord } from '@/lib/api-input-validation'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// GET: lista vagy egy konkrét csomag (?id=...)
export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const admin = createAdminClient()
  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')

  if (id) {
    const { data, error } = await admin
      .from('video_packages')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .single()

    if (error || !data) return NextResponse.json({ error: 'Csomag nem található' }, { status: 404 })
    return NextResponse.json({ package: data })
  }

  // Lista — legutóbbiak elöl
  const { data, error } = await admin
    .from('video_packages')
    .select('id, topic, search_keyword, platform, video_length, narration_style, title_variations, created_at, updated_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    console.error('Video packages GET error:', error)
    return NextResponse.json({ error: 'A csomagok betöltése sikertelen. Próbáld újra.' }, { status: 500 })
  }
  return NextResponse.json({ packages: data })
}

// POST: csomag mentése (a Video Package generálás eredménye után)
export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const requestBody: unknown = await request.json().catch(() => null)
  if (!isPlainRecord(requestBody) || !isJsonWithinLimit(requestBody) || typeof requestBody.paid_result_id !== 'string' || !UUID_PATTERN.test(requestBody.paid_result_id)) return NextResponse.json({ error: 'Érvényes fizetett videócsomag-eredmény szükséges.' }, { status: 400 })
  const paidResult = await getPaidResultById(user.id, requestBody.paid_result_id)
  if (!paidResult || paidResult.tool_type !== 'video_package' || !paidResult.result_json || typeof paidResult.result_json !== 'object') {
    return NextResponse.json({ error: 'A fizetett videócsomag-eredmény nem található.' }, { status: 404 })
  }
  const body = paidResult.result_json as Record<string, any>
  if (typeof body.topic !== 'string' || !body.topic.trim() || typeof body.hook !== 'string' || typeof body.narration !== 'string') {
    return NextResponse.json({ error: 'A mentett videócsomag szerkezete hibás.' }, { status: 422 })
  }
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('video_packages')
    .insert({
      user_id: user.id,
      topic: body.topic,
      search_keyword: body.search_keyword || null,
      platform: body.platform,
      video_length: body.video_length,
      narration_style: body.narration_style || null,
      intensity: body.intensity || null,
      goal: body.goal || null,
      verified_fact_block: body.verified_fact_block || null,
      sources: body.sources || [],
      verified_fact_block_json: body.verified_fact_block_json || null,
      forbidden_claims: body.forbidden_claims || [],
      sources_used: body.sources_used || [],
      quality_status: body.quality_status || null,
      content_type: body.content_type || null,
      strict_fact_mode: body.strict_fact_mode || false,
      fact_strictness_level: body.fact_strictness_level || null,
      intensity_original: body.intensity_original || null,
      intensity_final: body.intensity_final || null,
      hook: body.hook,
      narration: body.narration,
      scene_structure: body.scene_structure || [],
      broll_ideas: body.broll_ideas || [],
      timestamps: body.timestamps || [],
      title_variations: body.title_variations || [],
      thumbnail_texts: body.thumbnail_texts || [],
      caption: body.caption || null,
      description: body.description || null,
      hashtags: body.hashtags || {},
      upload_times: body.upload_times || {},
      cta: body.cta,
      estimated_word_count: body.estimated_word_count || null,
      estimated_duration: body.estimated_duration || null,
    })
    .select('id')
    .single()

  if (error) {
    console.error('Video package save error:', error)
    return NextResponse.json({ error: 'A csomag mentése sikertelen. Próbáld újra.' }, { status: 500 })
  }

  const ideaResult = await ensureVideoIdea(admin, {
    userId: user.id,
    title: body.topic,
    topic: body.topic,
    shortDescription: body.hook || null,
    platform: body.platform || 'youtube',
    language: body.language || null,
    market: body.market || body.region || null,
    contentFormat: body.video_length || null,
    keywords: body.search_keyword ? [body.search_keyword] : [],
    proofSummary: body.verified_fact_block || null,
    workflowStatus: 'validating',
    metadata: {
      source_tool: 'video_package',
      search_keyword: body.search_keyword || null,
      quality_status: body.quality_status || null,
      fact_strictness_level: body.fact_strictness_level || null,
    },
  })

  if (!ideaResult.success || !ideaResult.idea?.id) {
    await admin.from('video_packages').delete().eq('id', data.id).eq('user_id', user.id)
    return NextResponse.json({ error: 'A videócsomag workflow-kapcsolata nem menthető.' }, { status: 500 })
  }
  if (ideaResult.idea?.id) {
    const linkResult = await linkVideoIdeaToLegacyRecord(admin, {
      table: 'video_packages',
      userId: user.id,
      recordId: data.id,
      videoIdeaId: ideaResult.idea.id,
    })
    if (!linkResult.success) {
      await admin.from('video_packages').delete().eq('id', data.id).eq('user_id', user.id)
      return NextResponse.json({ error: 'A videócsomag workflow-kapcsolata nem menthető.' }, { status: 500 })
    }
    const readyResult = await markVideoIdeaReadyToProduce(admin, {
      userId: user.id,
      videoIdeaId: ideaResult.idea.id,
      videoPackageId: data.id,
    })
    if (!readyResult.success) {
      await admin.from('video_packages').delete().eq('id', data.id).eq('user_id', user.id)
      return NextResponse.json({ error: 'A videócsomag workflow-kapcsolata nem menthető.' }, { status: 500 })
    }
    await logVideoIdeaEvent(admin, {
      userId: user.id,
      videoIdeaId: ideaResult.idea.id,
      eventType: 'video_package_created',
      sourceTool: 'video_package',
      payload: { video_package_id: data.id, topic: body.topic },
    })
  }

  // Amiből videócsomag készült, azt limitáltan trackeljük (háttérfrissítés célra) —
  // hiba esetén nem törheti el a mentést.
  await promoteToTrackedCandidate({
    userId: user.id,
    candidateTopic: body.topic,
    region: body.region ?? null,
    force: true,
  }).catch(() => {})

  return NextResponse.json({ id: data.id })
}

// DELETE: csomag törlése
export async function DELETE(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const body: unknown = await request.json().catch(() => null)
  if (!isPlainRecord(body) || typeof body.id !== 'string' || !UUID_PATTERN.test(body.id)) return NextResponse.json({ error: 'Érvénytelen csomagazonosító.' }, { status: 400 })
  const { id } = body
  const admin = createAdminClient()

  const { data: deleted, error } = await admin
    .from('video_packages')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id')

  if (error) {
    console.error('Video package DELETE error:', error)
    return NextResponse.json({ error: 'A törlés sikertelen. Próbáld újra.' }, { status: 500 })
  }
  if (!deleted || deleted.length === 0) return NextResponse.json({ error: 'Csomag nem található' }, { status: 404 })
  return NextResponse.json({ success: true })
}
