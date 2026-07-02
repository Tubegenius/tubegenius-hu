import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { promoteToTrackedCandidate } from '@/lib/trend-tracking'

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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ packages: data })
}

// POST: csomag mentése (a Video Package generálás eredménye után)
export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const body = await request.json()
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
    return NextResponse.json({ error: error.message }, { status: 500 })
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

  const { id } = await request.json()
  const admin = createAdminClient()

  const { error } = await admin
    .from('video_packages')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
