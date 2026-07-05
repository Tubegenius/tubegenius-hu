# WILLVIRAL — CLAUDE CODE HANDOVER DOKUMENTUM
# Dátum: 2026-07-03
# Cél: Következő session kontextus átadás

---

## PROJEKT ÖSSZEFOGLALÓ

WillViral = magyar Creator Intelligence Platform
Lokáció: C:\Projektek\WillViralFinal
Stack: Next.js 14.2, React, Tailwind CSS, Supabase (sdvqzrcdvdtozfpjhnkh, eu-west-1), Anthropic Claude API, YouTube Data API v3, Serper API, Stripe
GitHub: github.com/Tubegenius/tubegenius-hu
Domain: willviral.com — megvéve, még nem deployolva
Modellek: lib/models.ts — primary: claude-sonnet-4-6, fast: claude-haiku-4-5-20251001

## MI A WILLVIRAL?

Nem sima AI-wrapper. Core Trust Engine — minden állítás mögött valódi validáció (YouTube/Serper adat), nem LLM-hallucináció. Fő funkciók: Trend Feed (napi ajánlás), Opportunity Engine (téma-elemzés), Similar Videos, Video Package Generator (Fact Safety Layer), Video Audit, Creator Memory.

## BUILD ÁLLAPOT

`npx tsc --noEmit` — 0 hiba (ellenőrizve a session végén).

## ⚠️ GIT ÁLLAPOT — ELSŐ TEENDŐ A KÖVETKEZŐ SESSIONBEN

**Minden a mai session commitja LOKÁLIS, még NINCS push-olva.** A user explicit kérte, hogy ne push-oljunk, amíg ő nem szól.

Legutóbbi commitok (időrendben, legrégebbi elöl a mai session-ből):
```
4bd49b4 fix: structured niche input, Serper reliability, Haiku topic rewrite fallback
1a5c893 feat: richer Overview dashboard visuals, fix free-quota bypass on Opportunity Engine
58cc615 fix: never charge credits without explicit user confirmation
9385c2a feat: show real product activity (not raw credit logs) with trend evolution
b0fc888 fix: rename activity panel to "Legutóbbi történeted", deep-link to saved content
75ceaa6 feat: add real sparkline charts for trend history across the Overview page
746c64c feat: make tracked trend topic cards openable
90e0942 fix: Similar Videos auto-search-on-load could silently charge credits
df066af feat: persistent Similar Videos result cache — reopening a paid search is free
cd1641a fix: "Videók megnyitása" on tracked trends now free (reads already-known data)
fa5dd47 feat: show thumbnails in the free tracked-trend video list
35542fa fix: Trend Feed free quota was weekly instead of daily, add daily history view
e640440 fix: "Részletek" on Top lehetőségek cards was skipping sessionStorage highlight save
```

**FONTOS — nincs commitolva, félbehagyott munka:**
```
 M app/api/dashboard/tracked-trends/videos/route.ts
 M components/dashboard/TrackedTrendsPanel.tsx
 M lib/trend-tracking.ts
```
Ez egy megkezdett, **be nem fejezett** feature: a user kérte, hogy a "Videók megnyitása" gomb mellett a **web forrás (Serper) alátámasztást** is lehessen megnyitni (nem csak videót), és a gomb elnevezését is át kellene gondolni ("ez a gomb nyitja meg az alátámasztást a témának, nem minden téma mögött van videó, van ami csak web-forrással van alátámasztva"). Ez a munka MEGSZAKADT, mert közben a user egy sürgősebb hibát jelentett (napi ingyenes keret). **A következő session-ben vagy fejezd be ezt, vagy `git checkout` -tal dobd el, ha nem releváns már.**

~45 db régi `willviral-*-patch*` / scratch mappa továbbra is szétszórva van (untracked, git status zajong tőle) — nem része az élő appnak, törlésre/`.gitignore`-ra vár.

---

## 🔴 MAI SESSION (2026-07-03) — MIT CSINÁLTUNK

Ez egy nagyon hosszú, sok apró (de valós, élesben tesztelt) hibajavításból álló session volt. Fő témák:

