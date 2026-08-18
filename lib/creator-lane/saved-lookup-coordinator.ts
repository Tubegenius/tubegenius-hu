// A "korábban elmentve" batch-lookup (OpportunitiesPage.runSavedLookup())
// race-mentes ütemezője, kiszervezve saját, tisztán tesztelhető, React-
// mentes modulba — pontosan azért, hogy a versenyhelyzet-védelem
// determinisztikus deferred-Promise teszttel bizonyítható legyen, ne csak
// forrásszöveg-egyezéssel (a repo Vitest-je nem tud React-et renderelni).
//
// A VÉDETT HIBA: ha a request-ID-t csak a NEM ÜRES ágban növelnénk, egy
// korábbi, még futó lookup (A) később beérkező válasza felülírhatná egy
// közben üres listára váltó, gyorsabban 'ready'-vé váló újabb híváséét — az
// üres-listás ág soha nem invalidálná A-t. Ezért a request-ID MINDEN híváskor,
// feltétel nélkül, a legelső lépésként nő — az üres-listás ág is "elindít
// egy kérést" abban az értelemben, hogy érvényteleníti az összes korábbit.
export interface FetchSavedStatusResult {
  ok: boolean
  topics: Set<string>
}

export interface SavedLookupCoordinatorCallbacks {
  onLoading: () => void
  onReady: (newlySavedTopics: Set<string>) => void
  onError: () => void
}

// A hívó (OpportunitiesPage) egy useRef(0)-t ad át tracker-ként — a React
// ref pontosan `{ current: number }` alakú, ugyanaz az objektum-referencia
// minden hívás között megmarad, így ez a függvény ténylegesen a komponens
// élettartama alatt egyetlen, folytonosan növekvő számlálót lát.
export interface SavedLookupRequestTracker {
  current: number
}

export async function runSavedLookupCoordinated(
  visibleKeys: string[],
  tracker: SavedLookupRequestTracker,
  callbacks: SavedLookupCoordinatorCallbacks,
  fetchStatus: (keys: string[]) => Promise<FetchSavedStatusResult>,
): Promise<void> {
  tracker.current += 1
  const requestId = tracker.current

  if (visibleKeys.length === 0) {
    callbacks.onReady(new Set())
    return
  }

  callbacks.onLoading()
  const result = await fetchStatus(visibleKeys)
  // Egy közben indult, frissebb hívás már felülírta ezt — a régi válasz
  // (sikeres VAGY hibás) sem a topics-Set-et, sem az állapotot nem
  // módosíthatja.
  if (tracker.current !== requestId) return

  if (!result.ok) {
    callbacks.onError()
    return
  }
  callbacks.onReady(result.topics)
}
