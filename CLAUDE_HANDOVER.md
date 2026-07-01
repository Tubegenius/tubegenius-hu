# WILLVIRAL — CLAUDE CODE HANDOVER DOKUMENTUM
# Dátum: 2026-07-01 (frissítve, előző verzió ugyanezen a napon korábban)
# Cél: Következő session kontextus átadás (Windows kontextusablak megint 90%-on, itt folytatjuk)

---

## PROJEKT ÖSSZEFOGLALÓ

WillViral = magyar Creator Intelligence Platform
Lokáció: C:\Projektek\WillViralFinal
Stack: Next.js 14.2, React, Tailwind CSS, Supabase, Anthropic Claude API, YouTube Data API v3, Serper API, Stripe
GitHub: github.com/Tubegenius/tubegenius-hu
Supabase: sdvqzrcdvdtozfpjhnkh (eu-west-1)
Domain: **willviral.com — MEGVÉVE, még nem deploy-olva**
Social: minden platformon (YouTube, TikTok, Instagram, Facebook) handle = "willviral.official", lefoglalva
Modellek: lib/models.ts — primary: claude-sonnet-4-6, fast: claude-haiku-4-5-20251001

## MI A WILLVIRAL?

Nem sima AI-wrapper. A cél: megbízható creator intelligence platform, ahol minden állítás mögött valódi validáció van (Core Trust Engine), nem csak LLM-hallucináció.
1. Automatikusan trendi videótémákat ajánlani (Trend Feed / Dashboard)
2. Kiválasztott témát mélyen elemezni (Opportunity Engine)
3. Releváns virális hasonló videókat keresni (Similar Videos)
4. Kész, forrásbiztos videócsomagot generálni (Video Package) — Fact Safety Layer véd a hallucinált tényektől
5. Meglévő videót auditálni (Video Audit)
6. Mindent Creator Memory-ban menteni

**Brand-pozicionálás:** a márka ne "egy újabb AI tool" legyen, hanem a Core Trust Engine hitelességére épüljön — "nem hazudik trendekről" ígéret. Célközönség: kezdő magyar YouTube/TikTok alkotók szűk közösségben, nem tömeges piac egyszerre.

## BUILD ÁLLAPOT: `npx tsc --noEmit` — 0 HIBA (ma este ellenőrizve, a legutóbbi trend feed fix után is)

## ⚠️ GIT ÁLLAPOT — ELSŐ TEENDŐ A KÖVETKEZŐ SESSIONBEN

**A mai session változásai (lásd lent, 6 módosított fájl + 1 új migráció) MÉG NINCSENEK COMMITOLVA.** `git status` jelenleg ezt mutatja módosítottként:
- app/api/opportunity/route.ts
- app/api/video-package/route.ts
- app/api/video-packages/route.ts
- app/dashboard/video-package/page.tsx
- components/dashboard/DashboardClient.tsx
- lib/fact-safety.ts

Új (untracked) fájl:
- supabase/migrations/013_fact_strictness_level.sql

**Első lépés legyen egy git commit checkpoint erre a 7 fájlra**, mielőtt bármi mást csinálunk. (A korábbi, 2026-06-29–07-01 közötti munka már commitolva van a `038112e` commitban — az rendben van, csak a mai új réteg nincs.)

A projektben továbbra is ~45 db `willviral-*-patch*` / scratch mappa van szétszórva (untracked, régi one-off session-ekből) — ezek nem részei az élő appnak, commitolni nem kell őket, de idővel érdemes törölni vagy egy `.gitignore`-ba tenni, hogy ne zajongjanak a `git status`-ban.

---

## 🔴 MAI SESSION (2026-07-01, második fele) — MIT CSINÁLTUNK

### 1. Ellenőrzés: a korábbi session 3 döntése tényleg élesben úgy működik-e, ahogy megbeszéltük
A user visszakérdezett a korábban meghozott 3 döntésre (snapshot táblák passzív gyűjtése, video_packages TEXT+JSONB szétválasztás, Similar Videos relevancia-kapu + viral ranking). Élő Supabase lekérdezéssel ellenőriztem — **mindhárom pontosan úgy működik éles adatokkal is, ahogy eltervezve volt, semmit nem kellett javítani**:
- `youtube_videos`: 119 sor, `youtube_video_snapshots`: 246 sor, `youtube_channels`: 111 sor, `trend_candidates`: 26 sor (mind valós, a session során felgyűlt adat)
- `video_packages` új JSONB mezői léteznek és helyesen vannak feltöltve a frontendből
- `decideSimilarVideo()` relevancia-kapu (< 60 → hard reject) + `scoreValidatedVideo()` viral-súlyozás (velocity 30% / engagement 25% / outlier 20% / freshness 15% / relevancia 10%) pontosan a megbeszélt logika

