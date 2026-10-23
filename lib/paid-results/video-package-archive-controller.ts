// Az app/dashboard/video-package oldal archívum-állapotgépe, React nélkül (tisztán tesztelhető):
// ki mondhatja ki, hogy egy fizetett eredmény "mentett", és mikor szabad vagy tilos a mentést indítani.
//
// SZABÁLYOK (mind KLIENSOLDALI védelem — böngészőprofilra/lapra szólnak, eszközök között semmit nem garantálnak,
// a szerver POST továbbra sem idempotens; ld. lib/paid-results/video-package-save-client.ts):
//   * "mentett" (saved) csak igazolt archívumsor alapján: friss, sikeres archívum-POST-válasz, egy ?id= betöltés
//     (markArchived), vagy ugyanahhoz a paid_result_id-hoz tárolt csomag-azonosító owner-szűrt olvasása
//     (reconcileReopened). Egy visszanyitott / gyorsítótárból (from_paid_result) visszaadott eredmény NEM mentett.
//   * gyorsítótárból visszaadott (cache-találat) eredményből sosem indul automatikus mentés: azt az eredetileg
//     generáló oldal már megpróbálta, egy második POST dupla sort hozhat.
//   * a sikeres archívum-POST azonosítója és a mentett állapot AZONNAL rögzül (állapot + tár), a Memory-hívástól
//     függetlenül; a Memory hibája külön jelzés (memoryLinkFailed).
//   * minden állapotírás egy generálási tokenhez kötött: egy későn befejeződő régi mentés nem módosíthatja egy
//     újabb generálás állapotát (csak a paid_result_id-hoz kötött hivatkozás kerül a tárba).
//   * a kézi újrapróbálás (retry) csak határozott, INSERT előtti hiba (retrySafe) után fut; bizonytalan kimenetel
//     (és oldalfrissítés után a tartósan jelölt azonosító) után nincs újrapróbálás.
import {
  ARCHIVE_REF_STORAGE_KEY,
  UNCERTAIN_SAVE_MESSAGE,
  mergeArchiveRef,
  readArchiveRef,
  verifyArchivedPackage,
  type SaveVideoPackageOutcome,
  type StorageLike,
  type VideoPackageSaver,
} from '@/lib/paid-results/video-package-save-client'

export const MISSING_PAID_RESULT_ID_MESSAGE = 'A fizetett eredményhez nem tartozik azonosító, ezért az archívum-mentés nem indítható.'

export interface ArchiveSaveError {
  message: string
  // true: a hiba biztosan a beszúrás előtt keletkezett, a kézi újrapróbálás nem hozhat létre második sort.
  retrySafe: boolean
}

export interface ArchiveState {
  saved: boolean
  savedPackageId: string | null
  saveError: ArchiveSaveError | null
  // A csomag archívum-mentése igazolt, de a Memory-kapcsolat nem jött létre (külön jelzés, nem mentési hiba).
  memoryLinkFailed: boolean
  archiving: boolean
}

export const INITIAL_ARCHIVE_STATE: ArchiveState = {
  saved: false,
  savedPackageId: null,
  saveError: null,
  memoryLinkFailed: false,
  archiving: false,
}

export interface ArchivablePackage {
  paid_result_id?: string
  topic: string
}

export interface ArchiveContext {
  searchKeyword: string | null
}

export type ReconcileResult = 'archived' | 'uncertain' | 'unverified'

export interface ArchiveControllerDeps {
  saver: VideoPackageSaver
  // A lap (sessionStorage) hivatkozás-tára; a hívásonkénti lekérés SSR-nél / privát módban null lehet.
  getSessionStorage: () => StorageLike | null
  fetchImpl?: typeof fetch
  onChange: (state: ArchiveState) => void
}

export interface ArchiveController {
  getState(): ArchiveState
  currentToken(): number
  isCurrent(token: number): boolean
  // Új generálás kezdete: az állapot alaphelyzetbe áll, a korábbi (még futó) mentések elavulnak.
  beginGeneration(): number
  persist(token: number, pkg: ArchivablePackage, ctx: ArchiveContext): Promise<SaveVideoPackageOutcome | null>
  retry(pkg: ArchivablePackage, ctx: ArchiveContext): Promise<{ token: number; outcome: SaveVideoPackageOutcome | null }>
  reconcileReopened(pkg: { paid_result_id?: string }): Promise<ReconcileResult>
  markArchived(packageId: string): void
}

