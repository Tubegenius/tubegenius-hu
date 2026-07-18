import { NextRequest, NextResponse } from 'next/server'
import { getUserId, checkPaidFeatureAccess, chargeFeature, CREDIT_COSTS, refundCreditsAfterPersistenceFailure } from '@/lib/credits'
import { dailySoftLimitError } from '@/lib/daily-soft-limit'
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
    if (force_refresh !== undefined && typeof force_refresh !== 'boolean') {
      return NextResponse.json({ error: 'Hibás frissítési beállítás.' }, { status: 400 })
    }

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const admin = createAdminClient()
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('active_channel_id, youtube_channel_id, youtube_channel_url, detected_niche_candidates, niche_confidence')
      .eq('user_id', userId)
      .single()
    if (profileError || !profile) {
      console.error('[YouTube discover-niche] profile load failed:', profileError)
      return NextResponse.json({ error: 'A profil betöltése sikertelen.' }, { status: 500 })
    }

    const channelId = profile?.active_channel_id || profile?.youtube_channel_id
    const channelInput = channelId
    if (!channelId || !channelInput) {
      return NextResponse.json({ error: 'no_channel', message: 'Előbb kösd össze vagy add meg a YouTube csatornádat.' }, { status: 400 })
    }

    const existingCandidates = profile?.detected_niche_candidates as NicheCandidate[] | null
    const cacheMatchesActiveChannel = existingCandidates?.every(candidate => candidate.source_channel_id === channelId) === true
    if (!force_refresh && existingCandidates && existingCandidates.length > 0 && cacheMatchesActiveChannel) {
      return NextResponse.json({ candidates: existingCandidates, niche_confidence: profile?.niche_confidence ?? null, cached: true })
    }

    // Igazi első futás: ingyenes, de lock védi a párhuzamos YouTube/AI-hívástól.
    if (!force_refresh) {
      const initialLock = await acquireRequestLock({ userId, toolType: 'niche_discovery_initial', inputHash: channelId })
      if (!initialLock.acquired) return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
      try {
        const result = await discoverChannelNiches({ channelInput })
        if ('error' in result) {
          return NextResponse.json({ error: result.error, message: 'Nem sikerült a csatorna videói alapján niche-t javasolni.' }, { status: 422 })
        }
        const { data: currentProfile } = await admin.from('profiles').select('active_channel_id').eq('user_id', userId).single()
        if (currentProfile?.active_channel_id !== channelId) {
          return NextResponse.json({ error: 'channel_changed', message: 'A csatorna megvaltozott az elemzes kozben. Inditsd ujra.' }, { status: 409 })
        }
        const { data: savedProfile, error: saveError } = await admin.from('profiles').update({
          detected_niche_candidates: result.candidates,
          niche_confidence: result.candidates[0].confidence,
        }).eq('user_id', userId).select('user_id').single()
        if (saveError || !savedProfile) return NextResponse.json({ error: 'A niche-javaslatok mentése sikertelen.' }, { status: 500 })
        return NextResponse.json({ candidates: result.candidates, niche_confidence: result.candidates[0].confidence, cached: false, charged: false })
      } finally {
        await releaseRequestLock(initialLock.lockId)
      }
    }

    // Explicit "Újraelemzés" — 1 kredit, dupla-levonás elleni lock (Beta
    // Hardening Test fix #1 mintája, lib/request-lock.ts).
    const lock = await acquireRequestLock({ userId, toolType: 'niche_discovery_refresh', inputHash: channelId })
    if (!lock.acquired) {
      return NextResponse.json({ error: REQUEST_IN_PROGRESS_ERROR }, { status: 409 })
    }

    try {
      const access = await checkPaidFeatureAccess(userId, 'niche_discovery_refresh', request.headers.get('x-daily-soft-limit-override') === 'true')
      if (access.reason === 'daily_soft_limit' && access.dailyLimit) return NextResponse.json(dailySoftLimitError(access.dailyLimit), { status: 429 })
      if (!access.allowed) {
        return NextResponse.json({ error: `Nincs elég kredited. Ehhez ${CREDIT_COSTS.niche_discovery_refresh} kredit szükséges.` }, { status: 402 })
      }

      const result = await discoverChannelNiches({ channelInput })
      if ('error' in result) {
        return NextResponse.json({ error: result.error, message: 'Nem sikerült a csatorna videói alapján niche-t javasolni.' }, { status: 422 })
      }

      const { data: currentProfile } = await admin.from('profiles').select('active_channel_id').eq('user_id', userId).single()
      if (currentProfile?.active_channel_id !== channelId) {
        return NextResponse.json({ error: 'channel_changed', message: 'A csatorna megvaltozott az elemzes kozben. Inditsd ujra.' }, { status: 409 })
      }

      const charge = await chargeFeature(userId, 'niche_discovery_refresh')
      if (!charge.success) {
        return NextResponse.json({ error: charge.error || 'Nincs elég kredited ehhez a művelethez.' }, { status: 402 })
      }

      const { data: savedProfile, error: saveError } = await admin.from('profiles').update({
        detected_niche_candidates: result.candidates,
        niche_confidence: result.candidates[0].confidence,
      }).eq('user_id', userId).select('user_id').single()
      if (saveError || !savedProfile) {
        const refund = await refundCreditsAfterPersistenceFailure(userId, 'niche_discovery_refresh', CREDIT_COSTS.niche_discovery_refresh, { reason: 'profile_save_failed' }, charge.credit_transaction_id)
        return NextResponse.json({ error: refund.success ? 'A mentés sikertelen volt, a kreditet visszaadtuk.' : 'A mentés és a kredit-visszatérítés sikertelen. Az esetet naplóztuk.' }, { status: 500 })
      }

      return NextResponse.json({
        candidates: result.candidates,
        niche_confidence: result.candidates[0].confidence,
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
