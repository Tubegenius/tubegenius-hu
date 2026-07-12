import { NextResponse } from 'next/server'
import { getUserId } from '@/lib/credits'
import { fetchChannelAnalytics } from '@/lib/youtube-analytics'

// GET — a sajat, OAuth-hoz kotott YouTube csatorna valos analitikaja
// (nezettseg, watch time, feliratkozo-valtozas, top 10 video) az elmult 28
// napra. Kredit nelkul — nem generalast, csak sajat, mar meglevo adatot
// olvas ki a YouTube Analytics API-bol.
export async function GET() {
  try {
    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const analytics = await fetchChannelAnalytics(userId)
    if (!analytics) {
      return NextResponse.json({ error: 'not_connected', message: 'Nincs összekapcsolt YouTube csatorna.' }, { status: 404 })
    }

    return NextResponse.json(analytics)
  } catch (error) {
    console.error('[YouTube Analytics] GET error:', error)
    return NextResponse.json({ error: 'A csatorna-analitika lekérése sikertelen. Próbáld újra, vagy kapcsold össze újra a csatornát.' }, { status: 500 })
  }
}
