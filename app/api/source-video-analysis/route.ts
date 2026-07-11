import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'

export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const body = await request.json()
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('source_video_analysis')
    .insert({
      user_id: user.id,
      source_video_id: body.source_video_id,
      source_video_url: body.source_video_url,
      source_video_title: body.source_video_title || null,
      source_channel: body.source_channel || null,
      source_context: body.source_context || 'script_extractor',
      transcript_available: body.transcript_available || false,
      transcript_source: body.transcript_source || 'metadata',
      extracted_structure: body.extracted_structure || {},
      verified_fact_block: body.verified_fact_block || null,
      sources: body.sources || [],
      generated_video_package_id: body.generated_video_package_id || null,
    })
    .select('id')
    .single()

  if (error) {
    console.error('Source video analysis save error:', error)
    return NextResponse.json({ error: 'A mentés sikertelen. Próbáld újra.' }, { status: 500 })
  }

  return NextResponse.json({ id: data.id })
}