export function createArchiveController(deps: ArchiveControllerDeps): ArchiveController {
  let state: ArchiveState = INITIAL_ARCHIVE_STATE
  let token = 0

  function apply(forToken: number, patch: Partial<ArchiveState>): boolean {
    if (forToken !== token) return false
    state = { ...state, ...patch }
    deps.onChange(state)
    return true
  }

  function rememberRef(paidResultId: string, packageId: string): void {
    try {
      const storage = deps.getSessionStorage()
      if (!storage) return
      storage.setItem(ARCHIVE_REF_STORAGE_KEY, mergeArchiveRef(storage.getItem(ARCHIVE_REF_STORAGE_KEY), paidResultId, packageId))
    } catch {
      // nincs tár: a mentett állapot ettől még él az oldalon, csak frissítés után nem igazolható
    }
  }

  function readRef(paidResultId: string): string | null {
    try {
      const storage = deps.getSessionStorage()
      return storage ? readArchiveRef(storage.getItem(ARCHIVE_REF_STORAGE_KEY), paidResultId) : null
    } catch {
      return null
    }
  }

  async function persist(forToken: number, pkg: ArchivablePackage, ctx: ArchiveContext): Promise<SaveVideoPackageOutcome | null> {
    const paidResultId = pkg.paid_result_id
    if (!paidResultId) {
      apply(forToken, { saveError: { message: MISSING_PAID_RESULT_ID_MESSAGE, retrySafe: false } })
      return null
    }
    apply(forToken, { saveError: null, archiving: true, memoryLinkFailed: false })
    const outcome = await deps.saver.save(
      { paidResultId, topic: pkg.topic, searchKeyword: ctx.searchKeyword },
      {
        // AZONNAL, a Memory-hívás előtt: a tár mindig, az állapot csak ha a generálás még az aktuális.
        onArchived: packageId => {
          rememberRef(paidResultId, packageId)
          apply(forToken, { saved: true, savedPackageId: packageId, saveError: null, archiving: false })
        },
      },
    )
    if (outcome.status === 'saved') {
      rememberRef(paidResultId, outcome.id)
      apply(forToken, { saved: true, savedPackageId: outcome.id, saveError: null, archiving: false, memoryLinkFailed: !outcome.memoryLinked })
    } else {
      apply(forToken, { saveError: { message: outcome.message, retrySafe: outcome.retrySafe }, archiving: false })
    }
    return outcome
  }

  return {
    getState: () => state,
    currentToken: () => token,
    isCurrent: forToken => forToken === token,

    beginGeneration() {
      token += 1
      state = INITIAL_ARCHIVE_STATE
      deps.onChange(state)
      return token
    },

    persist,

    async retry(pkg, ctx) {
      const forToken = token
      // Csak határozott, INSERT előtti hiba után, és nem futó/kész mentés mellett.
      if (state.saved || state.archiving || !state.saveError?.retrySafe) return { token: forToken, outcome: null }
      return { token: forToken, outcome: await persist(forToken, pkg, ctx) }
    },

    async reconcileReopened(pkg) {
      const forToken = token
      const paidResultId = pkg.paid_result_id
      if (!paidResultId) return 'unverified'
      const packageId = readRef(paidResultId)
      if (packageId && (await verifyArchivedPackage(packageId, deps.fetchImpl)) === 'present') {
        const applied = apply(forToken, { saved: true, savedPackageId: packageId, saveError: null })
        return applied ? 'archived' : 'unverified'
      }
      // Nincs igazolt sor. Ha ehhez az azonosítóhoz korábban bizonytalan (vagy félbeszakadt) mentés tartozott,
      // fail-closed: az oldal ezt mutatja, és nem kínál mentést.
      if (deps.saver.isUncertain(paidResultId)) {
        apply(forToken, { saveError: { message: UNCERTAIN_SAVE_MESSAGE, retrySafe: false } })
        return 'uncertain'
      }
      return 'unverified'
    },

    markArchived(packageId) {
      apply(token, { saved: true, savedPackageId: packageId, saveError: null })
    },
  }
}