### 2. classifyContentType bővítés — MEGTÖRTÉNT, ÉLESÍTVE
A korábban nyitva hagyott döntés lezárva: a user döntött, hogy **az általános hírek is triggereljék a `strict_fact_mode`-ot**, de két szigorúsági szinttel:
- **standard_news** — általános hír/esemény/gazdasági-technológiai-tudományos-politikai fejlemény. Enyhébb tiltások: új tény/időpont/szereplő kitalálása, globális hír magyar eseménnyé alakítása, bizonytalan állítás biztos tényként kezelése, forrás nélküli következtetés. Min. 2 forrás szükséges.
- **high_risk** — konkrét személy/botrány/vád/politikai konfliktus/egészség/jog/pénzügy/bűnügy/családi kapcsolat/tisztség/idézet. Szigorúbb: a fentiek + személyazonosság/tisztség/rokoni kapcsolat/idézet/eseményrészletek ellenőrzés, motiváció/szándék tiltása forrás nélkül. Min. 3 forrás szükséges.

**Megvalósítás** ([lib/fact-safety.ts](lib/fact-safety.ts)):
- Új `ContentType = 'factual_news'` + új `FactStrictnessLevel = 'standard_news' | 'high_risk' | null` típus
- `classifyContentType()` sorrend: entertainment(2+) → factual_sensitive (high_risk) → factual_news (standard_news) → factual_general (evergreen, nem strict) → entertainment(1) → default
- `isStrictFactMode()` most `factual_sensitive` VAGY `factual_news` esetén is `true`
- Új `getFactStrictnessLevel()` export
- `buildVerifiedFactBlock()` szint szerint differenciált `forbidden_claims` listát és `minimumRequired` forrásszámot ad
- `buildFactSafetyPromptRules()` külön prompt-szöveget generál standard_news-hoz és high_risk-hez

**Teszt:** 12 mintatéma (politika, celeb, gyógyszer, baleset → high_risk; magyar/globális gazdasági hír, kereskedelmi megállapodás, tudományos áttörés, EU-csúcs → standard_news; evergreen tudomány/AI-oktatás, TikTok challenge, recept → nem strict) — **12/12 helyes**, nem blokkol túl agresszívan. A tesztet egy standalone `tsc` compile + node script futtatással validáltam, utána törölve.

**DB + mentés bekötve:**
- Új [supabase/migrations/013_fact_strictness_level.sql](supabase/migrations/013_fact_strictness_level.sql) — `fact_strictness_level TEXT` oszlop + index a `video_packages` táblán
- **A migráció LEFUTOTT ÉLESBEN, ellenőrizve** (`fact_strictness_level` oszlop élesben lekérdezhető)
- Bekötve: [app/api/video-package/route.ts](app/api/video-package/route.ts) (generálás, `result.fact_strictness_level`), [app/api/video-packages/route.ts](app/api/video-packages/route.ts) (mentés), [app/dashboard/video-package/page.tsx](app/dashboard/video-package/page.tsx) (mindkét save hívás + típus)

### 3. Trend Feed bug — MEGTALÁLVA ÉS JAVÍTVA
**Tünet:** a user jelentette, hogy a Trend Feed "Új ajánlás — 2 kredit" gombja levonja a kreditet, de ugyanazt a témát hozza vissza, amit már látott.

**Root cause:** a "force refresh" valóban friss keresést futtatott (bypassolta mindkét cache-t: `opportunity_cache`, `trend_candidate_cache`), DE nem volt semmilyen mechanizmus, ami kizárná a **már megmutatott** témákat az újraértékelésből. A kizárás eddig csak a Creator Memory `completed`/`rejected` state-jeit nézte — nem azt, amit a user az imént, ugyanabban a böngészési munkamenetben már látott. Mivel a valós YouTube/Serper adatok pár perc alatt nem változnak, a friss keresés statisztikailag ugyanazt a legerősebb trendet találta meg újra — érvényes eredmény lévén a kredit levonódott.

