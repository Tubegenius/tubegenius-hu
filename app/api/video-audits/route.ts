import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'

export async function GET() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('video_audits')
    .select('id, platform, video_title, overall_score, confidence, decision, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    console.error('Video audits GET error:', error)
    return NextResponse.json({ error: 'Az auditok betöltése sikertelen. Próbáld újra.' }, { status: 500 })
  }

  // decision_label számítása a decision alapján
  const DECISION_LABELS: Record<string, string> = {
    continue: '▶ Folytasd ezt a témát',
    rehook: '🎣 Csak a hookot javítsd',
    replatform: '📱 Tedd át más platformra',
    reupload: '🔄 Töltsd fel újra javítva',
    remix: '🔀 Remixeld',
    abandon: '❌ Engedd el ezt a témát',
  }

  const audits = (data || []).map(a => ({
    ...a,
    decision_label: DECISION_LABELS[a.decision] || a.decision,
  }))

  return NextResponse.json({ audits })
}
