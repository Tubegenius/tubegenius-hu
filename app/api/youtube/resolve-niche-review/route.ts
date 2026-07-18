import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/credits'
import { createAdminClient } from '@/lib/supabase-server'
import { candidateMatchesActiveChannel } from '@/lib/channel-scope'
import type { NicheCandidate } from '@/types'

const VALID_ACTIONS = ['keep_current', 'select_candidate'] as const

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null)
    if (!body || !VALID_ACTIONS.includes(body.action)) {
      return NextResponse.json({ error: 'Ervenytelen niche-dontes.' }, { status: 400 })
    }

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('active_channel_id, detected_niche_candidates')
      .eq('user_id', userId)
      .single()
    if (profileError || !profile) return NextResponse.json({ error: 'A profil betoltese sikertelen.' }, { status: 500 })

    const activeChannelId = profile.active_channel_id as string | null
    if (!activeChannelId) return NextResponse.json({ error: 'Nincs aktiv YouTube-csatorna.' }, { status: 400 })

    if (body.action === 'keep_current') {
      const { error } = await admin.from('profiles').update({
        niche_validated_for_channel_id: activeChannelId,
        niche_needs_review: false,
      }).eq('user_id', userId)
      if (error) return NextResponse.json({ error: 'A niche-dontes mentese sikertelen.' }, { status: 500 })
      return NextResponse.json({ success: true, action: 'keep_current' })
    }

    const candidate = body.candidate as Partial<NicheCandidate> | null
    if (!candidate
      || typeof candidate.main_category !== 'string'
      || typeof candidate.specific_focus !== 'string'
      || !candidate.main_category.trim()
      || !candidate.specific_focus.trim()
      || !candidateMatchesActiveChannel(candidate, activeChannelId)) {
      return NextResponse.json({ error: 'A niche-jelolt nem az aktiv csatornahoz tartozik.' }, { status: 400 })
    }

    const storedCandidates = Array.isArray(profile.detected_niche_candidates)
      ? profile.detected_niche_candidates as NicheCandidate[]
      : []
    const storedCandidate = storedCandidates.find(item =>
      candidateMatchesActiveChannel(item, activeChannelId)
      && item.main_category === candidate.main_category
      && item.specific_focus === candidate.specific_focus
    )
    if (!storedCandidate) {
      return NextResponse.json({ error: 'A niche-jelolt nem talalhato az aktiv csatorna javaslatai kozott.' }, { status: 400 })
    }

    const { error } = await admin.from('profiles').update({
      niche: storedCandidate.specific_focus,
      main_category: storedCandidate.main_category,
      specific_focus: storedCandidate.specific_focus,
      niche_validated_for_channel_id: activeChannelId,
      niche_needs_review: false,
    }).eq('user_id', userId)
    if (error) return NextResponse.json({ error: 'A niche-dontes mentese sikertelen.' }, { status: 500 })

    return NextResponse.json({ success: true, action: 'select_candidate' })
  } catch (error) {
    console.error('[YouTube resolve-niche-review] error:', error)
    return NextResponse.json({ error: 'A niche-dontes mentese sikertelen.' }, { status: 500 })
  }
}
