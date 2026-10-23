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
// védelem — és EZ A VÉDELEM KLIENSOLDALI: egy böngészőprofilra (localStorage) és egy
// lapra (sessionStorage) szól, eszközök vagy böngészők között NEM garantál semmit.
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
//
// Oldalfrissítés / bezárt lap: ha az `uncertain` tár (localStorage) meg van adva, a
// paid_result_id-t a POST ELŐTT megjelöljük "bizonytalannak", és a jelölést csak egy
// határozott, INSERT előtti hiba (retrySafe) törli. Így a félbeszakadt kérés (lapozás,
// bezárás, hálózati megszakadás) után is fail-closed marad: a jelölt azonosítóra az
// új saver-példány sem küld kérést. Ha a tár nem elérhető, ez a védelem nem működik
// (nincs mit olvasni/írni) — ilyenkor csak a memóriabeli, egy oldalbetöltésnyi őr él.
export const VIDEO_PACKAGES_ENDPOINT = '/api/video-packages'
export const MEMORY_ENDPOINT = '/api/memory'

// A route ezeket a státuszokat kizárólag az INSERT előtt adja (route.ts POST: auth, törzs-validáció,
// getPaidResultById, szerkezet-ellenőrzés). Pozitív lista — új/ismeretlen státusz sosem kerül ide automatikusan.
export const PRE_WRITE_HTTP_STATUSES: readonly number[] = [400, 401, 404, 422]

export function isDefinitelyNotWritten(httpStatus: number | null): boolean {
  return httpStatus !== null && PRE_WRITE_HTTP_STATUSES.includes(httpStatus)
}

// A Memory-hívás nem blokkolhatja a mentett állapot rögzítését és nem lóghat örökké.
export const MEMORY_LINK_TIMEOUT_MS = 15_000

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
export const UNCERTAIN_SAVE_MESSAGE = 'Az archívum-mentés eredménye bizonytalan: a csomag lehet, hogy már bekerült az archívumba, de ezt nem tudjuk igazolni. Ne mentsd újra.'

export function mapSaveVideoPackageError(status: number | null): string {
  if (status === 401) return 'A mentéshez be kell jelentkezned.'
  if (status === 404) return 'A fizetett eredmény nem található.'
  if (status === 400 || status === 422) return 'A csomag ebben a formában nem menthető.'
  // Minden egyéb (500/503/hálózati hiba/olvashatatlan válasz): a mentés már megtörténhetett.
  return UNCERTAIN_SAVE_MESSAGE
}

// ─── Igazolt archívumsor ──────────────────────────────────────────────────────────
// A video_packages táblában NINCS paid_result_id oszlop: egy fizetett eredményhez nem lehet szerver oldalon
// archívumsort keresni. A "mentett" állapot ezért kizárólag (a) a friss mentés sikeres POST-válaszából (a
// szerver a sort létrehozta és a workflow-lépéseket is lefuttatta), vagy (b) egy konkrét csomag-azonosító
// owner-szűrt olvasásából (GET /api/video-packages?id=) igazolható. A sessionStorage-ból, a paid_results-ból
// vagy egy gyorsítótárazott (from_paid_result) válaszból visszanyitott eredmény ettől még NEM számít mentettnek.
export const ARCHIVE_REF_STORAGE_KEY = 'willviral_video_package_archive_ref'
const ARCHIVE_REF_MAX_ENTRIES = 20

type ArchiveRefMap = Record<string, string>

function parseArchiveRefMap(raw: string | null): ArchiveRefMap {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as { refs?: unknown } | null
    const refs = parsed && typeof parsed === 'object' ? parsed.refs : null
    if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return {}
    const map: ArchiveRefMap = {}
    for (const [paidResultId, packageId] of Object.entries(refs as Record<string, unknown>)) {
      if (typeof packageId === 'string' && packageId) map[paidResultId] = packageId
    }
    return map
  } catch {
    return {}
  }
}

