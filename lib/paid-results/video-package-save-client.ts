// Kliensoldali "Videócsomag mentése" segédmodul — az app/dashboard/video-package
// oldal automatikus és (hiba utáni) kézi mentése EZT használja, kiszervezve saját,
// tisztán tesztelhető modulba (ld. lib/creator-lane/memory-save-client.ts mintája).
//
// SZERZŐDÉS (bizonyítva: app/api/video-packages/route.ts POST + tests/
// video-packages-route-post.test.ts): a POST /api/video-packages a kérés törzséből
// KIZÁRÓLAG a paid_result_id-t olvassa (UUID, owner-szűrt getPaidResultById), a
// csomag teljes tartalmát a szerver a paid_results.result_json-ból veszi. A törzs
// ezért CSAK {paid_result_id}. A korábbi kliens a teljes eredményt (narráció,
// jelenetek, tényblokk, ...) is elküldte, amit a szerver sosem használt, viszont
// az isJsonWithinLimit(requestBody) alapértelmezett 20 000 bájtos korlátja miatt
// egy hosszú csomagnál HTTP 400-zal elutasított (staging, 2026-10-22: a törzs
// értékei önmagukban ~19 965 bájt + kulcsnevek + a tényblokk-string > 20 000). A
// szerveroldali korlátot szándékosan NEM emeltük.
//
// Ez a modul sosem generál újra, nem von le kreditet és nem hív AI-szolgáltatót:
// kizárólag POST /api/video-packages és — SIKERES mentés után — POST /api/memory.
//
// Mentési újrapróbálás: a modul SOSE próbálkozik újra magától (nincs ciklus, nincs
// időzített retry). A dupla mentés ellen: ugyanarra a paid_result_id-ra egyszerre
// legfeljebb egy kérés fut (a párhuzamos hívás ugyanazt az ígéretet kapja), és egy
// már sikeresen mentett eredményre nem indul új kérés. A szerver nem idempotens
// (minden sikeres POST új video_packages sort hoz létre), ezért a kliens őr a
// védelem.
//
// Mikor biztonságos az újrapróbálás (retrySafe)? KIZÁRÓLAG zárt, pozitívan felsorolt
// HTTP-státuszoknál, amelyeket a route a video_packages INSERT ELŐTT ad vissza
// (400 érvénytelen törzs, 401 nincs belépve, 404 nincs ilyen fizetett eredmény,
// 422 hibás tárolt szerkezet). MINDEN más válasz bizonytalan: az 500/503 és bármely
// más hiba az INSERT UTÁN is keletkezhet — a route workflow-hibaágai (ensureVideoIdea /
// link / markReady) az INSERT után 500-at adnak, és a kompenzáló DELETE eredményét
// nem ellenőrzik, így a sor megmaradhat. Ugyanígy bizonytalan a hálózati hiba és az
// olvashatatlan sikeres válasz. Bizonytalan kimenetel után a modul ugyanarra a
// paid_result_id-ra TÖBBÉ nem küld kérést (a kimenetel megőrződik): nincs vak újrapróbálás.
export const VIDEO_PACKAGES_ENDPOINT = '/api/video-packages'
export const MEMORY_ENDPOINT = '/api/memory'

// A route ezeket a státuszokat kizárólag az INSERT előtt adja (route.ts POST: auth, törzs-validáció,
// getPaidResultById, szerkezet-ellenőrzés). Pozitív lista — új/ismeretlen státusz sosem kerül ide automatikusan.
export const PRE_WRITE_HTTP_STATUSES: readonly number[] = [400, 401, 404, 422]

export function isDefinitelyNotWritten(httpStatus: number | null): boolean {
  return httpStatus !== null && PRE_WRITE_HTTP_STATUSES.includes(httpStatus)
}

export interface SaveVideoPackageInput {
  paidResultId: string
  topic: string
  searchKeyword?: string | null
}

export function buildSaveVideoPackageBody(paidResultId: string): { paid_result_id: string } {
  return { paid_result_id: paidResultId }
}

export function buildLinkPackageToMemoryBody(input: { topic: string; searchKeyword?: string | null; videoPackageId: string }): Record<string, unknown> {
  return {
    topic: input.topic,
    search_keyword: input.searchKeyword || null,
    state: 'in_progress',
    video_package_id: input.videoPackageId,
  }
}

// A szerver minden hibaágon fix, felhasználóbarát szöveget ad; a kliens ennek a
// zárt tükrét mutatja, sosem a szerver error-mezőjét.
export function mapSaveVideoPackageError(status: number | null): string {
  if (status === 401) return 'A mentéshez be kell jelentkezned.'
  if (status === 404) return 'A fizetett eredmény nem található.'
  if (status === 400 || status === 422) return 'A csomag ebben a formában nem menthető.'
  // Minden egyéb (500/503/hálózati hiba/olvashatatlan válasz): a csomag mentése már megtörténhetett.
  return 'A mentés eredménye bizonytalan: a csomag létrejöhetett az archívumban. Ne mentsd újra; előbb ellenőrizd a Tartalommemóriában a mentett videócsomagokat.'
}