### 1. Creator Intelligence Overview Dashboard (új "Áttekintés" fül)
- Teljesen új főoldal (`/dashboard/overview`, `components/dashboard/OverviewClient.tsx`) — KPI kártyák, "Top lehetőségek most" (`TopOpportunitiesRow.tsx`), "Legutóbbi történeted" táblázat (`CreatorIntelligenceSummary.tsx`), "Követett trendtémák" panel (`TrackedTrendsPanel.tsx`), sparkline grafikonok (`Sparkline.tsx`), audit átlagpontszám gauge.
- A régi Trend Feed (`/dashboard`, `DashboardClient.tsx`) mostantól CSAK a napi javasolt témát mutatja — minden más info átköltözött az Áttekintésre.
- **Elv:** csak valós DB-adatból építkezik, nincs mock/kamu adat sehol.

### 2. Limitált tracked trend candidate rendszer
- `tracked_trend_candidates` + `trend_candidate_snapshots` táblák (migráció 014) — csak fontos témákat követünk (mentett/videócsomaggá vált/magas confidence-score/friss trend), a háttérfrissítés (`lib/trend-tracking.ts`) csak a MÁR ISMERT youtube_video_ids statisztikáit kéri le újra, nem indít új keresést.
- Vercel Cron (`vercel.json`, óránként) hívja a `/api/cron/refresh-trends`-et, `CRON_SECRET`-tel védve. **Élesben még nem fut, csak deploy után aktiválódik.**
- "Videók megnyitása" gomb a Követett trendtémák panelen ingyenesen mutatja a már ismert videókat (`/api/dashboard/tracked-trends/videos`), thumbnail-lel.

### 3. Strukturált niche input (Profil oldal)
- A szabad szöveges "Niche" mező helyett: fő kategória dropdown + specifikus fókusz + közönség + kerülendő témák (`lib/search/search-context.ts`, `lib/search/validate-focus.ts`).
- **Kritikus bugfix:** a kategória-címke (pl. "Tech / AI") "/" karaktere miatt a niche-elemző logika hibásan több kategóriának értelmezte a niche-t → mindig "broad_niche" (tág) módba váltott. Javítva: a niche mező csak a tiszta fókuszt tartalmazza.
- Régió-választó mostantól szinkronizálja a nyelvet is (HU→hu, US→en) — korábban ez a mismatch rontotta a keresési minőséget.

### 4. Trend Radar / Opportunity Engine minőségjavítás
- **Serper megbízhatóság:** health-tracking (`getSerperHealthStatus`), hogy a kredit-kimaradás ne "túl tág niche" hibaüzenetként jelenjen meg. Batch-elt Serper hívások (2 seed egyszerre) az 5 req/mp rate limit miatt.
- **Topic extraction:** a Serper hírcímek YouTube-keresésre alkalmatlanok voltak (túl hosszúak/szósaláta). Hibrid megoldás: determinisztikus rövidítés (`isBadSearchQuery` guard) + Haiku-alapú fallback rewrite (költségvédett: max 8 hívás/futás, cache-elt) — `lib/trend-radar.ts`.

### 5. KRITIKUS kreditbiztonsági hibák (több kör)
Ismétlődő minta: automatikus/oldal-betöltéskori hívások megkerülték a kredit-megerősítő modalt.
- **Opportunity Engine oldal** (`opportunities/page.tsx`): 3 hely (oldal betöltés, kutatási irány fúrás, "vissza a niche-hez") közvetlenül hívta a fizetős endpointot `handleGenerateWithCreditCheck` helyett — javítva.
- **Similar Videos oldal**: `?topic=` URL paraméterrel érkezéskor automatikusan indított fizetős keresést — javítva (`runSearchWithCreditCheck` közös gate mindkét flow-ra).
- **Szerver oldali védelem**: `/api/opportunity` — ha a napi ingyenes keret elfogyott és a kérés nem `force_refresh`, a szerver megáll és `needs_confirmation` választ ad, SOHA nem von le automatikusan.
- **"Részletek" gomb a Top lehetőségek kártyákon** (`TopOpportunitiesRow.tsx`): nem mentette el a témát sessionStorage-ba navigálás előtt → az Opportunity Engine oldal nem találta, új (fizetős) generálást indított. Javítva.
- **Napi vs heti kvóta bug**: `FREE_LIMITS.opportunity_engine` tévesen `weekly: 1` volt beállítva a `lib/usage-protection.ts`-ben, miközben a termékszabály (és a kliens logika) napi 1 ingyenes futtatást ígért. Javítva `daily: 1`-re.

