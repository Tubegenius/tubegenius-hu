# WILLVIRAL — CLAUDE CODE HANDOVER DOKUMENTUM
# Dátum: 2026-07-01 (frissítve, előző verzió 2026-06-29)
# Cél: Következő session kontextus átadás (Windows kontextusablak 95%-on, itt folytatjuk)

---

## PROJEKT ÖSSZEFOGLALÓ

WillViral = magyar Creator Intelligence Platform
Lokáció: C:\Projektek\WillViralFinal
Stack: Next.js 14.2, React, Tailwind CSS, Supabase, Anthropic Claude API, YouTube Data API v3, Serper API, Stripe
GitHub: github.com/Tubegenius/tubegenius-hu
Supabase: sdvqzrcdvdtozfpjhnkh (eu-west-1)
Domain: **willviral.com — MEGVÉVE, még nem deploy-olva**
Social: **minden platformon (YouTube, TikTok, Instagram, Facebook) handle = "willviral.official"**, lefoglalva 2026-07-01
Modellek: lib/models.ts — primary: claude-sonnet-4-6, fast: claude-haiku-4-5-20251001

## MI A WILLVIRAL?

Nem sima AI-wrapper. A cél: megbízható creator intelligence platform, ahol minden állítás mögött valódi validáció van (Core Trust Engine), nem csak LLM-hallucináció.
1. Automatikusan trendi videótémákat ajánlani (Trend Feed / Dashboard)
2. Kiválasztott témát mélyen elemezni (Opportunity Engine)
3. Releváns virális hasonló videókat keresni (Similar Videos)
4. Kész, forrásbiztos videócsomagot generálni (Video Package) — Fact Safety Layer véd a hallucinált tényektől
5. Meglévő videót auditálni (Video Audit)
6. Mindent Creator Memory-ban menteni

**Brand-pozicionálás (2026-07-01 döntés):** a márka ne "egy újabb AI tool" legyen, hanem a Core Trust Engine hitelességére épüljön — "nem hazudik trendekről" ígéret. Célközönség: kezdő magyar YouTube/TikTok alkotók szűk közösségben, nem tömeges piac egyszerre.

## BUILD ÁLLAPOT: `npx tsc --noEmit` — 0 HIBA (2026-07-01 végén ellenőrizve)

## ⚠️ GIT ÁLLAPOT — KRITIKUS, ELSŐ TEENDŐ A KÖVETKEZŐ SESSIONBEN

**Semmi nincs commitolva a teljes 2026-06-29 és 2026-07-01 közötti munkából.** A working tree tele van uncommitted/untracked fájllal (`git status` sok `??` sort mutat). Ez egyre kockázatosabb. **Első dolog legyen egy git commit checkpoint**, mielőtt bármi mást csinálunk.

---

## 🔴 MAI SESSION (2026-07-01) — MIT CSINÁLTUNK

### 1. Supabase biztonsági incidens — MEGOLDVA
Supabase security advisor riasztást küldött: `youtube_search_logs` tábla RLS nélkül, publikusan olvasható/írható/törölhető volt. Kiderült: a [002_youtube_search_logs.sql](supabase/migrations/002_youtube_search_logs.sql) migráció sosem futott le élesben (a kód RLS-t előírta, az élő DB mégsem tartalmazta). **Felhasználó lefuttatta a fix SQL-t, `select tablename from pg_tables where schemaname='public' and rowsecurity=false` most üres eredményt ad — MEGOLDVA.**

Tanulság: a projektben ~15 db `willviral-*-patch*` mappa van szétszórt, sosem konszolidált SQL migrációval, amiket kézzel másoltak be a Supabase SQL Editorba — hibázásra hajlamos folyamat. **Hosszabb távon érdemes ezeket egy `supabase/migrations/` mappába összevonni.**

