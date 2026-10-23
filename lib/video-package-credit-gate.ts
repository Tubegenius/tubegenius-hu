// A Video Package kreditkapu és a hozzá tartozó szövegek — tisztán, szerver- és kliensoldalon is használható
// (nincs I/O, nincs szerver-import).
//
// SZERVER-VEZÉRELT KAPU: a /api/video-package a művelet sorrendjében előbb megkeresi a már kifizetett, azonos bemenetű
// eredményt (díjmentes megnyitás, az egyenlegtől függetlenül), és CSAK cache-hiánynál ellenőrzi a kreditet, még AI-hívás
// és levonás előtt (402). A kliens ezért nem tilthat előre egy kevés egyenlegű felhasználót.
//
// MEGERŐSÍTÉS MINDEN HELYZETBEN, A KÜLSŐ FACTS-LEKÉRÉS ELŐTT: az indítás a /api/facts (Wikipedia + Serper) hívásával kezdődne,
// ezért a felhasználó előbb látja és megerősíti, mi történhet (egyenleg szerint háromféle ablak: fedezett / kevés / nem olvasható).
// Az ablak sosem állít feltétel nélküli költséget és biztos "futtatás után marad" egyenleget: a cache-találat 0 kredit,
// az új generálás legfeljebb a megadott összeg.

// Egy mondatban az igazság: új generálás kerül kreditbe (legfeljebb a megadott összegbe), a meglévő eredmény megnyitása nem.
export function newGenerationCostNote(maxCredits: number): string {
  return `Új generálás esetén legfeljebb ${maxCredits} kredit szükséges; a meglévő eredmény megnyitása díjmentes.`
}

// A szerver 402-es szövege cache-hiány és kevés egyenleg esetén (AI-hívás és levonás ELŐTT adja).
export function insufficientCreditsNoCachedResultMessage(cost: number): string {
  return `Nincs elég kredited új generáláshoz (${cost} kredit szükséges), és ehhez a bemenethez még nincs kifizetett eredményed, amit díjmentesen megnyithatnánk.`
}

export type VideoPackageCreditMode = 'covered' | 'insufficient' | 'unknown'

export interface VideoPackageCreditCheck {
  // covered: az egyenleg fedezi a legfeljebb szükséges költséget; insufficient: kevesebb; unknown: nem olvasható
  mode: VideoPackageCreditMode
  feature: string
  // az új generálás (cache-hiány) legfeljebb ennyibe kerül
  maxCost: number
  // a felhasználó egyenlege, vagy null, ha nem olvasható
  balance: number | null
}

export function buildVideoPackageCreditCheck(input: { feature: string; cost: number; balance: number | null }): VideoPackageCreditCheck {
  const { feature, cost, balance } = input
  const readable = typeof balance === 'number' && Number.isFinite(balance)
  const mode: VideoPackageCreditMode = !readable ? 'unknown' : (balance as number) >= cost ? 'covered' : 'insufficient'
  return { mode, feature, maxCost: cost, balance: readable ? (balance as number) : null }
}

// A modal szövegei egy helyen (a komponens és a tesztek ugyanezt használják).
export function creditModalCopy(check: VideoPackageCreditCheck): { title: string; message: string; confirmLabel: string } {
  const { mode, maxCost } = check
  if (mode === 'insufficient') {
    return {
      title: 'Új generáláshoz nincs elég kredited',
      message: 'Ha ehhez a bemenethez már van kifizetett eredményed, azt díjmentesen megnyithatjuk. Találat nélkül a szerver 402-es elutasítást ad: nincs AI-generálás és nincs kreditlevonás.',
      confirmLabel: 'Meglévő eredmény keresése',
    }
  }
  if (mode === 'unknown') {
    return {
      title: 'Az egyenleged most nem olvasható',
      message: `Nem tudtuk ellenőrizni az egyenlegedet. Ha ehhez a bemenethez már van kifizetett eredményed, azt díjmentesen megnyitjuk. Ha nincs, új generálás indulhat, ami legfeljebb ${maxCost} kreditbe kerül; kevés kreditnél a szerver 402-vel elutasít, AI-generálás és kreditlevonás nélkül.`,
      confirmLabel: 'Folytatás',
    }
  }
  return {
    title: 'Gyártási csomag indítása',
    message: `Ha ehhez a bemenethez már van kifizetett eredményed, azt díjmentesen megnyitjuk (0 kredit). Ha nincs, új generálás indul, ami legfeljebb ${maxCost} kreditbe kerül.`,
    confirmLabel: 'Folytatás',
  }
}
