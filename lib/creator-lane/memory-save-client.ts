// Kliensoldali "Mentés a memóriába" segédmodul — az Opportunities oldal
// TopicCard.handleSave()-je (app/dashboard/opportunities/page.tsx) használja,
// kiszervezve saját, tisztán tesztelhető modulba, a lib/dashboard/
// manual-refresh-credit.ts már bevált mintáját követve: ez a modul SOSE dönt
// re-entrancy-ről vagy UI-állapotról (azt a komponens saját useRef-alapú
// őre végzi, ld. tests/opportunity-client-static-checks.test.ts hasonló
// statikus ellenőrzéseit) — csak a POST /api/memory pontos body-ját és a
// válasz->UI hibaüzenet leképezését adja, valódi (nem csak forrásszöveg-
// egyezéses) unit teszttel bizonyíthatóan.
//
// LANE-SZERZŐDÉS: a body szándékosan SOSE tartalmaz content_lane mezőt. A
// jelenlegi S2/067-EXPAND állapotban (ld. supabase/migrations/
// 067_creator_lane_expand.sql és lib/creator-lane/lane-service.ts
// upsertCreatorMemory()) ez mindig a pending/NULL lane-t célozza — ez az
// EGYETLEN ma érvényes állapot ezen a felületen, nem új szemantika. Ha a
// 068 (CONTRACT) után valaha lane-választós mentés készül, az egy külön,
// explicit UI-döntés és API-szerződés-bővítés lesz, nem ennek a modulnak a
// hallgatólagos kiterjesztése.
import { normalizeTopicKey, SAVED_LOOKUP_MAX_TOPICS, SAVED_LOOKUP_MAX_TOPIC_LENGTH } from './topic-identity'

export interface SaveTopicToMemoryInput {
  topic: string
  searchKeyword?: string | null
  opportunityScore?: number | null
  platform?: string | null
}

export function buildSaveTopicToMemoryBody(input: SaveTopicToMemoryInput): Record<string, unknown> {
  return {
    // Ugyanaz az identitás-függvény, mint a re-entrancy őr / already-saved
    // Set / saved-lookup válasz feldolgozása — ld. lib/creator-lane/
    // topic-identity.ts. A szerver úgyis btrim()-eli, de a KLIENSOLDALI
    // identitás-egyeztetéseknek (isSaved, saveInFlightKeysRef stb.) pontosan
    // ugyanezt kell küldenie, amit maga is összehasonlításra használ.
    topic: normalizeTopicKey(input.topic),
    search_keyword: input.searchKeyword ?? undefined,
    state: 'saved',
    opportunity_score: input.opportunityScore ?? undefined,
    platform: input.platform ?? undefined,
  }
}

// app/api/memory/route.ts minden hibaágon már ma is egy fix, felhasználóbarát
// magyar szöveget ad vissza — sose a nyers RPC/constraint hibaüzenetet (ld.
// lib/creator-lane/lane-service.ts upsertCreatorMemory() dokumentációja a
// 'lane_conflict_pending_contract' fail-closed értékről). Ez a függvény ennek
// a kliensoldali tükre, defense-in-depth: MÉG akkor is garantáltan generikus
// marad a felhasználónak mutatott szöveg, ha egy jövőbeli szerverváltoztatás
// véletlenül nyers hibaszöveget vagy constraint nevet küldene — a kliens a
// szerver által küldött error-mezőt SOSE jeleníti meg közvetlenül, csak ezt a
// zárt, előre rögzített üzenethalmazt.
export function mapSaveTopicToMemoryError(status: number): string {
  if (status === 401) return 'A mentéshez be kell jelentkezned.'
  if (status === 400) return 'Ez a téma nem menthető el ebben a formában.'
  return 'A mentés sikertelen. Próbáld újra.'
}

export type SaveTopicToMemoryResult =
  | { status: 'saved'; row: Record<string, unknown> }
  | { status: 'skipped' }
  | { status: 'error'; message: string }

// Pontosan egy fetch hívást indít /api/memory-ra, sose máshova (nincs
// /api/opportunity, force_refresh, credit-check vagy provider-hívás ebben a
// függvényben) — ezt a countMemoryPosts/countOtherPosts segéd bizonyítja a
// hozzá tartozó tesztfájlban.
export async function saveTopicToMemory(
  input: SaveTopicToMemoryInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SaveTopicToMemoryResult> {
  try {
    const res = await fetchImpl('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSaveTopicToMemoryBody(input)),
    })
    if (!res.ok) {
      return { status: 'error', message: mapSaveTopicToMemoryError(res.status) }
    }
    const data = await res.json().catch(() => null)
    if (data?.skipped) return { status: 'skipped' }
    if (!data?.item) return { status: 'error', message: mapSaveTopicToMemoryError(500) }
    return { status: 'saved', row: data.item as Record<string, unknown> }
  } catch {
    return { status: 'error', message: 'Kapcsolati hiba — próbáld újra.' }
  }
}

