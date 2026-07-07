# WILLVIRAL — CLAUDE CODE HANDOVER DOKUMENTUM
# Dátum: 2026-07-07
# Cél: Következő session kontextus átadás

---

## PROJEKT ÖSSZEFOGLALÓ

WillViral = magyar Creator Intelligence Platform
Lokáció: C:\Projektek\WillViralFinal
Stack: Next.js 14.2, React, Tailwind CSS, Supabase (sdvqzrcdvdtozfpjhnkh, eu-west-1), Anthropic Claude API, YouTube Data API v3, Serper API, Stripe
GitHub: github.com/Tubegenius/tubegenius-hu
Domain: willviral.com — megvéve, **még mindig nincs deployolva** (lásd lent, ez a legnagyobb nyitott pont)
Modellek: lib/models.ts — primary: claude-sonnet-4-6, fast: claude-haiku-4-5-20251001

## MI A WILLVIRAL?

Nem sima AI-wrapper. Core Trust Engine — minden állítás mögött valódi validáció (YouTube/Serper adat), nem LLM-hallucináció. Fő funkciók: Trend Feed (napi ajánlás), Opportunity Engine (téma-elemzés), Similar Videos, Video Package Generator (Fact Safety Layer), Video Audit, Script Extractor, Viral Score, Creator Memory.

## BUILD ÁLLAPOT

`npx tsc --noEmit` — 0 hiba. `npm run build` — sikeres production build. Mindkettő ellenőrizve a 2026-07-07-i Codex-diff review után, a jelen commit állapotában.

---

## ✅ 2026-07-07 SESSION: a korábban leírt Codex-diff átnézve, javítva, tesztelve, commitolva

Az előző handover ELSŐ TEENDŐként egy nagy, még nem ellenőrzött Codex-diffet hagyott hátra (`app/api/*`, `app/dashboard/*`, `CreatorIntelligenceSummary.tsx`, `DashboardClient.tsx`, `hungarian-output-polish.ts`, `willviral-decision-engine.ts`, `next.config.js`). Ez a session ezt végignézte fájlonként, `tsc --noEmit` + `npm run build` + élő bejelentkezett böngészős smoke-teszt (dashboard, Similar Videos élő keresés, Video Package) futtatásával.

**Talált és javított valódi hiba**: `lib/hungarian-output-polish.ts`-ben az általános mojibake-szabály (`/Ĺ/g → 'Ő'`) a kétkarakteres `Ĺ°`/`Ĺ‘`/`Ĺ±` szabályok ELŐTT futott, így minden `ő`/`ű`/`Ű` mojibake-javítást elrontott (pl. `EllenĹ‘rzĂ¶tt` → helytelenül `EllenŐ‘rzĂ¶tt` lett volna `Ellenőrzött` helyett). Javítva: a kétkarakteres szabályok most előbb futnak.

**A többi Codex-változás átnézve, éles hibát NEM találtam bennük** — ellenkezőleg, mindegyik befejezett, célzott javítás volt:
- `chargeProtectedFeature` bevezetése az Opportunity Engine-nél — optimista konkurenciakezelést (compare-and-swap) ad a kredit-levonáshoz, lezárva egy dupla-levonási race conditiont.
- `video-audit`/`video-package`/`script-extract` GET/POST — mind megkapta a kredit nélküli "paid result reopen" logikát (a hash-alapú keresés most a kredit-ellenőrzés ELŐTT fut).
- `willviral-decision-engine.ts` — szigorúbb Similar Videos validáció (100 alatti view_count elutasítva, "watch" státuszhoz evidence gate is kell).
- `video-package` — `niche` (profil alapbeállítás) és `channel_context` (aktuális téma) szétválasztva, élőben tesztelve.
- `DashboardClient.tsx` — first-run launch pad + "mai teendő" panel, kutatási-sáv CTA most Viral Score-ra visz Video Package helyett.

Mellékes: egy stray `next dev` folyamat futott a 3000-es porton (`.codex-dev-server.log` alapján egy korábbi Codex háttér-szerver) — ez ütközött a saját preview szerveremmel a közös `.next` cache-en, és 500-as hibát okozott. A user jóváhagyásával leállítva, `.next` törölve, tiszta szerver újraindítva.

---

## GIT ÁLLAPOT

**Minden commit LOKÁLIS, még NINCS push-olva.** A user nem kérte a push-t.

Két új commit a mai (és a megelőző, 07-03 óta tartó) session-ből:
```
1d061b0 fix: finish paid-result reopen for Video Package/Audit/Script Extractor + repo cleanup
56f5e54 feat: persistent paid-result caching, credit-safety fixes, and text-quality pass
```
(ezek előtt a `e640440`-ig visszamenő history a 07-03-as session-ből változatlan)

---

## 🔴 MAI (ÉS AZ AZÓTA TARTÓ) SESSION — MIT CSINÁLTUNK