**Javítás:**
- [components/dashboard/DashboardClient.tsx](components/dashboard/DashboardClient.tsx): `loadOpportunities` force-refresh híváskor most elküldi a jelenleg látott `topics` state címeit `exclude_titles` mezőben
- [app/api/opportunity/route.ts](app/api/opportunity/route.ts): a `filteredCandidates` szűrő (kb. 430. sor) most force_refresh esetén kizárja azokat a jelölteket is, amiknek a `candidate_topic`-ja egyezik/tartalmazza az `exclude_titles`-ben kapott korábbi címeket
- Ha kizárás után nem marad elég erős **új** téma, a már meglévő logika nem vonja le a kreditet, és jelzi: "Most nem találtunk elég erős új témát. Kreditet nem vontunk le."

**MÉG NEM ELLENŐRIZVE ÉLŐ BÖNGÉSZŐBEN** — a `tsc --noEmit` tiszta, de a tényleges böngészős tesztet (kattints "Új ajánlás"-ra kétszer egymás után) nem futtattuk le.

### 4. Windows kontextusablak-probléma megbeszélve
A user jelezte, hogy a Windows Claude Code kontextusablak nagyon gyorsan (pár tool-hívás alatt) eléri a 90%-ot, ami megnehezíti a munkát. Tanács adva: kisebb, célzottabb feladatok friss session-ökben, `/clear` gyakoribb használata, memória + handover doc a folytonossághoz nagy chat-history helyett. **Ez nem projekt-hiba, hanem munkamódszer-kérdés — a következő session-ben érdemes ezt szem előtt tartani.**

---

## ⏳ KÖVETKEZŐ SESSION TEENDŐI (sorrendben)

1. **Git commit checkpoint** a mai 7 fájlra (lásd fent a listát) — ELSŐ lépés.
2. **Élő böngészős teszt a Trend Feed fixre**: nyisd meg a Dashboardot, kattints "Új ajánlás — 2 kredit"-re kétszer egymás után ugyanazzal a niche-el — nézd meg, hogy vagy valódi más témát kapsz, vagy nem vonódik kredit (nem szabad, hogy ugyanaz jöjjön vissza kredit levonással).
3. **Élő böngészős teszt a classifyContentType bővítésre**: generálj egy Video Package-t egy "standard_news" jellegű témával (pl. "Magyar gazdasági hír: az infláció alakulása") és egy "high_risk" témával (pl. politikus/celeb), nézd meg hogy a `fact_strictness_level` mező helyesen mentődik-e (Supabase table editor: `video_packages.fact_strictness_level`).
4. **Régi scratch mappák rendrakása** — ~45 db `willviral-*-patch*` mappa zajong a `git status`-ban, érdemes törölni vagy `.gitignore`-ba tenni.
5. **Ezután:** Stripe webhook / production / deploy blokk, VAGY social media bio-szövegek megírása (felajánlva, nem csinálva).

---

## ARCHITEKTÚRA

### Backend pipeline (Opportunity Engine):
User niche → detectNicheIntent() → expandTopicQueries() → generateSeedsForNiche() (Haiku) → buildTrendCandidates() (Serper + YouTube, snapshot-mentéssel) → filteredCandidates (Creator Memory + **exclude_titles kizárás force refresh-nél, ÚJ**) → evaluateCandidate() (Core Trust Engine) → Claude explain (Haiku) → toOpportunityTopic() → response

### Similar Videos pipeline:
User topic → generateSimilarVideoQueries() (Haiku) → youtubeSearch() (budget 3) → calcCombinedRelevance() → snapshot mentés → decideSimilarVideo() (relevance hard gate 60) → calculateNicheFit() → response

### Video Package Fact Safety pipeline:
topic → classifyContentType() → isStrictFactMode() + getFactStrictnessLevel() (ÚJ: standard_news/high_risk) → applyIntensityDowngrade() → buildVerifiedFactBlock() (szint szerint differenciált forbidden_claims + min. forrásszám) → buildFactSafetyPromptRules() (szint szerint eltérő prompt) → generateCreativeCore() (Sonnet) → generatePackaging() (Haiku) → mentés (verified_fact_block_json, fact_strictness_level stb.)

### Core Trust Engine (lib/core-trust-engine/):
types, score, validate, decide, safe-output, cache, index — egyetlen központi döntési motor. Súlyozás: web 30% / niche-fit 20% / content-gap 20% / video 15% / freshness 15%. 5 döntési típus: hybrid_validated_trend, web_validated_opportunity, video_inspiration, research_required, polluted_candidate.

### Kredit rendszer:
Free: napi 3 Similar Videos + heti 1 Opportunity Engine ingyenes
Utána: kredit levonás (success-based — csak ha van valid eredmény)
Trend Feed manuális frissítés: MINDIG 2 kredit, DE csak ha ténylegesen új téma jön (lásd a mai fix-et)
Stripe subscription: Starter 2990 / Creator 5990 / Pro 11990 Ft/hó

