import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// Csak ezek a mezok irhatok a klienstol jovo raw JSON body-bol — a
// channel_usage_mode/onboarding bovites miatt szelesedett a route felulete,
// ez a vedelmi halo. A service-role-only szinkron/discovery mezok
// (detected_niche_candidates, niche_confidence, active_channel_id,
// channel_connection_type, channel_synced_at, last_channel_audit_at,
// youtube_channel_id, channel_name, channel_avatar_url, total_view_count,
// video_count, channel_published_at) SZANDEKOSAN nincsenek a listan — azokat
// kizarolag lib/channel-profile-sync.ts irja, sosem kozvetlen kliens JSON.
const ALLOWED_PROFILE_FIELDS = [
  'channel_name', 'platform', 'language', 'niche', 'main_category', 'specific_focus',
  'audience', 'avoid_topics', 'video_length', 'creator_level', 'region', 'subscriber_count',
  'narration_style', 'custom_prompt', 'channel_usage_mode', 'selected_main_niche',
] as const

export async function POST(request: NextRequest) {
  try {
    const cookieStore = cookies()
    
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll() {},
        },
      }
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    
    if (authError) {
      console.error('Auth error:', authError)
      return NextResponse.json({ error: 'Auth hiba: ' + authError.message }, { status: 401 })
    }
    
    if (!user) {
      return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
    }

    const body = await request.json()
    console.log('Updating profile for user:', user.id)

    const updatePayload: Record<string, unknown> = {}
    for (const field of ALLOWED_PROFILE_FIELDS) {
      if (field in body) updatePayload[field] = body[field]
    }

    const { error } = await supabase
      .from('profiles')
      .update({ ...updatePayload, onboarding_completed: true })
      .eq('user_id', user.id)

    if (error) {
      console.error('Update error:', error)
      return NextResponse.json({ error: 'A profil frissítése sikertelen. Próbáld újra.' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Unexpected error:', e)
    return NextResponse.json({ error: 'Váratlan hiba' }, { status: 500 })
  }
}