// ─── Igazolt archívumsor ──────────────────────────────────────────────────────────
// A video_packages táblában NINCS paid_result_id oszlop: egy fizetett eredményhez nem lehet szerver oldalon
// archívumsort keresni. A "mentett" állapot ezért kizárólag (a) a friss mentés sikeres POST-válaszából (a
// szerver a sort létrehozta és a workflow-lépéseket is lefuttatta), vagy (b) egy konkrét csomag-azonosító
// owner-szűrt olvasásából (GET /api/video-packages?id=) igazolható. A sessionStorage-ból vagy a
// paid_results-ból visszanyitott eredmény ettől még NEM számít mentettnek.
export const ARCHIVE_REF_STORAGE_KEY = 'willviral_video_package_archive_ref'

export function serializeArchiveRef(paidResultId: string, packageId: string): string {
  return JSON.stringify({ paidResultId, packageId })
}

// A tárolt hivatkozás csak akkor használható, ha EZ a fizetett eredmény tartozik hozzá.
export function readArchiveRef(raw: string | null, paidResultId: string | undefined): string | null {
  if (!raw || !paidResultId) return null
  try {
    const ref = JSON.parse(raw) as { paidResultId?: unknown; packageId?: unknown } | null
    if (ref && ref.paidResultId === paidResultId && typeof ref.packageId === 'string' && ref.packageId) return ref.packageId
  } catch {
    // sérült tároló: nincs hivatkozás
  }
  return null
}

export type ArchiveVerification = 'present' | 'absent' | 'unknown'

// Egyetlen, csak olvasó kérés. Csak a 200 + egyező azonosító igazolja a sort; minden más NEM igazolás.
export async function verifyArchivedPackage(packageId: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<ArchiveVerification> {
  try {
    const res = await fetchImpl(`${VIDEO_PACKAGES_ENDPOINT}?id=${encodeURIComponent(packageId)}`)
    if (res.status === 404) return 'absent'
    if (!res.ok) return 'unknown'
    const body = (await res.json()) as { package?: { id?: unknown } } | null
    return body?.package?.id === packageId ? 'present' : 'unknown'
  } catch {
    return 'unknown'
  }
}

export type SaveVideoPackageOutcome =
  | { status: 'saved'; id: string; alreadySaved: boolean; memoryLinked: boolean }
  | { status: 'error'; message: string; httpStatus: number | null; retrySafe: boolean }

export interface VideoPackageSaver {
  save(input: SaveVideoPackageInput): Promise<SaveVideoPackageOutcome>
}

export function createVideoPackageSaver(fetchImpl: typeof fetch = (...args) => fetch(...args)): VideoPackageSaver {
  const saved = new Map<string, { id: string; memoryLinked: boolean }>()
  const inFlight = new Map<string, Promise<SaveVideoPackageOutcome>>()
  // Bizonytalan kimenetelű (retrySafe=false) mentések: ugyanarra a paid_result_id-ra nincs több kérés.
  const uncertain = new Map<string, SaveVideoPackageOutcome>()

  async function run(input: SaveVideoPackageInput): Promise<SaveVideoPackageOutcome> {
    let res: Response
    try {
      res = await fetchImpl(VIDEO_PACKAGES_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSaveVideoPackageBody(input.paidResultId)),
      })
    } catch {
      // A kérés célba érhetett és a szerver menthetett: bizonytalan, nem újrapróbálható.
      return { status: 'error', message: mapSaveVideoPackageError(null), httpStatus: null, retrySafe: false }
    }
    if (!res.ok) {
      // Csak az INSERT előtti státuszoknál bizonyos, hogy nem jött létre sor; az 500/503 és a többi lehet INSERT utáni is
      // (a kompenzáló DELETE sikerében nem bízunk).
      return { status: 'error', message: mapSaveVideoPackageError(res.status), httpStatus: res.status, retrySafe: isDefinitelyNotWritten(res.status) }
    }
    let id: unknown
    try {
      id = ((await res.json()) as { id?: unknown } | null)?.id
    } catch {
      id = undefined
    }
    if (typeof id !== 'string' || !id) {
      return { status: 'error', message: mapSaveVideoPackageError(null), httpStatus: res.status, retrySafe: false }
    }

    // A Memory-kapcsolat KIZÁRÓLAG sikeres mentés után indul; hibája nem teszi
    // semmissé a már mentett csomagot, csak jelzi (memoryLinked=false).
    let memoryLinked = false
    try {
      const memoryRes = await fetchImpl(MEMORY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildLinkPackageToMemoryBody({ topic: input.topic, searchKeyword: input.searchKeyword, videoPackageId: id })),
      })
      memoryLinked = memoryRes.ok
    } catch {
      memoryLinked = false
    }
    return { status: 'saved', id, alreadySaved: false, memoryLinked }
  }

  return {
    async save(input) {
      const key = input.paidResultId
      if (typeof key !== 'string' || !key) {
        return { status: 'error', message: mapSaveVideoPackageError(400), httpStatus: null, retrySafe: true }
      }
      const known = saved.get(key)
      if (known) return { status: 'saved', id: known.id, alreadySaved: true, memoryLinked: known.memoryLinked }
      const blocked = uncertain.get(key)
      if (blocked) return blocked
      const running = inFlight.get(key)
      if (running) return running
      const attempt = run(input)
        .then(outcome => {
          if (outcome.status === 'saved') saved.set(key, { id: outcome.id, memoryLinked: outcome.memoryLinked })
          else if (!outcome.retrySafe) uncertain.set(key, outcome)
          return outcome
        })
        .finally(() => { inFlight.delete(key) })
      inFlight.set(key, attempt)
      return attempt
    },
  }
}
