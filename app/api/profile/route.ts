import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// Only explicit creator-profile fields are accepted from client JSON. Channel
// identity, discovery cache and review state remain service-role controlled.
const ALLOWED_PROFILE_FIELDS = [
  'platform', 'language', 'niche', 'main_category', 'specific_focus',
  'audience', 'avoid_topics', 'video_length', 'creator_level', 'region',
  'narration_style', 'custom_prompt', 'channel_usage_mode', 'selected_main_niche',
] as const

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll() {},
        },
      },
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError) {
      console.error('Auth error:', authError)
      return NextResponse.json({ error: 'A munkamenet ellenőrzése sikertelen.' }, { status: 401 })
    }
    if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const body = await request.json()
    const updatePayload: Record<string, unknown> = {}
    for (const field of ALLOWED_PROFILE_FIELDS) {
      if (field in body) updatePayload[field] = body[field]
    }

    // A normal profile save never derives or replaces the niche from a channel.
    // Channel candidates are applied only by the user's explicit decision in
    // POST /api/youtube/resolve-niche-review.
    const { error } = await supabase
      .from('profiles')
      .update({ ...updatePayload, onboarding_completed: true })
      .eq('user_id', user.id)

    if (error) {
      console.error('Update error:', error)
      return NextResponse.json({ error: 'A profil frissítése sikertelen. Próbáld újra.' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Unexpected profile update error:', error)
    return NextResponse.json({ error: 'Váratlan hiba' }, { status: 500 })
  }
}