### 1. Viral Score — Serper "webes visszhang" jel hozzáadása
- A Viral Score korábban KIZÁRÓLAG YouTube-adatból számolt — most egy 6. faktor (`web_buzz`) is bekerült Serper hírkeresésből (`calcWebBuzzScore`), a meglévő view/engagement/velocity súlyok (75%) érintetlenek, csak az outlier/market súlyokból csippentettünk 10%-ot az új faktornak. Ha a Serper nem elérhető, a formula visszaesik az eredeti, tisztán YouTube-alapú súlyozásra.
- **Téma-relevancia szűrés** hozzáadva YouTube ÉS Serper találatokra is (`isTopicRelevant`) — enélkül pl. "AI botrányok" keresésre tisztán "botrány" témájú, AI-hoz nem kötődő találatok is bekerültek volna a score-ba. A megosztott `lib/trend-radar.ts` szűrőjét szándékosan NEM használtuk (az 3 karakternél rövidebb szavakat, pl. "AI"-t eldob).
- HTML entitás dekódolás hozzáadva `lib/youtube-service.ts`-hez (a YouTube API néha `&quot;`-ot ad vissza sima idézőjel helyett a title-ökben) — ez a fix az egész appot érinti, nem csak Viral Score-t.

### 2. KRITIKUS kreditbiztonsági hibák
- **Viral Score sosem vont le kreditet szerver oldalon** — a kliens csak becsült egy "1 kredit" költséget, aminek soha nem volt fedezete. Javítva: szerver oldali `hasEnoughCredits` + `chargeFeature`.
- **Cross-user cache-lopás**: a régi `viral_score_cache` tábla NEM volt user-hez kötve — bárki ugyanazt a cache-elt eredményt kapta vissza ugyanarra a topic/platform/region kombinációra, kredit nélkül. Javítva egy user-szintű táblával.

### 3. "Amit megvettél, azt bármikor visszakapod" — perzisztens cache redesign
- Új `viral_score_searches` tábla (migráció 018) + `lib/viral-score-cache.ts`, majd a Codex ezt egy egységes `paid_results` táblával (migráció 019/020) generalizálta MIND A 6 fizetős eszközre.
- **Alapelv, amit véglegesítettünk**: a 6 órás (vagy bármilyen) "friss" ablak csak UI-jelzés (`cache_status: fresh/stale_saved`), SOHA nem fizetési határ. Új kredit csak explicit "Frissítés" gombra megy.
- **Befejeztem a Codex félkész munkáját**: a `paid_results` migráció csak Viral Score/Similar Videos/Opportunity Engine-nél kapott működő "reopen" (olvasó) logikát — Video Package, Video Audit, Script Extractor csak ÍRT az új táblába, de a "Legutóbbi történeted" linkjeik semerre nem vezettek. Mindhárom eszközön most már megvan a `paidResultId`-alapú GET reopen (backend + frontend), kredit nélkül, élőben tesztelve.

### 4. Nap-váltási cache-bug (Opportunity Engine + Trend Radar)
- Az `opportunity_cache` / `trend_candidate_cache` kulcsa tartalmazta a mai naptári dátumot is — éjfélkor egy technikailag még órákig érvényes (24h `expires_at`) cache is "eltűnt" a pontos kulcsegyezés miatt, és a rendszer FELESLEGESEN újragenerálta ugyanazt minden nap (valós YouTube/Serper/Claude költség + a napi ingyenes keret feleslegesen elfogyott). Javítva: a keresés most dátum-prefix + valódi `expires_at` alapján megy.

### 5. Szisztémás magyar ékezet-hiba
- A `lib/core-trust-engine/decide.ts` (az Opportunity Engine élő döntési motorja — MINDEN label/magyarázat/CTA innen jön) **teljes egészében** ékezet nélkül volt írva. Teljesen újraírva.
- Egy 3-ügynökös háttér-audit további ~15 aktív fájlt talált ugyanezzel a hibával (`lib/niche-fit.ts`, `lib/usage-protection.ts`, `lib/topic-expansion.ts`, `DashboardClient.tsx`, `VideoCardActions.tsx`, `credits/page.tsx`, több API route hibaüzenet) — mind javítva.
- Video Package Claude-prompt finomítás: a "webes visszhang" kifejezést a modell néha félrefogalmazta ("médiabűke") — a prompt most explicit előírja a pontos kifejezés használatát.

### 6. Video Package UX — profil niche vs. aktuális téma
- A "Niche" badge egy STATIKUS profilbeállítást mutatott, összemosva a ténylegesen gyártott témával. Relabelezve + külön "Aktuális téma kontextus" sáv hozzáadva.

### 7. Üzemeltetési takarítás
- ~40 db régi `willviral-*` scratch mappa + backup fájl törölve (1.9 MB, semmi élő kód nem hivatkozott rájuk) — ez több session óta halasztott tétel volt.
- `.gitignore` kibővítve, hogy ez a fajta scratch-output többé ne térhessen vissza.
- `.env.example` hiánypótlás: hiányzott belőle a `SERPER_API_KEY` és MINDEN Stripe-változó — most benne van, `CRON_SECRET` figyelmeztetéssel.
- Minimális CI (`.github/workflows/ci.yml`) — `tsc --noEmit` minden push/PR-nél kötelező; a `build` job benne van, de amíg a repo Secrets nincs beállítva GitHubon, nem blokkoló.