---

## KULCS FÁJLOK

### Backend:
- app/api/opportunity/route.ts — Opportunity Engine fő logika, **exclude_titles kizárás force refresh-nél (ma)**
- app/api/similar-videos/route.ts — Similar Videos, Haiku query expansion, niche fit, snapshot mentés
- app/api/video-package/route.ts — Video Package Generator, Fact Safety Layer, **fact_strictness_level bekötve (ma)**
- app/api/video-packages/route.ts — Mentés/lista/törlés, **fact_strictness_level mentése (ma)**
- app/api/video-audit/route.ts — Video Audit, hibrid scoring
- app/api/viral-score/route.ts — Viral Score
- app/api/script-extract/route.ts — Script Extractor
- app/api/stripe/* — Stripe subscription/topup/webhook/portal
- app/api/dashboard-stats/route.ts — Dashboard mutatók

### Lib modulok (legfontosabbak):
- lib/core-trust-engine/ — types, score, validate, decide, safe-output, cache, index
- lib/youtube-service.ts — Központi YouTube API, query budget, cache, quota guard
- lib/youtube-snapshot.ts — passzív snapshot mentés helper
- lib/trend-radar.ts — Serper + YouTube trend candidate pipeline, snapshot mentéssel bekötve
- lib/fact-safety.ts — Content classification, **factual_news + FactStrictnessLevel bővítés (ma)**
- lib/candidate-consistency.ts, lib/validation-summary.ts, lib/niche-fit.ts
- lib/usage-protection.ts — Free limitek, kredit check
- lib/scoring/willviral-decision-engine.ts — decideSimilarVideo(), scoreValidatedVideo()
- lib/seed-generator.ts — Haiku alapú seed generálás niche-ből (nem cache-elt, minden force refresh-nél újrahívva)
- lib/stripe.ts, lib/credits.ts

### Frontend:
- components/ui/LoadingScreen.tsx — Animált W logó, minden fő oldalon bekötve
- components/dashboard/DashboardClient.tsx — Trend Feed / Dashboard, **exclude_titles küldése force refresh-nél (ma)**
- app/dashboard/opportunities/page.tsx — drilldown state mentés
- app/dashboard/video-package/page.tsx — input auto-save + fact-safety mezők mentése, **fact_strictness_level típus + save (ma)**
- app/dashboard/similar-videos/page.tsx

---

## SUPABASE TÁBLÁK (2026-07-01 este állapot, élesben ellenőrizve)

profiles, user_credits, creator_memory, video_packages (verified_fact_block_json, forbidden_claims, sources_used, quality_status, content_type, strict_fact_mode, intensity_original, intensity_final, **fact_strictness_level — ÚJ ma, élesben megvan**), video_audits, ai_usage_logs, opportunity_cache, trend_candidate_cache, youtube_search_logs (RLS-fixelve), source_video_analysis, topic_feedback, youtube_search_cache, youtube_videos (119 sor), youtube_video_snapshots (246 sor), youtube_channels (111 sor), youtube_channel_snapshots, trend_candidates (26 sor), topic_clusters (0 sor, klaszterező logika még nincs megírva)

Migrációs fájlok: `supabase/migrations/001-013`. A `willviral-*-patch*/` mappákban lévő SQL-ek régiek/redundánsak, konszolidálás még várat magára.

---

## ISMERT PROBLÉMÁK / NYITOTT DÖNTÉSEK

1. **Git — a mai 7 fájl nincs commitolva** — lásd fent, sürgős.
2. **Trend Feed fix nincs élő böngészőben tesztelve** — csak `tsc` szinten ellenőrizve.
3. **classifyContentType bővítés nincs élő böngészőben tesztelve** — csak standalone script szinten (12/12 helyes).
4. **Stripe webhook nincs aktív production-ben** — dev-ben manuális kredit jóváírás.
5. **topic_clusters tábla üres** — a klaszterező logika (trend-mintázat felismerés a felgyűlt snapshot-adatból) még nincs megírva, csak a séma létezik.
6. **~45 db régi scratch/patch mappa** szemetel a `git status`-ban, rendrakásra vár.
7. **Similar Videos súlyozás** — user explicit döntött úgy, hogy relevancia = kapu (nem fő súly) marad — ez tudatos döntés, nem hiba.

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

Server reset:
```
# PowerShell: Get-Process -Name "node" | Stop-Process -Force
# Bash: rm -rf .next && npx next dev --port 3000
```