### 2. Codex-spec audit — mennyire egyezik a valós rendszer egy 5-pontos külső specifikációval
A user kapott egy "Codex" specifikációt (Fact Safety Layer, Trend Quality Gate, Similar Videos, Snapshot adatvagyon, Encoding fix). Teljes fájlszintű audit lett elvégezve — **meglepő eredmény: a spec nagy része már készen volt** egy korábbi (nem ismert) körből:

- **Fact Safety Layer (lib/fact-safety.ts)** — ~90% kész volt már: `content_type`, `strict_fact_mode`, intensity downgrade, `verified_fact_block`, `forbidden_claims`, `quality_status`, Sonnet+Haiku prompt szigorítás, `insufficient_sources` blokkolás mind megvolt [app/api/video-package/route.ts](app/api/video-package/route.ts)-ben bekötve.
- **Trend Candidate Quality Gate** — kész volt: `MIN_USER_FACING_RELEVANCE=60`, `topicMatchSerperYoutube()`, `validateHungarianSeeds()` (szó szerint a spec tiltott seed-példáival), `weak_signal` sosem jut userhez.
- **Similar Videos** — kész volt: `viral_video_score`, cluster-median outlier, badge-ek — egyetlen eltérés a súlyozásban (lásd lent).
- **Snapshot adatvagyon** — 0%, semmi nem létezett.
- **Encoding hibák** — nem volt reprodukálható a jelenlegi forrásban.

### 3. Ma ténylegesen elvégzett fejlesztés (a fenti audit alapján, user jóváhagyásával)

**a) Snapshot táblák (passzív adatgyűjtés)** — [supabase/migrations/011_youtube_snapshot_tables.sql](supabase/migrations/011_youtube_snapshot_tables.sql)
- Új táblák: `youtube_videos`, `youtube_video_snapshots`, `youtube_channels`, `youtube_channel_snapshots` (séma kész, még nem íródik — subscriber-adathoz külön API hívás kellene), `trend_candidates`, `topic_clusters` (séma kész, klaszterező logika még nincs)
- Új [lib/youtube-snapshot.ts](lib/youtube-snapshot.ts) helper — try/catch-be csomagolt, nem blokkolja a fő funkciót hiba esetén
- Bekötve: [app/api/similar-videos/route.ts](app/api/similar-videos/route.ts) (`baseVideos` mentése) + [lib/trend-radar.ts](lib/trend-radar.ts) (`youtubeVideos` + végleges `trendCandidates` mentése)
- **Nincs extra API-hívás** — csak azt menti, amit a rendszer amúgy is lekér
- RLS bekapcsolva minden új táblán, csak `service_role` fér hozzá

**b) video_packages fact-safety mezők** — [supabase/migrations/012_video_package_fact_safety_fields.sql](supabase/migrations/012_video_package_fact_safety_fields.sql)
- User döntése: a meglévő `verified_fact_block TEXT` oszlop **nem** lett átalakítva (kockázat elkerülése), helyette új oszlopok: `verified_fact_block_json`, `forbidden_claims`, `sources_used` (JSONB), `quality_status`, `content_type`, `intensity_original`, `intensity_final` (TEXT), `strict_fact_mode` (BOOLEAN)
- Frissítve: [app/api/video-packages/route.ts](app/api/video-packages/route.ts) (mentő endpoint) + [app/dashboard/video-package/page.tsx](app/dashboard/video-package/page.tsx) mindkét save hívása (`autoSavePackage` és `savePackage`) — korábban ezek a mezők ki lettek számolva a backend-en, de **sosem lettek elmentve** a DB-be.

**c) classifyContentType teszt (NEM élesítve, csak vizsgálat)**
8 mintatémán tesztelve (politika, celeb-válás, gyógyszer, tudomány, AI, TikTok challenge, magyar gazdasági hír, baleset) — eredmény: jól kalibrált, nem túl agresszív. **Nyitott döntés a usernek:** az általános "hírek" témák jelenleg NEM triggerelik a `strict_fact_mode`-ot (csak konkrét esemény/személy/botrány igen) — a Codex-spec szerint minden "aktuális hír" strict kéne legyen. **Nem lett módosítva, döntés vár.**