### 6. Similar Videos perzisztens eredmény-cache
- `similar_video_searches` tábla (migráció 016) — ha a user egyszer kifizetett egy Similar Videos keresést egy témára, az újranyitás (más session, más nap) MOSTANTÓL INGYENES, DB-ből tölt vissza, nincs új YouTube/Claude hívás. "Mentett eredmény" banner + explicit "Frissítés" gomb (csak az fizetős).

### 7. Trend Feed napi történet
- `trend_feed_daily_snapshots` tábla (migráció 017) — minden napi Trend Feed generálás elmentődik. "Korábbi ajánlások" panel (`TrendFeedHistory.tsx`) mutatja a múltbeli napokat. **Csak mától gyűjt adatot — visszamenőleg nem lehetett tegnapi adatot rekonstruálni**, mert a funkció csak ma épült meg.

---

## ⏳ KÖVETKEZŐ SESSION TEENDŐI

1. **Fejezd be vagy dobd el a félbehagyott munkát** (`app/api/dashboard/tracked-trends/videos/route.ts`, `TrackedTrendsPanel.tsx`, `lib/trend-tracking.ts` uncommitted diffek) — web-forrás alátámasztás megjelenítése + gomb átnevezése.
2. **Kérdezd meg a usert, mehet-e élesbe** (push + deploy) — sok kritikus kreditbiztonsági fix vár rá.
3. **Vercel env változók beállítása deploy előtt**: `CRON_SECRET` (Vercel Cron védelme).
4. **Serper kredit feltöltés ellenőrzése** — a session elején elfogyott a Serper API kredit, a user feltöltötte, de érdemes újra ellenőrizni.
5. **~45 db régi scratch mappa rendrakása** — továbbra is nyitott pont, több session óta halasztva.
6. **Régi `willviral_dashboard_topics` / sessionStorage cache-ek** — ezek most már csak UX-gyorsítótárak, a DB az igazi forrás; érdemes átgondolni, kell-e még mind.

---

## MIGRÁCIÓK (a mai session-ben újak, MIND lefuttatva élesben)

- `014_tracked_trend_candidates.sql`
- `015_structured_niche_input.sql`
- `016_similar_video_searches.sql`
- `017_trend_feed_daily_snapshots.sql`

Minden migráció a `supabase/migrations/` mappában van, a user manuálisan futtatta le a Supabase SQL Editor-ban.

---

## KULCS FÁJLOK (mai session által érintett/létrehozott)

### Backend:
- `app/api/opportunity/route.ts` — Opportunity Engine, kredit-megerősítés kikényszerítve, napi snapshot mentés
- `app/api/similar-videos/route.ts` — perzisztens cache-check + mentés
- `app/api/dashboard/summary/route.ts` — Áttekintés fő adatforrás
- `app/api/dashboard/tracked-trends/route.ts` + `/videos/route.ts` — követett trendek + ingyenes videó-nézet
- `app/api/dashboard/trend-feed-history/route.ts` — napi történet
- `app/api/cron/refresh-trends/route.ts` — háttérfrissítés cron
- `lib/usage-protection.ts` — kredit/kvóta logika (FREE_LIMITS, checkUsagePermission)
- `lib/trend-tracking.ts` — tracked candidate rendszer
- `lib/trend-radar.ts` — Serper health, Haiku topic rewrite
- `lib/similar-videos-cache.ts` — Similar Videos cache helper
- `lib/search/search-context.ts`, `validate-focus.ts` — strukturált niche input

### Frontend:
- `components/dashboard/OverviewClient.tsx`, `CreatorIntelligenceSummary.tsx`, `TopOpportunitiesRow.tsx`, `TrackedTrendsPanel.tsx`, `TrendFeedHistory.tsx`, `Sparkline.tsx`
- `components/dashboard/DashboardClient.tsx` — leegyszerűsített Trend Feed
- `app/dashboard/profile/page.tsx` — strukturált niche input UI
- `app/dashboard/opportunities/page.tsx`, `app/dashboard/similar-videos/page.tsx` — kredit-megerősítés javítások

---

## INDÍTÁS

```
cd C:\Projektek\WillViralFinal
npm run dev
# http://localhost:3000
```

Build ellenőrzés:
```
npx tsc --noEmit --pretty
```
