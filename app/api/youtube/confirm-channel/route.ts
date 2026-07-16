import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/credits'
import { syncChannelProfileFromPublic } from '@/lib/channel-profile-sync'
import { createAdminClient } from '@/lib/supabase-server'

const VALID_MODES = ['primary_profile', 'stats_only', 'niche_discovery', 'manual']

// POST — a /api/youtube/resolve-channel elonezet userre torteno megerositese:
// tenylegesen elmenti a csatorna kijelzo-adatait + a valasztott
// channel_usage_mode-ot a profiles tablaba.
export async function POST(request: NextRequest) {
  try {
    const { channel_input, channel_usage_mode } = await request.json()
    if (!channel_input || typeof channel_input !== 'string' || !channel_input.trim()) {
      return NextResponse.json({ error: 'Csatorna megadása kötelező.' }, { status: 400 })
    }
    if (!VALID_MODES.includes(channel_usage_mode)) {
      return NextResponse.json({ error: 'Érvénytelen csatorna-használati mód.' }, { status: 400 })
    }

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const result = await syncChannelProfileFromPublic(userId, channel_input.trim())
    if ('error' in result) {
      const status = result.error === 'channel_not_found' ? 404 : 500
      return NextResponse.json({ error: result.error, message: 'A csatorna elmentése sikertelen.' }, { status })
    }

    const admin = createAdminClient()
    const { data: savedMode, error: modeSaveError } = await admin.from('profiles').update({ channel_usage_mode, onboarding_completed: true }).eq('user_id', userId).select('user_id').single()
    if (modeSaveError || !savedMode) return NextResponse.json({ error: 'save_failed', message: 'A csatorna használati módjának mentése sikertelen.' }, { status: 500 })

    return NextResponse.json({ snapshot: result.snapshot, connection_type: result.connectionType })
  } catch (error) {
    console.error('[YouTube confirm-channel] error:', error)
    return NextResponse.json({ error: 'A csatorna elmentése sikertelen. Próbáld újra.' }, { status: 500 })
  }
}
