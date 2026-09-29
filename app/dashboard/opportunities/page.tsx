'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase'
import { useSearchParams } from 'next/navigation'
import type { CreatorProfile, OpportunityApiResponse } from '@/types'
import { regionLabel, platformLabel } from '@/lib/score-utils'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import type { UsageCheckResult } from '@/lib/usage-protection'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'
import { fetchSavedStatusForTopics } from '@/lib/creator-lane/memory-save-client'
import { normalizeTopicKey } from '@/lib/creator-lane/topic-identity'
import { runSavedLookupCoordinated } from '@/lib/creator-lane/saved-lookup-coordinator'
import { useCreditBalance } from '@/components/credits/CreditBalanceContext'
import { publishCreditMutationCompleted } from '@/lib/credit-balance-events'
// TopicCard/DiscoveryLaneCard (and their private helpers, ExtendedTopic,
// isDiscoveryLane) live in ./topic-cards, NOT in this file -- a page.tsx
// may only export the fixed set of names Next's page-type generator
// recognizes, so any component meant to be imported by tests (or anything
// else) must live outside it. See topic-cards.tsx's header comment.
import { TopicCard, DiscoveryLaneCard, isDiscoveryLane, type ExtendedTopic } from './topic-cards'

// ── Fő oldal ──────────────────────────────────────────────────

