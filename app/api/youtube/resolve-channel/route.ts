import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/credits'
import { resolveChannel } from '@/lib/competitor-tracker'

// POST — publikus csatorna-elonezet (URL/handle/channelId/nev alapjan),
// NINCS DB-iras. Az onboarding "Csatorna elemzese" gombja hivja, hogy
// megmutassa a "Ez a te csatornad?" elonezeti kartyat, mielott a user
// megerositi es a /api/youtube/confirm-channel route perzisztalja.
export async function POST(request: NextRequest) {
  try {
    const { input } = await request.json()
    if (!input || typeof input !== 'string' || !input.trim()) {
      return NextResponse.json({ error: 'Csatorna URL, handle vagy név megadása kötelező.' }, { status: 400 })
    }

    const userId = await getUserId()
    if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const snapshot = await resolveChannel(input.trim())
    if (!snapshot) {
      return NextResponse.json({ error: 'channel_not_found', message: 'Nem találtunk ilyen YouTube csatornát.' }, { status: 404 })
    }

    return NextResponse.json({ snapshot })
  } catch (error) {
    console.error('[YouTube resolve-channel] error:', error)
    return NextResponse.json({ error: 'A csatorna felismerése sikertelen. Próbáld újra.' }, { status: 500 })
  }
}
