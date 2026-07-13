import { NextRequest, NextResponse } from 'next/server'
import { getUserId, hasEnoughCredits, chargeFeature, CREDIT_COSTS } from '@/lib/credits'
import { createAdminClient } from '@/lib/supabase-server'
import { discoverChannelNiches } from '@/lib/channel-niche-discovery'
import { acquireRequestLock, releaseRequestLock, REQUEST_IN_PROGRESS_ERROR } from '@/lib/request-lock'
import type { NicheCandidate } from '@/types'

// POST — csatorna alapú niche-javaslatok. Az ELSŐ futás userenkénti +
// active_channel_id-nkénti egyszer INGYENES (onboarding része), a
// korábbi eredmény cache-elve van a profiles.detected_niche_candidates
// mezőben — page refresh/vissza-navigálás nem tölt le újra és nem von
// kreditet. Explicit force_refresh = 1 kredit, in_flight lockkal védve a
// dupla-levonás ellen (ugyanaz a minta, mint a többi fizetős route-nál).
export async function POST(request: NextRequest) {
  try {
    const { force_refresh } = await request.json().catch(() => ({}))

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: profile } = await admin
      .from('profiles')
      .select('active_channel_id, youtube_channel_id, youtube_channel_url, detected_niche_candidates, niche_confidence')
      .eq('user_id', userId)
      .single()

    const channelId = profile?.active_channel_id || profile?.youtube_channel_id
    const channelInput = profile?.youtube_channel_url || channelId
    if (!channelId || !channelInput) {
      return NextResponse.json({ error: 'no_channel', message: 'Előbb kösd össze vagy add meg a YouTube csatornádat.' }, { status: 400 })
    }

    const existingCandidates = profile?.detected_niche_candidates as NicheCandidate[] | null
    if (!force_refresh && existingCandidates && existingCandidates.length > 0) {
      return NextResponse.json({ candidates: existingCandidates, niche_confidence: profile?.niche_confidence ?? null, cached: true })
    }

    // Igazi elso futas (nincs meg cache-elt eredmeny) — ingyenes, nincs lock/kredit.
    if (!force_refresh) {
      const result = await discoverChannelNiches({ channelInput })
      if ('error' in result) {
        return NextResponse.json({ error: result.error, message: 'Nem sikerült a csatorna videói alapján niche-t javasolni.' }, { status: 422 })
      }
      await admin.from('profiles').update({
        detected_niche_candidates: result.candidates,
        niche_confidence: result.candidates[0]?.confidence ?? null,
      }).eq('user_id', userId)
      return NextResponse.json({ candidates: result.candidates, niche_confidence: result.candidates[0]?.confidence ?? null, cached: false, charged: false })
    }

    // Explicit "Újraelemzés" — 1 kredit, dupla-levonás elleni lock (Beta
    // Hardening Test fix #1 mintája, lib/request-lock.ts).
    const lock = await acquireRequestLock({ userId, toolType: 'niche_discovery_refresh', inputHash: channelId })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
      const enoughCredits = await hasEnoughCredits(userId, 'niche_discovery_refresh')
      if (!enoughCredits) {
        return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.niche_discovery_refresh} kredit szükséges.` }, { status: 402 })
      }

      const result = await discoverChannelNiches({ channelInput })
      if ('error' in result) {
        return NextResponse.json({ error: result.error, message: 'Nem sikerült a csatorna videói alapján niche-t javasolni.' }, { status: 422 })
      }

      const charge = await chargeFeature(userId, 'niche_discovery_refresh')
      if (!charge.success) {
        return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
      }

      await admin.from('profiles').update({
        detected_niche_candidates: result.candidates,
        niche_confidence: result.candidates[0]?.confidence ?? null,
      }).eq('user_id', userId)

      return NextResponse.json({
        candidates: result.candidates,
        niche_confidence: result.candidates[0]?.confidence ?? null,
        cached: false,
        charged: true,
        _credits_remaining: charge.new_balance,
      })
    } finally {
      await releaseRequestLock(lock.lockId)
    }
  } catch (error) {
    console.error('[YouTube discover-niche] error:', error)
    return NextResponse.json({ error: 'A niche-felismerés sikertelen. Próbáld újra.' }, { status: 500 })
  }
}