export default function OpportunitiesPage() {
  const { refreshCredits } = useCreditBalance()
  const supabase = createClient()
  const searchParams = useSearchParams()
  const highlightId = searchParams.get('highlight')
  const nicheParam = searchParams.get('niche')
  const paidResultId = searchParams.get('paidResultId') || ''
  const [profile, setProfile] = useState<CreatorProfile | null>(null)
  const [highlightTopic, setHighlightTopic] = useState<ExtendedTopic | null>(null)
  const [niche, setNiche] = useState('')
  const [searchMode, setSearchMode] = useState<'niche_based' | 'specific_topic' | 'discovery_random'>('niche_based')
  const [discoveryGoal, setDiscoveryGoal] = useState('')
  const [useChannelSignals, setUseChannelSignals] = useState(true)
  const [searchDirections, setSearchDirections] = useState<string[]>([])
  const [showSearchDirections, setShowSearchDirections] = useState(false)
  const [loading, setLoading] = useState(false)
  const [topics, setTopics] = useState<ExtendedTopic[]>([])
  // The server-stored id of the CURRENTLY DISPLAYED result set -- the only
  // thing the client sends to resolve an evidence snapshot server-side
  // (see lib/opportunity-evidence/evidence-service.ts). Null whenever the
  // current topics came from a source with no stable paid_results row (e.g.
  // cache_only miss with a live candidate preview). MUST be kept in sync
  // with `topics`/`poolTopics` by every setter of those two -- every call
  // site below either sets it alongside them or explicitly resets it to
  // null, so a stale id from a PREVIOUS result set can never be sent for a
  // DIFFERENT, currently displayed one. A null value no longer causes a
  // silent no-evidence continuation (2026-09-29 QA finding): TopicCard/
  // DiscoveryLaneCard's "Készíts csomagot" surfaces an explicit "Folytatás
  // bizonyíték nélkül" choice instead -- see topic-cards.tsx.
  const [lastPaidResultId, setLastPaidResultId] = useState<string | null>(null)
  const [poolTopics, setPoolTopics] = useState<ExtendedTopic[]>([])
  const [cached, setCached] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Három, egymástól független "nincs friss találat" forrás (PFM-2E, production
  // incidens utáni korrekció): a paid_results hash-találat lejárt mentése
  // ('saved_paid_result', van explicit paid_result_id az újranyitáshoz), az
  // opportunity_cache 7 napos, nap-váltás-toleráns fallback lejárt találata
  // ('opportunity_cache', nincs stabil, kliensnek átadott azonosítója — csak
  // metaadat, tartalom nélkül), és a teljes cache-miss ('miss', se paid_results,
  // se opportunity_cache találat). Mindhárom ugyanazt a banner-UI-t használja,
  // a "Korábbi eredmény megnyitása" gomb csak a paid_result-ágon jelenik meg —
  // egyik ág sem indít automatikus keresést, csak explicit CTA-t mutat.
  const [staleState, setStaleState] = useState<
    | { kind: 'saved_paid_result'; paidResultId: string; niche: string }
    | { kind: 'opportunity_cache'; niche: string }
    | { kind: 'miss'; niche: string }
    | null
  >(null)
  const [activeDrilldown, setActiveDrilldown] = useState<string | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const [pendingGenerate, setPendingGenerate] = useState<{ profile?: CreatorProfile; options?: Record<string, unknown> } | null>(null)
  const [replaceCreditCheck, setReplaceCreditCheck] = useState<UsageCheckResult | null>(null)
  const [pendingReplaceIndex, setPendingReplaceIndex] = useState<number | null>(null)
  const replaceInFlightRef = useRef(false)
  // Mount-effekt egyszeri-futás védelem (PFM-2E production incidens, defense-
  // in-depth) — még ha a komponens valamilyen jövőbeli okból kétszer futtatná
  // az effektet, az init() törzse csak egyszer indulhat el.
  const initRanRef = useRef(false)
  // A generate() (a tényleges /api/opportunity hívás) egyetlen belépési pontja
  // minden hívónak (mount-CTA, "Friss keresés", CreditConfirmModal onConfirm,
  // drilldown, "Mutass mást" stb.) — ez a ref garantálja, hogy egy adott
  // pillanatban legfeljebb EGY ilyen hívás lehet folyamatban, duplakattintás
  // vagy véletlen kétszeri meghívás esetén a második csendben no-op.
  const generateInFlightRef = useRef(false)

  // Cache_only lekérdezés + stale/miss állapot beállítása, tartalom nélküli
  // visszajátszás nélkül — mindkét mount-ág (nicheParam-os deep-link ÉS a sima
  // profil-niche-es közvetlen oldalbetöltés) ugyanezt a függvényt használja.
  // Visszatérési érték: true = talált és megjelenített valamit (fresh vagy
  // stale/miss állapotot állított be), false = a hívónak kell eldöntenie mi
  // történjen (ez a jelenlegi kódban sosem fordul elő, mindig true-t ad).
  async function tryCacheOnlyLookup(
    nicheValue: string,
    prof: CreatorProfile | null,
    explicitPaidResultId?: string,
  ): Promise<boolean> {
    // Defense-in-depth: sose maradjon bent egy KORÁBBI hívásból származó
    // paid_result azonosító, mielőtt ennek a hívásnak a saját (esetleg
    // hiányzó) eredménye eldőlne -- ld. a "Készíts csomagot" gomb 2026-09-29
    // QA-n talált csendes bizonyíték-nélküli-navigáció hibáját lejjebb.
    setLastPaidResultId(null)
    try {
      const cacheRes = await fetch('/api/opportunity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          niche: nicheValue, platform: prof?.platform || 'youtube',
          language: prof?.language || 'hu', region: prof?.region || 'HU',
          main_category: prof?.main_category, specific_focus: prof?.specific_focus,
          cache_only: true,
          paidResultId: explicitPaidResultId || undefined,
        }),
      })
      const cacheData: OpportunityApiResponse = await cacheRes.json()
      if (cacheRes.ok && (cacheData.cached || cacheData.from_paid_result) && ((cacheData.topics?.length || 0) > 0 || (cacheData.pool_topics?.length || 0) > 0)) {
        setTopics(cacheData.topics || [])
        setPoolTopics(cacheData.pool_topics || [])
        setCached(true)
        // A hiányzó sor volt a gyökérok: a paidResultId-vel történő explicit
        // történeti újranyitás (openStaleSavedResult "testvér" útja) a
        // topics/poolTopics-ot beállította, de a TopicCard/DiscoveryLaneCard-
        // nak átadott paidResultId prop -- ami a "Készíts csomagot" szerver-
        // oldali bizonyíték-feloldásához kell -- null maradt. Enélkül a gomb
        // csendben a régi, bizonyíték nélküli útra esett vissza egy olyan
        // eredménynél is, aminek ténylegesen van szerveroldali snapshotja.
        setLastPaidResultId(cacheData.paid_result_id || null)
        return true
      }
      // Lejárt mentett/cache-elt eredmény VAGY teljes cache-miss: NE induljon
      // automatikusan friss keresés — csak jelezzük az állapotot, a
      // nyitást/frissítést explicit user-akcióra (a banner "Friss keresés"
      // gombjára) bízzuk. (PFM-2E production incidens korrekció: korábban a
      // sima, paraméter nélküli oldalbetöltés ÉS a nicheParam-os deep-link
      // "nincs cache" ága is automatikusan meghívta a
      // handleGenerateWithCreditCheck-et — ez élesben egy heti ingyenes futás
      // csendes, kattintás nélküli lefutásához vezetett.)
      if (cacheRes.ok && cacheData.stale_saved_available && cacheData.paid_result_id) {
        setStaleState({ kind: 'saved_paid_result', paidResultId: cacheData.paid_result_id, niche: nicheValue })
        return true
      }
      if (cacheRes.ok && cacheData.stale_cache_available) {
        setStaleState({ kind: 'opportunity_cache', niche: nicheValue })
        return true
      }
    } catch {}
    setStaleState({ kind: 'miss', niche: nicheValue })
    return true
  }

  // Keresési előzmény visszaállítása — de ha a profil niche változott, újra keresünk
  useEffect(() => {
    if (initRanRef.current) return
    initRanRef.current = true

    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data: prof } = await supabase.from('profiles').select('*').eq('user_id', user.id).single()
      if (prof) {
        setProfile(prof)
        setNiche(prof.niche || '')
      }

      // Ha highlight candidateId jött a dashboardról, azt mutassuk elsőnek
      if (highlightId) {
        try {
          const raw = sessionStorage.getItem('willviral_highlight_candidate')
          if (raw) {
            const candidate = JSON.parse(raw) as ExtendedTopic
            setHighlightTopic(candidate)
            setTopics([candidate])
            // Élő, dashboard-átadott jelölt -- nincs hozzá saját paid_results
            // sor, tehát nincs szerveroldali bizonyíték-pointer sem.
            setLastPaidResultId(null)
            setNiche(prof?.niche || '')
            return
          }
        } catch {}
      }

      // Ha a "Legutóbbi történeted" panelről érkezünk egy korábbi niche-szel,
      // ingyenesen megnézzük (cache_only), van-e még érvényes mentett vagy
      // cache-elt eredmény. Se automatikus friss keresés, se kredit-ellenőrzés
      // nem indul itt — csak a tryCacheOnlyLookup fresh/stale/miss állapota.
      if (nicheParam) {
        setNiche(nicheParam)
        await tryCacheOnlyLookup(nicheParam, prof, paidResultId)
        return
      }

      const saved = sessionStorage.getItem('willviral_opportunities_state')
      if (saved) {
        try {
          const state = JSON.parse(saved)
          // Ha a profil niche megváltozott, a cache érvénytelen
          if (state.niche && prof?.niche && state.niche.toLowerCase() !== prof.niche.toLowerCase()) {
            sessionStorage.removeItem('willviral_opportunities_state')
          } else if (state.topics?.length > 0) {
            setNiche(state.niche || prof?.niche || '')
            setTopics(state.topics)
            setPoolTopics(state.poolTopics || [])
            if (state.message) setMessage(state.message)
            if (state.activeDrilldown) setActiveDrilldown(state.activeDrilldown)
            return
          }
        } catch {}
      }

      if (prof?.niche) {
        // PFM-2E production incidens korrekció: a közvetlen, paraméter nélküli
        // oldalbetöltés SOHA nem hívhatja automatikusan a
        // handleGenerateWithCreditCheck-et, mert az — ha volt még heti
        // ingyenes futás — megerősítés nélkül azonnal valódi keresést
        // indított élesben. Csak cache_only:true lekérdezés; fresh/stale/miss
        // esetén a felhasználónak explicit CTA-t (banner "Friss keresés"
        // gombja) kell megnyomnia a friss kereséshez.
        await tryCacheOnlyLookup(prof.niche, prof)
      }
    }
    init()
  }, [])

  // Korábban elmentett témák felismerése — a "Mentés a memóriába" gomb
  // (TopicCard) számára megosztott, szülőben tartott igazság, hogy (1)
  // duplikált kártyák ugyanazt a mentett állapotot lássák, és (2) egy
  // korábbi munkamenetben/oldalfrissítés előtt elmentett téma is eleve
  // "Mentve"-ként jelenjen meg, új POST /api/memory nélkül.
  //
  // Egyetlen, könnyű, read-only batch lekérdezés (POST /api/memory/
  // saved-lookup, ld. lib/creator-lane/memory-save-client.ts
  // fetchSavedStatusForTopics()) — KIZÁRÓLAG az aktuálisan látható (validált,
  // nem discovery-lane) Opportunity-témákat kérdezi le, nem a user teljes
  // Memory-előzményét, ezért helyes marad függetlenül attól, hány összesen
  // mentett rekordja van a usernek (nincs "legutóbbi 200" torzítás). Minden
  // alkalommal újrafut, amikor a `topics` lista megváltozik (friss keresés,
  // "Mutass mást", drilldown stb.) — ettől függetlenül is EGYETLEN batch
  // kérés kártyánkénti N+1 helyett.
  //
  // Explicit loading/ready/error állapotgép (NEM csendes ok:false + üres
  // Set) — amíg 'ready' nem igaz, EGYETLEN kártya mentés-gombja sem engedi a
  // POST-ot (ld. TopicCard handleSave() saveGateReady őre), így egy
  // lookup-hiba SOSE eredményezhet felesleges/duplikált POST-ot egy
  // valójában már elmentett témára. 'error' esetén a felhasználó explicit
  // "Újrapróbálás"-sal indíthatja újra — a retry KIZÁRÓLAG ezt a read-only
  // lookupot ismétli, semmi mást.
  const [alreadySavedTopics, setAlreadySavedTopics] = useState<Set<string>>(() => new Set())
  const [savedLookupState, setSavedLookupState] = useState<'loading' | 'ready' | 'error'>('loading')
  // A React ref maga `{ current: number }` alakú — ugyanaz az objektum-
  // referencia él a komponens teljes élettartama alatt, ezért közvetlenül
  // átadható a React-mentes runSavedLookupCoordinated()-nek trackerként (a
  // request-ID mind a két oldalon ugyanazt az egy számlálót látja/módosítja).
  const savedLookupRequestIdRef = useRef(0)

  async function runSavedLookup(currentTopics: ExtendedTopic[]) {
    const visibleKeys = Array.from(new Set(
      currentTopics
        .filter(t => !isDiscoveryLane(t))
        .map(t => normalizeTopicKey(t.title))
        .filter(key => key.length > 0),
    ))
    // A tényleges request-ID kezelés és a race-védelem (üres-listás ág is
    // invalidál, csak a legfrissebb hívás eredménye íródhat vissza) a
    // lib/creator-lane/saved-lookup-coordinator.ts-ben él — kiszervezve,
    // React-mentesen, determinisztikus deferred-Promise teszttel bizonyítva
    // (ld. tests/saved-lookup-coordinator.test.ts).
    await runSavedLookupCoordinated(visibleKeys, savedLookupRequestIdRef, {
      onLoading: () => setSavedLookupState('loading'),
      onReady: newlySavedTopics => {
        setAlreadySavedTopics(prev => new Set([...prev, ...newlySavedTopics]))
        setSavedLookupState('ready')
      },
      onError: () => setSavedLookupState('error'),
    }, fetchSavedStatusForTopics)
  }

  useEffect(() => {
    runSavedLookup(topics)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topics])

  function retrySavedLookup() {
    runSavedLookup(topics)
  }

  // A TopicCard handleSave()-je hívja meg valódi, szerver által visszaigazolt
  // mentés után — SOSE optimistán, POST előtt.
  function markTopicSaved(topicKey: string) {
    setAlreadySavedTopics(prev => (prev.has(topicKey) ? prev : new Set(prev).add(topicKey)))
  }

  function getCacheKey(nicheVal: string, platform: string, region: string) {
    return `willviral_opportunities_v10_consistency_${nicheVal}_${platform}_${region}`.toLowerCase().replace(/\s+/g, '_')
  }

  // "Mutass mást" / "Mutass hasonlót" után a topics tömb frissül a memóriában,
  // de enélkül a sessionStorage-beli állapot a régi maradna — refresh után a
  // user elveszítené a fizetett eredményt. A tényleges kredit-védelem szerver
  // oldali (input_hash + paid_results), ez csak a böngészős folytonosságot adja.
  function persistTopicsState(updatedTopics: ExtendedTopic[], updatedPool: ExtendedTopic[]) {
    try {
      sessionStorage.setItem('willviral_opportunities_state', JSON.stringify({
        niche, topics: updatedTopics, poolTopics: updatedPool, message, activeDrilldown,
      }))
    } catch {}
  }

  function handleSimilarResult(index: number, result: { title: string; description: string }) {
    setTopics(prev => {
      if (!prev[index]) return prev
      const updated = [...prev]
      updated[index] = { ...updated[index], title: result.title, description: result.description }
      persistTopicsState(updated, poolTopics)
      return updated
    })
  }

  async function handleGenerateWithCreditCheck(p?: CreatorProfile, options?: { discoveryMode?: 'drilldown'; parentNiche?: string; skipCache?: boolean }) {
    try {
      const checkRes = await fetch('/api/credit-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: 'opportunity_engine' }),
      })
      const check = await checkRes.json() as UsageCheckResult

      if (!check.canRun) {
        setCreditCheck(check)
        return
      }
      if (check.requiresConfirmation) {
        setPendingGenerate({ profile: p || undefined, options: { ...options, confirmed: true } })
        setCreditCheck(check)
        return
      }
    } catch {}

    generate(p, options)
  }

  async function generate(p?: CreatorProfile, options?: { discoveryMode?: 'drilldown'; parentNiche?: string; skipCache?: boolean; confirmed?: boolean }) {
    // Egyetlen belépési pont a tényleges /api/opportunity hívásra minden
    // hívó számára — duplakattintás vagy véletlen kétszeri meghívás esetén a
    // második próbálkozás csendben no-op (PFM-2E production incidens,
    // defense-in-depth kliensoldali deduplikáció).
    if (generateInFlightRef.current) return
    const prof = p || profile
    const nicheToUse = p?.niche || niche
    // discovery_random módban nem kötelező a szöveges input — a szerver a
    // profil/csatorna-jelekből választ kiindulási irányt.
    if (searchMode !== 'discovery_random' && !nicheToUse.trim()) return
    generateInFlightRef.current = true

    setLoading(true)
    setError(null)
    setMessage(null)

    try {
      const res = await fetch('/api/opportunity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          search_mode: searchMode,
          niche: searchMode === 'specific_topic' ? undefined : nicheToUse,
          topic: searchMode === 'specific_topic' ? nicheToUse : undefined,
          avoid_topics: searchMode === 'discovery_random' ? (discoveryGoal || undefined) : undefined,
          use_channel_signals: searchMode === 'discovery_random' ? useChannelSignals : undefined,
          platform: prof?.platform || 'youtube',
          language: prof?.language || 'hu', region: prof?.region || 'HU',
          creator_level: prof?.creator_level || 'growing',
          channel_usage_mode: prof?.channel_usage_mode,
          discovery_mode: options?.discoveryMode,
          parent_niche: options?.parentNiche,
          // A user már jóváhagyta a levonást a CreditConfirmModalban — csak ekkor
          // szabad a szervernek ténylegesen kreditet vonnia (force_refresh jelzi ezt).
          force_refresh: options?.confirmed === true,
          paidResultId: paidResultId || undefined,
        }),
      })
      const data: OpportunityApiResponse = await res.json()
      if (!res.ok) { setError(data.error || null); return }
      setSearchDirections(Array.isArray(data.search_directions) ? data.search_directions : [])

      // Van elég kredit, de a user MÉG NEM erősítette meg — mutassuk a modalt,
      // ne induljon el semmi kreditlevonás felugró jóváhagyás nélkül.
      if (data.needs_confirmation) {
        const creditSnapshot = await refreshCredits()
        if (!creditSnapshot) {
          setError('A kreditegyenleg most nem ellenőrizhető. Próbáld újra.')
          return
        }
        setLoading(false)
        setPendingGenerate({ profile: prof || undefined, options: { ...options, confirmed: true } })
        setCreditCheck({
          feature: 'Videólehetőségek',
          cost: data.confirmation_cost || 2,
          currency: 'credit',
          currentCredits: creditSnapshot.balance,
          remainingCreditsAfterRun: Math.max(0, creditSnapshot.balance - (data.confirmation_cost || 2)),
          requiresConfirmation: true,
          canRun: true,
          message: data.message || 'A heti ingyenes Top Opportunity ajánlásod már megvan. Ez az extra keresés kreditbe kerül.',
        })
        return
      }
      setMessage(data.message || null)
      publishCreditMutationCompleted('/api/opportunity', data)
      setTopics(data.topics || [])
      setPoolTopics(data.pool_topics || [])
      setCached(data.cached || false)
      setLastPaidResultId(data.paid_result_id || null)

      // Mentés sessionStorage-ba — böngésző vissza gomb támogatás
      sessionStorage.setItem('willviral_opportunities_state', JSON.stringify({
        niche: nicheToUse,
        topics: data.topics || [],
        poolTopics: data.pool_topics || [],
        message: data.message || null,
        activeDrilldown: options?.discoveryMode === 'drilldown' ? nicheToUse : null,
        parentNiche: options?.parentNiche || null,
      }))

      if (!options?.skipCache && data.topics && data.topics.length > 0) {
        const cacheKey = getCacheKey(nicheToUse, prof?.platform || 'youtube', prof?.region || 'HU')
        sessionStorage.setItem(cacheKey, JSON.stringify({
          topics: data.topics,
          pool_topics: data.pool_topics || [],
          timestamp: Date.now(),
        }))
      }
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setLoading(false)
      generateInFlightRef.current = false
    }
  }

  // Korábbi (lejárt) mentett paid_results eredmény explicit megnyitása
  // paidResultId-vel — frissségtől függetlenül, keresés és kreditművelet
  // nélkül (PFM-2E, döntés #1). Az opportunity_cache stale ágnak NINCS
  // ilyen stabil, kliensnek átadott azonosítója — ott csak a "Friss keresés"
  // CTA érhető el (ld. startFreshSearchFromStale).
  async function openStaleSavedResult() {
    if (!staleState || staleState.kind !== 'saved_paid_result') return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/opportunity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          niche: staleState.niche,
          paidResultId: staleState.paidResultId,
          cache_only: true,
        }),
      })
      const data: OpportunityApiResponse = await res.json()
      if (!res.ok) { setError(data.error || 'Nem sikerült megnyitni a korábbi eredményt.'); return }
      setTopics(data.topics || [])
      setPoolTopics(data.pool_topics || [])
      setCached(true)
      setLastPaidResultId(data.paid_result_id || staleState.paidResultId || null)
      setStaleState(null)
    } catch {
      setError('Kapcsolati hiba.')
    } finally {
      setLoading(false)
    }
  }

  function startFreshSearchFromStale() {
    // A `niche` állapot ekkor már a nicheParam-ra van állítva (ld. init()),
    // ezért a generate() saját `p?.niche || niche` fallbackja a helyes témát
    // választja a profil explicit felülírása nélkül.
    setStaleState(null)
    void handleGenerateWithCreditCheck(profile || undefined)
  }

  // "Mutass mást" csak akkor kér kredit-megerősítést, ha a pool következő
  // tagjához tényleg fizetős AI-magyarázat kell (needs_explanation) — ha a
  // pool elem már kész, a csere ingyenes és azonnali, modal nélkül.
  async function handleReplace(index: number) {
    if (poolTopics.length === 0 || replaceInFlightRef.current) return
    const next = poolTopics[0]

    if (!next.needs_explanation) {
      await performReplace(index, next)
      return
    }

    replaceInFlightRef.current = true
    try {
      const credits = await refreshCredits()
      if (!credits) throw new Error('credit_balance_unavailable')
      const balance = credits.balance
      const cost = 1
      setPendingReplaceIndex(index)
      setReplaceCreditCheck({
        feature: 'Mutass mást',
        cost,
        currency: 'credit',
        currentCredits: balance,
        remainingCreditsAfterRun: balance - cost,
        requiresConfirmation: true,
        canRun: balance >= cost,
        reason: balance >= cost ? undefined : 'insufficient_credits',
        message: balance >= cost
          ? 'Egy másik, konkrét témajavaslatot kérünk. Ha korábban már lekérted ugyanezt, nem vonunk le új kreditet.'
          : 'Ehhez nincs elég kredited.',
      })
    } catch {
      replaceInFlightRef.current = false
      await performReplace(index, next)
    }
  }

  async function performReplace(index: number, next: ExtendedTopic) {
    const remainingPool = poolTopics.slice(1)
    let finalTopic = next
    if (next.needs_explanation) {
      try {
        const res = await fetch('/api/opportunity-explain', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keyword: next.keyword, niche: next.niche,
            score_breakdown: next.score_breakdown, evidence_videos: next.evidence_videos,
          }),
        })
        const data = await res.json()
        if (res.ok) {
          publishCreditMutationCompleted('/api/opportunity-explain', data)
          finalTopic = { ...next, title: data.title, description: data.description, needs_explanation: false }
        } else {
          setError(res.status === 402 ? (data.error || 'Nincs elegendő kredited ehhez a művelethez.') : (data.error || 'Nem sikerült másik témát találni — próbáld újra.'))
          setPendingReplaceIndex(null)
          replaceInFlightRef.current = false
          return
        }
      } catch {
        setError('Kapcsolati hiba — próbáld újra.')
        setPendingReplaceIndex(null)
        replaceInFlightRef.current = false
        return
      }
    }
    setTopics(prev => {
      const updated = [...prev]
      updated[index] = finalTopic
      persistTopicsState(updated, remainingPool)
      return updated
    })
    setPoolTopics(remainingPool)
    setPendingReplaceIndex(null)
    replaceInFlightRef.current = false
  }

  return (
    <div className="max-w-3xl mx-auto">
      {creditCheck && (
        <CreditConfirmModal
          check={creditCheck}
          onConfirm={() => {
            setCreditCheck(null)
            if (pendingGenerate) {
              generate(pendingGenerate.profile, pendingGenerate.options as { discoveryMode?: 'drilldown'; parentNiche?: string; skipCache?: boolean })
              setPendingGenerate(null)
            }
          }}
          onCancel={() => { setCreditCheck(null); setPendingGenerate(null) }}
          loading={loading}
        />
      )}
      {replaceCreditCheck && (
        <CreditConfirmModal
          check={replaceCreditCheck}
          onConfirm={() => {
            setReplaceCreditCheck(null)
            if (pendingReplaceIndex !== null && poolTopics.length > 0) {
              performReplace(pendingReplaceIndex, poolTopics[0])
            }
          }}
          onCancel={() => { setReplaceCreditCheck(null); setPendingReplaceIndex(null); replaceInFlightRef.current = false }}
          loading={pendingReplaceIndex !== null}
        />
      )}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary mb-1">Videólehetőségek</h1>
        <p className="text-text-secondary text-sm">Forrásokkal és YouTube-jelekkel validált creator témaajánlások.</p>
      </div>

      {profile && (
        <div className="card mb-4" style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)' }}>
          <div className="flex items-center justify-between">
            <div className="flex gap-4 text-sm">
              <span className="text-text-muted">Niche: <span className="text-text-primary font-medium">{profile.niche || '—'}</span></span>
              <span className="text-text-muted">Platform: <span className="text-text-primary font-medium">{platformLabel(profile.platform)}</span></span>
              <span className="text-text-muted">Régió: <span className="text-text-primary font-medium">{regionLabel(profile.region)}</span></span>
            </div>
            <a href="/dashboard/profile" className="text-xs" style={{ color: '#3B82F6' }}>Szerkesztés →</a>
          </div>
        </div>
      )}

      <div className="card mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
          {([
            { value: 'niche_based' as const, label: 'Niche alapján keresek', desc: 'A WillViral a profilod vagy megadott niche-ed alapján keres validált videólehetőségeket.' },
            { value: 'specific_topic' as const, label: 'Konkrét témát ellenőrzök', desc: 'Megnézzük, hogy egy adott téma mögött van-e elég YouTube- és webes bizonyíték.' },
            { value: 'discovery_random' as const, label: 'Új ötleteket kérek', desc: 'A WillViral új témákat javasol a profilod, csatornaadataid és trendjelek alapján.' },
          ]).map(mode => (
            <button key={mode.value} type="button" onClick={() => setSearchMode(mode.value)}
              className="text-left p-3 rounded-xl transition-all"
              style={searchMode === mode.value
                ? { background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.4)' }
                : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="text-sm font-semibold text-text-primary">{mode.label}</div>
              <div className="text-xs text-text-muted mt-0.5">{mode.desc}</div>
            </button>
          ))}
        </div>

        {searchMode !== 'discovery_random' && (
          <div className="flex gap-3">
            <input value={niche} onChange={e => setNiche(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleGenerateWithCreditCheck()}
              placeholder={searchMode === 'specific_topic' ? 'pl. AI-alapú rákdiagnózis, otthoni edzés kezdőknek...' : 'pl. egészség, tech, pénzügy, sport...'}
              className="input flex-1" />
            <button onClick={() => handleGenerateWithCreditCheck()} disabled={loading || !niche.trim()} className="btn-primary px-6 whitespace-nowrap">
              {loading ? 'Keresés...' : searchMode === 'specific_topic' ? 'Konkrét téma ellenőrzése' : 'Videólehetőségek keresése a niche alapján'}
            </button>
          </div>
        )}

        {searchMode === 'discovery_random' && (
          <div className="space-y-3">
            <div className="flex gap-3">
              <input value={discoveryGoal} onChange={e => setDiscoveryGoal(e.target.value)}
                placeholder="Opcionális: mit szeretnél elkerülni vagy milyen célod van? (pl. ne legyen politika)"
                className="input flex-1" />
              <button onClick={() => handleGenerateWithCreditCheck()} disabled={loading} className="btn-primary px-6 whitespace-nowrap">
                {loading ? 'Keresés...' : 'Új ötleteket kérek'}
              </button>
            </div>
            {profile?.channel_connection_type && (
              <label className="flex items-center gap-2 text-xs text-text-muted">
                <input type="checkbox" checked={useChannelSignals} onChange={e => setUseChannelSignals(e.target.checked)} />
                Csatornajelek használata (a felismert niche-jelöltjeid alapján is javasoljon)
              </label>
            )}
          </div>
        )}
        {cached && (
          <div className="flex items-center justify-between mt-2">
            <p className="text-text-muted text-xs flex items-center gap-1">
              <span>⚡</span> Mentett eredmény betöltve
            </p>
            <button onClick={() => {
              Object.keys(sessionStorage)
                .filter(key => key.startsWith('willviral_opportunities_'))
                .forEach(key => sessionStorage.removeItem(key))
              setCached(false)
              handleGenerateWithCreditCheck()
            }} className="text-xs" style={{ color: '#3B82F6' }}>
              ↻ Extra friss keresés
            </button>
          </div>
        )}
      </div>

      {searchDirections.length > 0 && searchMode !== 'specific_topic' && (
        <div className="mb-6 rounded-2xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <button onClick={() => setShowSearchDirections(!showSearchDirections)} className="w-full flex items-center justify-between">
            <span className="text-sm font-semibold flex items-center gap-2 text-text-primary">
              <i className="ti ti-route" style={{ color: '#94A3B8' }} />
              Vizsgált keresési irányok ({searchDirections.length})
            </span>
            <i className={`ti ${showSearchDirections ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ color: '#64748B' }} />
          </button>
          {showSearchDirections && (
            <div className="mt-3 flex flex-wrap gap-2">
              {searchDirections.map((direction, i) => (
                <span key={i} className="text-xs px-2.5 py-1 rounded-full" style={{ background: 'rgba(59,130,246,0.08)', color: '#93C5FD' }}>
                  {direction}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {staleState && (
        <div className="rounded-xl px-5 py-4 mb-6 text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          style={{ background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.2)', color: '#CBD5E1' }}>
          <span>
            {staleState.kind === 'saved_paid_result'
              ? 'A korábbi eredményed elérhető, de már nem számít frissnek.'
              : staleState.kind === 'opportunity_cache'
              ? 'Korábbi, már nem friss cache-elt ajánlásod volt ehhez a témához.'
              : 'Még nincs validált ajánlásod ehhez a témához.'}
          </span>
          <div className="flex gap-2 flex-shrink-0">
            {staleState.kind === 'saved_paid_result' && (
              <button onClick={openStaleSavedResult} disabled={loading} className="btn-secondary text-xs whitespace-nowrap px-3 py-2">
                Korábbi eredmény megnyitása
              </button>
            )}
            <button onClick={startFreshSearchFromStale} disabled={loading} className="btn-primary text-xs whitespace-nowrap px-3 py-2">
              Friss keresés
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="bg-rose/10 border border-rose/20 rounded-xl px-5 py-4 text-rose text-sm mb-6">{error}</div>
      )}
      {message && (
        <div className="rounded-xl px-5 py-4 mb-6 text-sm"
          style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)', color: '#F59E0B' }}>
          {message}
        </div>
      )}

      {savedLookupState === 'error' && (
        <div className="rounded-xl px-4 py-3 mb-6 text-sm flex items-center justify-between gap-3"
          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#FCA5A5' }}>
          <span>Nem sikerült ellenőrizni, mely témák vannak már elmentve — a mentés gombok átmenetileg nem használhatók.</span>
          <button type="button" onClick={retrySavedLookup}
            className="text-xs px-3 py-1.5 rounded-lg whitespace-nowrap"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#FCA5A5' }}>
            Újrapróbálás
          </button>
        </div>
      )}

      {loading && (
        <div className="card">
          <LoadingScreen steps={LOADING_STEPS.opportunity} message="Forrásokat, YouTube-jeleket és piaci rést ellenőrzünk" />
        </div>
      )}

      {!loading && topics.length > 0 && (() => {
        const validatedTopics = topics.filter(t => !isDiscoveryLane(t))
        const discoveryTopics = topics.filter(t => isDiscoveryLane(t))

        function handleDiscoverySearch(keyword: string) {
          setNiche(keyword)
          setActiveDrilldown(keyword)
          handleGenerateWithCreditCheck(
            { ...profile!, niche: keyword },
            { discoveryMode: 'drilldown', parentNiche: profile?.niche || niche, skipCache: true },
          )
        }

        return (
          <div className="space-y-6">
            {activeDrilldown && (
              <div className="rounded-xl px-4 py-3 text-sm flex items-center justify-between gap-3"
                style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', color: '#BFDBFE' }}>
                <span>Konkrét témakeresés ebben az irányban: <strong>{activeDrilldown}</strong></span>
                <button onClick={() => { setActiveDrilldown(null); if (profile?.niche) { setNiche(profile.niche); handleGenerateWithCreditCheck(profile, { skipCache: true }) } }}
                  className="text-xs px-3 py-1 rounded-lg"
                  style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#3B82F6' }}>
                  Vissza a niche-hez
                </button>
              </div>
            )}

            {validatedTopics.length > 0 && (
              <div>
                <p className="section-label mb-4">{validatedTopics.length} gyártható vagy korai lehetőség - WillViral sorrendben</p>
                {validatedTopics.every(t => t.confidence === 'alacsony' || t.confidence === 'nagyon_alacsony') && (
                  <div className="rounded-xl px-4 py-3 mb-4 text-sm"
                    style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#F59E0B' }}>
                    Kevés friss adat alapján számolva. Extra kereséssel vagy pontosabb niche-sel erősebb validáció kérhető.
                  </div>
                )}
                <div className="space-y-3">
                  {validatedTopics.map((topic, i) => (
                    <TopicCard key={topic.id} topic={topic} index={i} onReplace={handleReplace} onSimilarResult={handleSimilarResult} hasPool={poolTopics.length > 0} replacing={pendingReplaceIndex === i} alreadySavedTopics={alreadySavedTopics} onTopicSaved={markTopicSaved} saveGateReady={savedLookupState === 'ready'} paidResultId={lastPaidResultId} />
                  ))}
                </div>
              </div>
            )}

            {discoveryTopics.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-sm" style={{ color: '#CBD5E1' }}>🧭</span>
                  <p className="section-label">Validálásra váró kutatási irányok</p>
                </div>
                <p className="text-xs mb-4" style={{ color: '#94A3B8' }}>
                  Ezek még nem kész gyártási ajánlások. A rendszer azért mutatja őket, mert a niche-en belül van témairány, de előbb konkrétabb forrásos témát kell keresni belőle.
                </p>
                <div className="space-y-2">
                  {discoveryTopics.map(topic => (
                    <DiscoveryLaneCard key={topic.id} topic={topic} onSearch={handleDiscoverySearch} paidResultId={lastPaidResultId} />
                  ))}
                </div>
              </div>
            )}

            {validatedTopics.length === 0 && discoveryTopics.length > 0 && (
              <div className="rounded-xl px-4 py-3 text-sm"
                style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#F59E0B' }}>
                Ezen a keresésen most nincs elég erős gyártható téma. A kutatási irányokból egy kattintással konkrétabb, validálható témákat kereshetsz.
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}