**d) Similar Videos scoring — nem kellett módosítani**
User explicit döntése: relevance_score >= 60 legyen kemény kapu (nem csak súly), utána viral_video_score alapú rangsor (velocity/freshness/engagement/outlier domináljon). Ellenőrizve: [lib/scoring/willviral-decision-engine.ts](lib/scoring/willviral-decision-engine.ts) `decideSimilarVideo()` már pontosan ezt csinálja (`relevance_score < 60` → hard reject, utána `scoreValidatedVideo()` súlyozott score: velocity 0.30, engagement 0.25, outlier 0.20, freshness 0.15, relevance 0.10). **Semmi nem lett módosítva, már megfelelt.**

### 4. Dev szerver
`npm run dev` elindítva, fut: **http://localhost:3000**

---

## ⏳ KÖVETKEZŐ SESSION TEENDŐI (sorrendben)

1. **Git commit checkpoint** — ELSŐ lépés legyen, rengeteg uncommitted munka van.
2. **Futtasd le a két új migrációt élesben**, ha a user még nem tette meg:
   - `supabase/migrations/011_youtube_snapshot_tables.sql`
   - `supabase/migrations/012_video_package_fact_safety_fields.sql`
   - Utána ellenőrzés: `select tablename from pg_tables where schemaname='public' and rowsecurity=false;` → üres kell legyen
3. **Döntés kell:** classifyContentType — legyen-e minden "hír" típusú téma is `strict_fact_mode`, vagy maradjon a jelenlegi (csak konkrét esemény/személy/botrány trigger)?
4. **Élő böngészős teszt** a mai változásokra (Similar Videos, Video Package mentés, snapshot írások — nézd meg konzolban/Supabase table editor-ban, hogy tényleg mentődnek-e sorok)
5. **Korábbról nyitva maradt, még mindig releváns:**
   - Opportunity Engine drilldown state mentése — **ELKÉSZÜLT** korábban ma (activeDrilldown sessionStorage-ban, app/dashboard/opportunities/page.tsx:728,769,842,980)
   - Video Package saját keresési input memória — **ELKÉSZÜLT** korábban ma (video-package/page.tsx:449 useEffect)
   - Core Trust Engine 10 teszteset — **10/10 PASS**, 2 hibát javítottunk (niche-fit arányos számítás, `contradicts()` forrásszám-alapú)
   - LoadingScreen animált logó pótlás minden oldalon — **KÉSZ** (opportunities, script-extractor, similar-videos, video-audit, video-package, viral-score)
6. **Ezután:** Stripe webhook / production / deploy blokk, VAGY social media bio-szövegek megírása (felajánlva, nem csinálva)

---

## ARCHITEKTÚRA

### Backend pipeline (Opportunity Engine):
User niche → detectNicheIntent() → expandTopicQueries() → generateSeedsForNiche() (Haiku) → buildTrendCandidates() (Serper + YouTube, most snapshot-mentéssel) → computeOpportunityScore() → validateCandidateConsistency() → buildValidationSummary() → Claude explain (Haiku) → buildTopic() → response

### Similar Videos pipeline:
User topic → generateSimilarVideoQueries() (Haiku) → youtubeSearch() (budget 3) → calcCombinedRelevance() → snapshot mentés → decideSimilarVideo() (relevance hard gate 60) → calculateNicheFit() → response

### Core Trust Engine (lib/core-trust-engine/):
types, score, validate, decide, safe-output, cache, index — egyetlen központi döntési motor. Súlyozás: web 30% / niche-fit 20% / content-gap 20% / video 15% / freshness 15%. 5 döntési típus: hybrid_validated_trend, web_validated_opportunity, video_inspiration, research_required, polluted_candidate.

