import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'

const DECISION_LABELS: Record<string, string> = {
  continue: '▶ Folytasd ezt a témát',
  rehook: '🎣 Csak a hookot javítsd',
  replatform: '📱 Tedd át más platformra',
  reupload: '🔄 Töltsd fel újra javítva',
  remix: '🔀 Remixeld',
  abandon: '❌ Engedd el ezt a témát',
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('video_audits')
    .select('*')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .single()

  if (error || !data) return NextResponse.json({ error: 'Audit nem található' }, { status: 404 })

  const audit = {
    audit_id: data.id,
    platform: data.platform,
    video_title: data.video_title,
    thumbnail_url: data.input_data?.thumbnail_url || null,
    overall_score: data.overall_score,
    confidence: data.confidence,
    final_scores: data.final_scores,
    backend_scores: data.backend_scores,
    diagnosis: data.diagnosis,
    main_problem: data.recommendations?.main_problem || '',
    top_3_errors: data.recommendations?.top_3_errors || [],
    recommendations: data.recommendations,
    decision: data.decision,
    decision_label: DECISION_LABELS[data.decision] || data.decision,
    decision_reason: '',
    _credits_remaining: null,
  }

  return NextResponse.json({ audit })
}
