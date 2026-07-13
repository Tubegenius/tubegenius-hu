import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { discoverChannelNiches } from '@/lib/channel-niche-discovery'
import type { NicheCandidate } from '@/types'

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

    // "primary_profile" mod eseten a csatorna legyen a niche forrasa. A
    // profil oldal fo mentes-gombja MINDIG kuldi a main_category/specific_focus
    // mezoket (kotelezo urlap-mezok), tehat a jelenlet/hianyuk NEM hasznalhato
    // jelzeskent — ehelyett azt nezzuk, hogy a csatorna niche-e MEG SOSEM lett
    // levezetve (detected_niche_candidates ures). Ez eppen a megfigyelt hibat
    // fedi le: a user beallitotta "primary_profile"-ra a modot, de a mezok
    // sosem frissultek a regi, kezzel beirt niche-rol (pl. "Ai, es orvostudomany")
    // a csatorna tenyleges tartalmara. Csak EGYSZER fut le csatornankent — utana
    // detected_niche_candidates mar nem ures, a kesobbi kezi szerkesztesek
    // megmaradnak (a "user szerkesztheti / feluliraja" szabaly szerint).
    const effectiveMode = (updatePayload.channel_usage_mode as string | undefined) ?? undefined
    if (effectiveMode === 'primary_profile') {
      const { data: currentProfile } = await supabase
        .from('profiles')
        .select('channel_usage_mode, youtube_channel_id, youtube_channel_url, detected_niche_candidates')
        .eq('user_id', user.id)
        .single()

      const channelInput = currentProfile?.youtube_channel_url || currentProfile?.youtube_channel_id
      const alreadyDerived = Array.isArray(currentProfile?.detected_niche_candidates) && currentProfile.detected_niche_candidates.length > 0

      if (channelInput && !alreadyDerived) {
        try {
          const result = await discoverChannelNiches({ channelInput })
          if (!('error' in result) && result.candidates.length > 0) {
            const top: NicheCandidate = result.candidates[0]
            updatePayload.main_category = top.main_category
            updatePayload.specific_focus = top.specific_focus
            updatePayload.niche = top.specific_focus
            updatePayload.selected_main_niche = top.specific_focus
            updatePayload.detected_niche_candidates = result.candidates
            updatePayload.niche_confidence = top.confidence
          }
        } catch (discoverError) {
          // Nem blokkolja a profil mentest — ha a csatorna-alapu felismeres
          // sikertelen (pl. nincs elerheto videoja), a user meglevo kezi
          // niche-e marad ervenyben, csak nem all elo automatikus javaslat.
          console.error('[Profile] primary_profile niche-felismeres sikertelen:', discoverError)
        }
      }
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