// Több fizetett eredmény hivatkozása él egymás mellett (egy késő mentés nem írhatja felül a másikét).
export function mergeArchiveRef(raw: string | null, paidResultId: string, packageId: string): string {
  const map = parseArchiveRefMap(raw)
  delete map[paidResultId]
  map[paidResultId] = packageId // a legutóbbi a végére kerül
  const entries = Object.entries(map).slice(-ARCHIVE_REF_MAX_ENTRIES)
  return JSON.stringify({ refs: Object.fromEntries(entries) })
}

// A tárolt hivatkozás csak akkor használható, ha EZ a fizetett eredmény tartozik hozzá.
export function readArchiveRef(raw: string | null, paidResultId: string | undefined): string | null {
  if (!paidResultId) return null
  return parseArchiveRefMap(raw)[paidResultId] ?? null
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

// ─── Tartós "bizonytalan" jelölés (oldalfrissítés után is fail-closed) ───────────────
export const UNCERTAIN_IDS_STORAGE_KEY = 'willviral_video_package_uncertain_ids'
const UNCERTAIN_IDS_MAX_ENTRIES = 50

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface UncertainStore {
  isUncertain(paidResultId: string): boolean
  mark(paidResultId: string): void
  clear(paidResultId: string): void
}

function parseUncertainIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
  } catch {
    return []
  }
}

// A tárat hívásonként kérjük le (SSR-nél nincs window; privát módban a hozzáférés dobhat) — minden hiba "nincs tár".
export function createStorageUncertainStore(getStorage: () => StorageLike | null): UncertainStore {
  function read(): { storage: StorageLike; ids: string[] } | null {
    try {
      const storage = getStorage()
      if (!storage) return null
      return { storage, ids: parseUncertainIds(storage.getItem(UNCERTAIN_IDS_STORAGE_KEY)) }
    } catch {
      return null
    }
  }
  function write(storage: StorageLike, ids: string[]): void {
    try { storage.setItem(UNCERTAIN_IDS_STORAGE_KEY, JSON.stringify(ids.slice(-UNCERTAIN_IDS_MAX_ENTRIES))) } catch { /* nincs tár */ }
  }
  return {
    isUncertain(paidResultId) {
      return read()?.ids.includes(paidResultId) ?? false
    },
    mark(paidResultId) {
      const current = read()
      if (!current) return
      write(current.storage, [...current.ids.filter(id => id !== paidResultId), paidResultId])
    },
    clear(paidResultId) {
      const current = read()
      if (!current || !current.ids.includes(paidResultId)) return
      write(current.storage, current.ids.filter(id => id !== paidResultId))
    },
  }
}

export type SaveVideoPackageOutcome =
  | { status: 'saved'; id: string; alreadySaved: boolean; memoryLinked: boolean }
  | { status: 'error'; message: string; httpStatus: number | null; retrySafe: boolean }

export interface SaveVideoPackageHooks {
  // A sikeres archívum-POST azonosítójával, AZONNAL meghívva — a Memory-hívás előtt és attól függetlenül.
  onArchived?: (packageId: string) => void
}

export interface VideoPackageSaver {
  save(input: SaveVideoPackageInput, hooks?: SaveVideoPackageHooks): Promise<SaveVideoPackageOutcome>
  // Igaz, ha ehhez a paid_result_id-hoz bizonytalan kimenetű (vagy félbeszakadt) mentés tartozik és nincs igazolt mentett sor.
  isUncertain(paidResultId: string): boolean
}

export interface VideoPackageSaverOptions {
  uncertain?: UncertainStore
  memoryTimeoutMs?: number
}