// ============================================================
// Korábban elmentett témák felismerése — egyetlen, könnyű, read-only batch
// lekérdezés a POST /api/memory/saved-lookup-ra (ld. app/api/memory/
// saved-lookup/route.ts). SZÁNDÉKOSAN NEM a GET /api/memory-t (sem annak
// egy korábbi identity_only módját) hívja: az a user ÖSSZES mentett
// témájából a legutóbbi N-et adná vissza (limit=200 örökölve), ami 200+
// mentett rekordnál hamisan "nincs elmentve"-t mutatna egy ténylegesen már
// elmentett, de nem a legutóbbiak közötti témára. Ez a lookup ehelyett
// pontosan azt kérdezi le, hogy az AKTUÁLISAN LÁTHATÓ témák (a hívó adja át
// őket) közül melyik van már elmentve — a válasz halmaz sose nagyobb, mint a
// bemenet, függetlenül a user teljes előzményének méretétől.
//
// Read-hiba (hálózati hiba, non-2xx válasz, hibás JSON) esetén SOSE dob
// kivételt és SOSE jelez hamis "már mentve" állapotot -- egy üres,
// `ok:false` eredményt ad vissza. A hívó (OpportunitiesPage) ezt egy
// explicit loading/ready/error állapotgépben kezeli — 'error' esetén a
// mentés-gombok zárva maradnak, amíg egy explicit "Újrapróbálás" sikeres
// retry-t nem hoz.
export interface FetchSavedStatusResult {
  ok: boolean
  topics: Set<string>
}

export async function fetchSavedStatusForTopics(
  topics: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<FetchSavedStatusResult> {
  const keys = Array.from(new Set(
    topics.map(normalizeTopicKey).filter(key => key.length > 0 && key.length <= SAVED_LOOKUP_MAX_TOPIC_LENGTH),
  ))

  if (keys.length === 0) return { ok: true, topics: new Set() }

  // FAIL-CLOSED, NOT a silent partial lookup: a korábbi `.slice(0,
  // SAVED_LOOKUP_MAX_TOPICS)` csendben eldobta volna az 51.+ témát a
  // válaszból — a hívó ezt "ok:true, de a lekérdezetlen témák nincsenek a
  // Set-ben" formában kapta volna, ami pontosan azt a hamis "nincs elmentve"
  // állapotot okozza, aminek a megelőzésére ez az egész gate épült (egy
  // ténylegesen már elmentett, de a vágás miatt le nem kérdezett téma újra
  // "Mentés"-re kattinthatóvá vált volna). Ha a látható, normalizált,
  // deduplikált témák száma meghaladja a szerver szigorú korlátját, a teljes
  // lookup `ok:false`-t ad — a hívó (OpportunitiesPage) ezt 'error'
  // állapotként kezeli, egyetlen mentés-gomb sem válik aktívvá részleges
  // eredmény alapján, és a szerver korlátja SOSE kerül önkényesen
  // megkerülésre/kliensoldali növelésre.
  if (keys.length > SAVED_LOOKUP_MAX_TOPICS) {
    return { ok: false, topics: new Set() }
  }

  try {
    const res = await fetchImpl('/api/memory/saved-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topics: keys }),
    })
    if (!res.ok) return { ok: false, topics: new Set() }
    const data = await res.json().catch(() => null)
    const items = Array.isArray(data?.topics) ? data.topics : null
    if (!items) return { ok: false, topics: new Set() }
    // Defense-in-depth: a szerver már normalizál, de a kliens SOSE bízzon
    // meg vakon a válasz pontos formájában — ugyanaz a normalizeTopicKey()
    // fut le itt is, mielőtt bármi a Set-be kerülne, amivel a UI a saját
    // (szintén normalizált) topicKey-jeit összehasonlítja.
    const resultTopics = new Set<string>()
    for (const item of items) {
      if (typeof item !== 'string') continue
      const key = normalizeTopicKey(item)
      if (key) resultTopics.add(key)
    }
    return { ok: true, topics: resultTopics }
  } catch {
    return { ok: false, topics: new Set() }
  }
}