### 8. Cron ellenőrzés élőben
- A `/api/cron/refresh-trends` végpontot **manuálisan meghívtuk kétszer** (max 20 tétel/hívás limit miatt) — mind a 31 lejárt `tracked_trend_candidates` sikeresen frissült, a `next_check_at` helyesen egy jövőbeli időpontra ugrott. A logika HELYES, csak eddig soha nem futott automatikusan, mert **nincs éles Vercel deploy** — a `vercel.json` cron csak deploy után aktiválódik.

### 9. Üzleti/pénzügyi elemzés — kredit-csomagok nyereségessége
- Valós token-fogyasztás (a saját `ai_usage_logs` adatból) + a ténylegesen megerősített Serper ár ($1/1000 keresés = $0.001/keresés) alapján: **a modell nyereséges, ~70-80%-os bruttó árréssel**, minden csomagnál (Starter/Creator/Pro), még pesszimista (user minden kreditjét a legdrágább funkcióra költi) forgatókönyvben is.
- **Talált mellékes hiba** (nem javítottuk még): `lib/credits.ts` `estimateCost()` — a `MODEL_PRICING` kulcsai (`claude-sonnet-4-5`, `claude-3-5-haiku-20241022`) NEM egyeznek a ténylegesen használt modell ID-kkal (`claude-sonnet-4-6`, `claude-haiku-4-5-20251001`), ezért minden Haiku-hívás Sonnet-áron (~12x túlbecsülve) kerül be az `ai_usage_logs.estimated_cost_usd` mezőbe. Ez csak belső monitorozási hiba, a tényleges kreditlevonást NEM érinti.
- **Talált, még nem javított rés**: a pricing oldalon hirdetett "Napi soft limit: 10/30/100 kredit" ([app/dashboard/credits/page.tsx](app/dashboard/credits/page.tsx)) **csak marketing-szöveg**, a háttérben semmi nem kényszeríti ki — egy user egy nap alatt elköltheti a teljes havi kreditkeretét.

---

## ⏳ KÖVETKEZŐ SESSION TEENDŐI (prioritás szerint)

1. **`estimateCost()` MODEL_PRICING kulcsainak javítása** (`lib/credits.ts`) — hogy a belső költség-monitorozás pontos legyen.
2. **Napi soft limit tényleges kikényszerítése** (vagy a pricing oldali szöveg levétele, ha nem lesz belőle valódi korlát).
3. **Éles deploy** — ehhez: `CRON_SECRET` beállítása Vercelen, Stripe éles mód/webhook ellenőrzése.
4. **Fontold meg a dupla-írás konszolidálását**: a Viral Score jelenleg MIND a `viral_score_searches`, MIND a `paid_results` táblába ír (nem hibás, csak redundáns tech-adósság).
5. **Serper ingyenes keret figyelése**: jelenleg még ingyenes tier-en van (2500 keresésből ~1942 maradt) — kb. 90-100 további Opportunity Engine futás után elfogy, utána valós $ költség kezdődik (de a mostani elemzés szerint az is jól fedezett).

---

## MIGRÁCIÓK

Korábbi session-ekből (014-017) + a mostaniból újak, MIND lefuttatva élesben:
- `018_viral_score_searches.sql`
- `019_paid_results.sql`
- `020_paid_results_script_extract.sql`

---

## KULCS FÁJLOK (ezen session által érintett)

### Backend:
- `app/api/viral-score/route.ts` — Serper webes visszhang, relevancia-szűrés, kredit-fix, perzisztens cache
- `app/api/video-package/route.ts`, `video-audit/route.ts`, `script-extract/route.ts` — paidResultId GET reopen
- `app/api/opportunity/route.ts` — nap-váltási cache-fix
- `lib/viral-score-cache.ts`, `lib/paid-results/paid-results-service.ts` (Codex) — perzisztens cache helperek
- `lib/core-trust-engine/decide.ts` — teljes ékezet-javítás
- `lib/youtube-service.ts` — HTML entitás dekódolás
- `lib/credits.ts` — CREDIT_COSTS, `estimateCost()` (MÉG HIBÁS, lásd fent)
- `lib/hungarian-output-polish.ts` (Codex) — futásidejű szöveg-polish patch réteg

### Frontend:
- `app/dashboard/viral-score/page.tsx` — cache-first reopen, "Frissítés" gomb, webes visszhang megjelenítés
- `app/dashboard/video-package/page.tsx` — profil niche vs. aktuális téma UX, paidResultId reopen
- `app/dashboard/video-audit/page.tsx`, `script-extractor/page.tsx` — paidResultId reopen
- `app/dashboard/credits/page.tsx` — csomagár-definíciók (Starter/Creator/Pro + top-up)

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