export function createVideoPackageSaver(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  options: VideoPackageSaverOptions = {},
): VideoPackageSaver {
  const store = options.uncertain ?? null
  const memoryTimeoutMs = options.memoryTimeoutMs ?? MEMORY_LINK_TIMEOUT_MS
  const saved = new Map<string, { id: string; memoryLinked: boolean }>()
  const inFlight = new Map<string, Promise<SaveVideoPackageOutcome>>()
  // Bizonytalan kimenetelű (retrySafe=false) mentések: ugyanarra a paid_result_id-ra nincs több kérés.
  const uncertain = new Map<string, SaveVideoPackageOutcome>()

  function uncertainOutcome(httpStatus: number | null): SaveVideoPackageOutcome {
    return { status: 'error', message: mapSaveVideoPackageError(httpStatus), httpStatus, retrySafe: false }
  }

  async function linkMemory(input: SaveVideoPackageInput, packageId: string): Promise<boolean> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => { controller?.abort(); resolve(false) }, memoryTimeoutMs)
    })
    const call = (async () => {
      try {
        const res = await fetchImpl(MEMORY_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildLinkPackageToMemoryBody({ topic: input.topic, searchKeyword: input.searchKeyword, videoPackageId: packageId })),
          signal: controller?.signal,
        })
        return res.ok
      } catch {
        return false
      }
    })()
    try {
      return await Promise.race([call, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async function run(input: SaveVideoPackageInput, hooks?: SaveVideoPackageHooks): Promise<SaveVideoPackageOutcome> {
    const key = input.paidResultId
    // A kérés ELŐTT jelöljük: ha a lap a kérés közben megszűnik, a jelölés megmarad (fail-closed).
    store?.mark(key)
    let res: Response
    try {
      res = await fetchImpl(VIDEO_PACKAGES_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSaveVideoPackageBody(key)),
      })
    } catch {
      // A kérés célba érhetett és a szerver menthetett: bizonytalan, nem újrapróbálható.
      return uncertainOutcome(null)
    }
    if (!res.ok) {
      // Csak az INSERT előtti státuszoknál bizonyos, hogy nem jött létre sor; az 500/503 és a többi lehet INSERT utáni is
      // (a kompenzáló DELETE sikerében nem bízunk).
      const retrySafe = isDefinitelyNotWritten(res.status)
      if (retrySafe) store?.clear(key)
      return { status: 'error', message: mapSaveVideoPackageError(res.status), httpStatus: res.status, retrySafe }
    }
    let id: unknown
    try {
      id = ((await res.json()) as { id?: unknown } | null)?.id
    } catch {
      id = undefined
    }
    if (typeof id !== 'string' || !id) return uncertainOutcome(res.status)

    // A mentett állapotot és az azonosítót AZONNAL rögzítjük — a Memory-kapcsolat ettől függetlenül, utána indul,
    // és a hibája nem teszi semmissé a már mentett csomagot (memoryLinked=false).
    saved.set(key, { id, memoryLinked: false })
    try { hooks?.onArchived?.(id) } catch { /* a hívó hibája nem érintheti a mentést */ }
    const memoryLinked = await linkMemory(input, id)
    saved.set(key, { id, memoryLinked })
    return { status: 'saved', id, alreadySaved: false, memoryLinked }
  }

  return {
    async save(input, hooks) {
      const key = input.paidResultId
      if (typeof key !== 'string' || !key) {
        return { status: 'error', message: mapSaveVideoPackageError(400), httpStatus: null, retrySafe: true }
      }
      // Futó mentésnél ugyanazt az ígéretet adjuk (a Memory-lépés végét is megvárja): nincs második kérés.
      const running = inFlight.get(key)
      if (running) return running
      const known = saved.get(key)
      if (known) {
        try { hooks?.onArchived?.(known.id) } catch { /* lásd fent */ }
        return { status: 'saved', id: known.id, alreadySaved: true, memoryLinked: known.memoryLinked }
      }
      const blocked = uncertain.get(key)
      if (blocked) return blocked
      if (store?.isUncertain(key)) return uncertainOutcome(null)
      const attempt = run(input, hooks)
        .then(outcome => {
          if (outcome.status === 'error' && !outcome.retrySafe) uncertain.set(key, outcome)
          return outcome
        })
        .finally(() => { inFlight.delete(key) })
      inFlight.set(key, attempt)
      return attempt
    },
    isUncertain(paidResultId) {
      if (saved.has(paidResultId)) return false
      return uncertain.has(paidResultId) || (store?.isUncertain(paidResultId) ?? false)
    },
  }
}
