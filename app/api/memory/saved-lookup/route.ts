import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { getCreatorMemoryByLaneFilter } from '@/lib/creator-lane/lane-service'
import { normalizeTopicKey, SAVED_LOOKUP_MAX_TOPICS, SAVED_LOOKUP_MAX_TOPIC_LENGTH } from '@/lib/creator-lane/topic-identity'

// POST /api/memory/saved-lookup -- read-only batch identity lookup for the
// "Mentés a memóriába" CTA (app/dashboard/opportunities/page.tsx,
// lib/creator-lane/memory-save-client.ts fetchSavedStatusForTopics()).
//
// WHY A DEDICATED POST ROUTE, NOT A GET /api/memory QUERY PARAM: the earlier
// `identity_only` GET mode inherited GET /api/memory's `limit` (default 200,
// max 500), which only ever returns the user's most-recently-updated saved
// topics -- with more than that many saved records, a currently-visible
// Opportunity topic that IS already saved (just not among the most recent
// N) would be silently misreported as "not saved". This route instead takes
// the exact, deduplicated list of CURRENTLY VISIBLE topic titles and asks
// "which of THESE are already saved" -- correct regardless of how large the
// user's total creator_memory history is, because the answer set can never
// exceed the input set. POST (not GET) only because the input is a list
// that would not fit a query string safely at scale -- this handler issues
// ZERO writes; it is a read-only lookup that happens to carry a body.
//
// Server-enforced, NOT client-trusted: count and per-topic length are both
// capped here regardless of what the client sends (SAVED_LOOKUP_MAX_TOPICS /
// SAVED_LOOKUP_MAX_TOPIC_LENGTH, shared with the client via
// lib/creator-lane/topic-identity.ts so the client can defensively pre-trim,
// but the server never trusts that it did).
export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const rawTopics = body?.topics

  if (!Array.isArray(rawTopics) || rawTopics.length === 0 || rawTopics.some(t => typeof t !== 'string')) {
    return NextResponse.json({ error: 'Érvénytelen témalista' }, { status: 400 })
  }
  if (rawTopics.length > SAVED_LOOKUP_MAX_TOPICS) {
    return NextResponse.json({ error: `Legfeljebb ${SAVED_LOOKUP_MAX_TOPICS} téma kérdezhető le egyszerre` }, { status: 400 })
  }
  if (rawTopics.some((t: string) => t.length > SAVED_LOOKUP_MAX_TOPIC_LENGTH)) {
    return NextResponse.json({ error: 'Egy vagy több téma túl hosszú' }, { status: 400 })
  }

  // Dedup + trim-only normalization (same identity as upsert_creator_memory's
  // btrim() -- no lowercase/Unicode folding, ld. lib/creator-lane/
  // topic-identity.ts). Empty-after-trim entries are dropped -- they could
  // never have a matching saved record anyway (POST /api/memory rejects
  // them at the server too).
  const keys = Array.from(new Set(rawTopics.map(normalizeTopicKey).filter(key => key.length > 0)))
  if (keys.length === 0) {
    return NextResponse.json({ topics: [] })
  }

  const admin = createAdminClient()
  try {
    // Kizárólag a jelenlegi S2 pending/NULL lane-t vizsgálja (contentLane:
    // null, fail-closed assertValidLaneFilter ugyanúgy, mint minden más
    // creator_memory olvasás) és kizárólag 'saved' állapotot -- ez pontosan
    // az a rekordhalmaz, amit a "Mentés a memóriába" CTA saját maga hoz
    // létre/frissít, nem "bármilyen módon érintett" téma.
    const items = await getCreatorMemoryByLaneFilter(admin, {
      userId: user.id,
      contentLane: null,
      state: 'saved',
      select: 'topic',
      topics: keys,
      limit: keys.length,
    })
    const savedTopics = Array.from(new Set(
      (items as { topic: string }[])
        .map(item => normalizeTopicKey(item.topic))
        .filter(key => key.length > 0),
    ))
    return NextResponse.json({ topics: savedTopics })
  } catch (error) {
    console.error('Memory saved-lookup error:', error)
    return NextResponse.json({ error: 'A mentett állapot ellenőrzése sikertelen. Próbáld újra.' }, { status: 500 })
  }
}
