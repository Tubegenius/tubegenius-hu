import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { isJsonWithinLimit } from '@/lib/api-input-validation'

export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

  const body = await request.json()
  const admin = createAdminClient()
  const sourceUrlMatchesId = typeof body.source_video_url === 'string' && (body.source_video_url.includes(`v=${body.source_video_id}`) || body.source_video_url.includes(`youtu.be/${body.source_video_id}`) || body.source_video_url.includes(`/shorts/${body.source_video_id}`))
  if (typeof body.source_video_id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(body.source_video_id) || typeof body.source_video_url !== 'string' || body.source_video_url.length > 500 || !sourceUrlMatchesId || typeof body.generated_video_package_id !== 'string' || !isJsonWithinLimit(body.extracted_structure || {}, 50_000) || !isJsonWithinLimit(body.sources || [], 30_000)) {
    return NextResponse.json({ error: 'Hiányzó vagy hibás forrásvideó-adatok.' }, { status: 400 })
  }
  const { data: ownedPackage } = await admin
    .from('video_packages')
    .select('id')
    .eq('id', body.generated_video_package_id)
    .eq('user_id', user.id)
    .single()
  if (!ownedPackage) return NextResponse.json({ error: 'A kapcsolt videócsomag nem található.' }, { status: 404 })

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
