import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'

export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  }

  const { topic, feedback_type, reason, opportunity_score, niche_cluster, source_videos } = await request.json()

  if (!topic || !feedback_type) {
    return NextResponse.json({ error: 'topic és feedback_type kötelező' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { error } = await admin.from('topic_feedback').insert({
    user_id: user.id,
    topic,
    feedback_type,
    reason: reason || null,
    opportunity_score: opportunity_score ?? null,
    niche_cluster: niche_cluster || null,
    source_videos: source_videos || [],
  })

  if (error) {
    console.error('Feedback insert error:', error)
    return NextResponse.json({ error: 'A visszajelzés mentése sikertelen. Próbáld újra.' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
