import { createHash, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { runSignalCollector } from '@/lib/emerging-signal/collection-orchestrator'
import { createYouTubeCollectorProviders } from '@/lib/emerging-signal/youtube-collector-provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function authorized(request: NextRequest, secret: string): boolean {
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest()
  const supplied = createHash('sha256').update(request.headers.get('authorization') ?? '').digest()
  return timingSafeEqual(expected, supplied)
}

// GET /api/cron/collect-signals
// Premium Emerging Signal collector. The database kill switch is checked by
// the orchestrator before a run is claimed or a provider can be called.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: 'Cron not configured' }, { status: 503 })
  }
  if (!authorized(request, cronSecret)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const youtubeApiKey = process.env.YOUTUBE_API_KEY?.trim() ?? ''
  const providers = createYouTubeCollectorProviders({ apiKey: youtubeApiKey })

  try {
    const result = await runSignalCollector({
      providers,
      providerConfigured: youtubeApiKey.length > 0,
      softDeadlineMs: 240_000,
      minimumRemainingMs: 20_000,
    })

    if (result.outcome === 'skipped') {
      return NextResponse.json({ ok: true, skipped: true, reason: 'collector_inactive' })
    }
    if (result.outcome === 'failed') {
      const status = result.stage === 'provider_not_configured' ? 503 : 500
      return NextResponse.json({ ok: false, error: 'Collector unavailable', stage: result.stage }, { status })
    }

    return NextResponse.json({
      ok: true,
      outcome: result.outcome,
      run_id: result.runId,
      deadline_reached: result.deadlineReached,
      provider_quota_exhausted: result.providerQuotaExhausted,
      phases: result.phases,
    })
  } catch {
    console.error('[cron/collect-signals] unexpected collector failure')
    return NextResponse.json({ ok: false, error: 'Collector unavailable' }, { status: 500 })
  }
}
