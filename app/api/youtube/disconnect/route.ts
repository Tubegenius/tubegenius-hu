import { NextResponse } from 'next/server'
import { getUserId } from '@/lib/credits'
import { deleteYoutubeOAuthTokens } from '@/lib/youtube-analytics'

// POST — a YouTube csatorna-kapcsolat bontasa: torli a tarolt refresh
// tokent, a Channel Audit visszaall a kezi audit-alapu mukodesre.
export async function POST() {
  try {
    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    await deleteYoutubeOAuthTokens(userId)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[YouTube Analytics] disconnect error:', error)
    return NextResponse.json({ error: 'A kapcsolat bontása sikertelen. Próbáld újra.' }, { status: 500 })
  }
}