### Kredit rendszer:
Free: napi 3 Similar Videos + heti 1 Opportunity Engine ingyenes
Utána: kredit levonás (success-based — csak ha van valid eredmény, video-audit és similar-videos kredit-biztonsági fix ma korábban)
Stripe subscription: Starter 2990 / Creator 5990 / Pro 11990 Ft/hó

---

## KULCS FÁJLOK

### Backend:
- app/api/opportunity/route.ts — Opportunity Engine fő logika
- app/api/similar-videos/route.ts — Similar Videos, Haiku query expansion, niche fit, **snapshot mentés (ma)**
- app/api/video-package/route.ts — Video Package Generator, Fact Safety Layer (lib/fact-safety.ts)
- app/api/video-packages/route.ts — Mentés/lista/törlés, **fact-safety mezőkkel bővítve (ma)**
- app/api/video-audit/route.ts — Video Audit, hibrid scoring
- app/api/viral-score/route.ts — Viral Score
- app/api/script-extract/route.ts — Script Extractor
- app/api/stripe/* — Stripe subscription/topup/webhook/portal
- app/api/dashboard-stats/route.ts — Dashboard mutatók

### Lib modulok (legfontosabbak):
- lib/core-trust-engine/ — types, score, validate, decide, safe-output, cache, index
- lib/youtube-service.ts — Központi YouTube API, query budget, cache, quota guard
- lib/youtube-snapshot.ts — **ÚJ (ma)** — passzív snapshot mentés helper
- lib/trend-radar.ts — Serper + YouTube trend candidate pipeline, snapshot mentéssel bekötve
- lib/fact-safety.ts — Content classification, strict_fact_mode, verified_fact_block, forbidden_claims
- lib/candidate-consistency.ts, lib/validation-summary.ts, lib/niche-fit.ts
- lib/usage-protection.ts — Free limitek, kredit check
- lib/scoring/willviral-decision-engine.ts — decideSimilarVideo(), scoreValidatedVideo()
- lib/stripe.ts, lib/credits.ts

### Frontend:
- components/ui/LoadingScreen.tsx — Animált W logó, **most minden fő oldalon bekötve**
- app/dashboard/opportunities/page.tsx — drilldown state mentés (ma reggel)
- app/dashboard/video-package/page.tsx — input auto-save + fact-safety mezők mentése (ma)
- app/dashboard/similar-videos/page.tsx

---

## SUPABASE TÁBLÁK (2026-07-01 állapot)

profiles, user_credits, creator_memory, video_packages (**bővítve ma**: verified_fact_block_json, forbidden_claims, sources_used, quality_status, content_type, strict_fact_mode, intensity_original, intensity_final), video_audits, ai_usage_logs, opportunity_cache, trend_candidate_cache, youtube_search_logs (**RLS fix ma**), source_video_analysis, topic_feedback, youtube_search_cache, **ÚJ (ma, migráció még lehet hogy nem futott le élesben)**: youtube_videos, youtube_video_snapshots, youtube_channels, youtube_channel_snapshots, trend_candidates, topic_clusters

Migrációs fájlok szétszórva `supabase/migrations/` (001-012) ÉS `willviral-*-patch*/` mappákban — konszolidálás még várat magára.

---

## ISMERT PROBLÉMÁK / NYITOTT DÖNTÉSEK

1. **classifyContentType "hír" határeset** — lásd fent, döntés vár.
2. **Stripe webhook nincs aktív production-ben** — dev-ben manuális kredit jóváírás.
3. **Git — semmi nincs commitolva** — lásd fent, sürgős.
4. **Migrációk 011/012 élesítése** — ellenőrizni kell, lefutott-e már.
5. **Similar Videos súlyozás** — a Codex-spec numerikusan mást javasolt (relevance 0.25 vs jelenlegi 0.10), de a user explicit döntött úgy, hogy a jelenlegi (relevancia = kapu, nem fő súly) marad — ez nem hiba, tudatos döntés.

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
