# AI Provider Layer & Service Layer Refaktor — Audit + Terv

**Létrehozva**: 2026-07-08 (Phase 1 #12 előkészítés, `CREATOR_OS_PLAN_STATUS.md` alapján)
**Ez a kör**: csak audit + tervezés, KÓD NEM VÁLTOZOTT. A user kifejezetten kérte, hogy előbb ne módosítsunk fájlt, adatbázis-sémát, route-ot, billing logikát.
**Módszer**: 3 párhuzamos, read-only Explore agent auditálta mind a 32 API route-ot + a megosztott lib fájlokat.

---

## 1. VEZETŐI ÖSSZEFOGLALÓ — amit találtunk

A rendszer működik és élesben tesztelt, de az infrastruktúra (kredit, cache, AI-hívás) **route-onként újra van írva**, nem egy közös rétegen keresztül. Ez azt jelenti, hogy egy "AI provider layer" bevezetése valójában egy **7 réteg service-extraction** projekt, nem csak "tegyünk egy wrappert az Anthropic hívás köré".

Konkrét, eddig nem dokumentált hibák/rések, amiket az audit talált (ezek NEM az AI provider layer hiányából fakadnak, hanem önálló problémák — külön kell kezelni őket):

| # | Hiba | Hol | Súlyosság |
|---|---|---|---|
| 1 | **Stripe webhook nincs idempotens** — nincs `event.id` dedup, egy Stripe retry duplán jóváírhat kreditet | `app/api/stripe/webhook/route.ts` | 🔴 Kritikus, billing |
| 2 | Webhook dev-mode signature bypass — ha `STRIPE_WEBHOOK_SECRET` vagy a header hiányzik, ellenőrzés nélkül fut le a payload | `app/api/stripe/webhook/route.ts` | 🔴 Kritikus, csak env-hiba esetén él |
| 3 | Webhook hibát nyel, mégis 200-at ad vissza — DB hiba esetén a user fizet, kreditet nem kap, Stripe nem próbálja újra | `app/api/stripe/webhook/route.ts` | 🔴 Kritikus, billing |
| 4 | Top-up/renewal kredit-jóváírás **read-then-write, nem atomi** — versenyhelyzetben kredit veszhet el | `app/api/stripe/webhook/route.ts` | 🟠 Magas, billing |
| 5 | `MODEL_PRICING` táblában elavult modellnevek (`claude-sonnet-4-5`, `claude-3-5-haiku-20241022`) — nem egyeznek a valós `lib/models.ts` ID-kkal, ezért a Haiku-hívások Sonnet-áron lesznek költségbecsülve | `lib/credits.ts` | 🟠 Magas, költségkontroll |
| 6 | `opportunity-explain` és `opportunity-similar` route **nem von le kreditet** (`CREDIT_COSTS.opportunity_explain = 1` definiálva van, de sosem hívódik a `chargeFeature`) | `app/api/opportunity-explain/route.ts`, `app/api/opportunity-similar/route.ts` | 🟠 Magas, bevétel-kiesés |
| 7 | `video_package_id`-t mentő route (`video-packages`) **sosem ír `paid_results`-ba**, és nincs kredit-ellenőrzése — teljesen a kliens fegyelmére van bízva, hogy tényleg fizetett generálás után hívja | `app/api/video-packages/route.ts` | 🟠 Magas |
| 8 | `dashboard/tracked-trends/deep-refresh` — kredit-ellenőrzés és -levonás két külön, nem atomi lépés, a drága külső hívások (YouTube+Serper) UTÁN történik a terhelés; nincs input-hash védelem, ismételt hívás újra fizetős munkát indít | `app/api/dashboard/tracked-trends/deep-refresh/route.ts` | 🟠 Magas |
| 9 | `cron/refresh-trends` — ha a `CRON_SECRET` env var üres, az endpoint hitelesítés nélkül hívható, YouTube kvótát égethet bárki | `app/api/cron/refresh-trends/route.ts` | 🟡 Közepes |
| 10 | `paid_results.provider/model/prompt_template_id/prompt_version/estimated_cost` oszlopok (021-es migráció) **egyetlen route-ból sincsenek kitöltve** — a `savePaidResult()` TS típusa nem is fogadja el ezeket a mezőket | mindenhol | 🟡 Közepes, ez pontosan a #12 tétel hiánya |
| 11 | Két párhuzamos kredit-rendszer ugyanazon a `user_credits` táblán: `lib/credits.ts` (`chargeFeature`) és `lib/usage-protection.ts` (`chargeProtectedFeature`) — mindkettő saját optimistic-lock update-et ír ugyanarra az oszlopra | `lib/credits.ts` vs `lib/usage-protection.ts` | 🟡 Közepes, karbantartási kockázat |
| 12 | `script-extract`: ha a Claude-hívás sikeres, de az utána jövő `chargeFeature` hívás elhasal, a user ingyen kapja az eredményt (a hiba csendben elnyelődik) | `app/api/script-extract/route.ts` | 🟡 Közepes |

**Ezekből 1-4 (Stripe webhook) és 6-8 (hiányzó kredit-levonás) a legfontosabbak — ezek valós pénzt/bevételt érintenek, függetlenül az AI provider layertől.** Javaslom, hogy ezeket különítsük el egy saját, kis, célzott javítás-körre, NE keverjük bele az AI-provider-layer refaktorba (más a blast radius, más a tesztelési igény).

---

## 2. TELJES ROUTE-TÉRKÉP (32 route)

Jelmagyarázat a Kockázat oszlopban: 🟢 alacsony (nincs pénz/AI/külső API), 🟡 közepes, 🔴 magas (pénz + AI + külső API egyszerre).

### Infrastruktúra / olvasó route-ok (alacsony kockázat, biztonságos elsőként hozzányúlni)

| Route | Cél | Táblák | Kredit | AI | Külső API | Paid result | Input hash | Kockázat |
|---|---|---|---|---|---|---|---|---|
| `api/profile` | Profil frissítés | `profiles` | – | – | – | – | – | 🟢 |
| `api/facts` | Wikipedia+Serper fact-lookup | – | – | – | Wikipedia, Serper | – | nincs (nem is gond, olcsó) | 🟢 |
| `api/credits` | Kredit egyenleg lekérdezés | `user_credits` | olvasás | – | – | – | – | 🟢 |
| `api/credit-check` | Előzetes jogosultság-ellenőrzés | (usage-protection-n át) | ellenőrzés | – | – | – | – | 🟢 |
| `api/feedback` | Like/dislike mentés | `topic_feedback` | – | – | – | – | – | 🟢 |
| `api/quota` | YouTube kvóta állapot (memóriából) | – | – | – | – | – | – | 🟢 |
| `api/dashboard-stats` | Dashboard aggregáció | `user_credits`, `creator_memory`, `video_packages`, `video_audits`, `opportunity_cache`, `ai_usage_logs` | olvasás | – | – | – | – | 🟢 (átfedés a summary route-tal) |
| `api/dashboard/summary` | Command Center payload | 12 tábla (olvasás) | olvasás | – | – | olvasás | – | 🟢 kockázat, de 579 sor, magas komplexitás |
| `api/dashboard/tracked-trends` | Figyelt trendek listája | `tracked_trend_candidates`, `trend_candidate_snapshots` | – | – | – | – | – | 🟢 |
| `api/dashboard/tracked-trends/videos` | Cache-elt bizonyíték videók | `tracked_trend_candidates`, `youtube_videos`, `youtube_video_snapshots` | – | – | – | – | – | 🟢 |
| `api/dashboard/trend-feed-history` | 7 napos trend snapshot history | `trend_feed_daily_snapshots` | – | – | – | – | – | 🟢 |
| `api/video-ideas` | `video_ideas` CRUD | `video_ideas` | – | – | – | – | átadva, nem ellenőrizve | 🟢 |
| `api/video-audits` | Audit lista | `video_audits` | – | – | – | – | – | 🟢 |
| `api/video-audits/[id]` | Egy audit lekérése | `video_audits` | – | – | – | – | – | 🟢 |
| `api/source-video-analysis` | Elemzés mentése (passthrough) | `source_video_analysis` | – | – | – | – | nincs | 🟢 |
| `api/quick-extract` | YouTube metaadat gyors kinyerés | – | **nincs** | – | YouTube (saját raw fetch) | – | – | 🟢 |
| `api/memory` | Creator Memory CRUD (ma mélyítve) | `creator_memory`, `video_idea_*` | – | – | – | – | – | 🟢 |
| `api/video-packages` | Kész csomag mentése | `video_packages`, `video_ideas` | **hiányzik (lásd hiba #7)** | – | – | **nincs** | nincs | 🟡 |
| `api/dashboard/tracked-trends/deep-refresh` | Manuális trend mélyfrissítés | `tracked_trend_candidates`, snapshot táblák | igen, de nem atomi (hiba #8) | – | YouTube, Serper | **nincs** | **nincs** | 🟠 |
| `api/cron/refresh-trends` | Cron trend frissítés | trend táblák | nem user-fizetős | – | YouTube (csak stats) | – | – | 🟡 (auth-rés lehetőség, hiba #9) |

### Stripe / billing (mindig magas kockázat, lásd 5. szakasz "NE NYÚLJ HOZZÁ")

| Route | Kockázat |
|---|---|
| `api/stripe/create-subscription-session` | 🔴 |
| `api/stripe/create-topup-session` | 🔴 |
| `api/stripe/customer-portal` | 🟡 (csak olvasás, de billing-adjacent) |
| `api/stripe/webhook` | 🔴🔴 a legkritikusabb fájl az egész repóban |

### AI-hívó, kredit-terhelő route-ok (ez az, amit az "AI provider layer" ténylegesen érintene)

| Route | AI hívás(ok) | Provider/SDK módja | Kredit mechanizmus | Paid result | Input hash | Kockázat |
|---|---|---|---|---|---|---|
| `api/opportunity` | 1 közvetlen + 1 közvetett (`lib/trend-radar.ts`) | saját `new Anthropic()` + raw fetch a lib-ben | `usage-protection.ts`, **hardkódolt `2`** kredit | igen (`savePaidResult`) | igen, DE 2 párhuzamos cache-rendszer is fut | 🔴 legnagyobb fájl (905 sor) |
| `api/opportunity-explain` | 1 | saját `new Anthropic()` | **nincs levonás (hiba #6)** | nincs | nincs | 🟡 kicsi fájl, de bevétel-kiesés |
| `api/opportunity-similar` | 1 | saját `new Anthropic()` | **nincs levonás (hiba #6)** | nincs | nincs | 🟡 |
| `api/viral-score` | 1 | saját `new Anthropic()` | `lib/credits.ts` (`chargeFeature`) | igen | igen, DE 2 párhuzamos cache (legacy + paid_results) | 🔴 |
| `api/video-package` | 2 (creative core + packaging) | saját `new Anthropic()` | `lib/credits.ts` | igen (+ legacy hash fallback) | igen | 🔴 legösszetettebb prompt-logika |
| `api/video-audit` | 1 | **raw fetch**, nincs SDK | `lib/credits.ts` | igen | igen | 🔴 egyedüli raw-fetch route + saját YouTube-fetch reimplementáció |
| `api/script-extract` | 1 | saját `new Anthropic()` | `lib/credits.ts` | igen | igen | 🟠 "charge after AI succeeds" sorrendi kockázat (hiba #12) |
| `api/transcript` | 1 (**OpenAI Whisper**, nem Claude!) | raw fetch OpenAI-hoz | `lib/credits.ts` | igen | igen, fájl-hash alapú (legjobb minta a repóban) | 🟡 önálló, jól elszigetelt |
| `api/similar-videos` | 1 közvetett (`lib/similar-query-expansion.ts`) | raw fetch a lib-ben | `usage-protection.ts` | igen (+ legacy cache mirror) | igen, 2 párhuzamos cache | 🔴 legnagyobb fájl (873 sor) |

**Összesen 8 önálló hívási pont** hívja közvetlenül vagy közvetve az Anthropic API-t (6 SDK-s + 2 raw-fetch route + 2 raw-fetch shared lib), és **1 route** (transcript) hívja az OpenAI-t. Egy valódi provider-abstraction ezt a 9 helyet váltaná ki egyetlen belépési ponttal.

---

## 3. AZONOSÍTOTT DUPLIKÁCIÓK (amiket a service layer megszüntetne)

- **`new Anthropic(...)` 6x újra-instanciálva** (opportunity, opportunity-explain, opportunity-similar, viral-score, video-package, script-extract) + **2x raw-fetch reimplementálva** (video-audit route, `lib/trend-radar.ts`, `lib/similar-query-expansion.ts`).
- **`extractJson()` / JSON-kinyerő logika** külön-külön újraírva majdnem minden AI-hívó route-ban, eltérő robusztussággal (viral-score-é pl. gyengébb, sima `JSON.parse`).
- **YouTube "fetch egy videó adatait" logika 4x újraírva** (`video-audit`, `script-extract`, `quick-extract` mind saját raw fetch-et használ a `googleapis.com/youtube/v3/videos`-hoz, ahelyett hogy a meglévő `lib/youtube-service.ts`-t hívnák).
- **`fetchSerper` 2x újraírva** (`api/facts`, `api/dashboard/tracked-trends/deep-refresh`).
- **Két párhuzamos kredit-rendszer**: `lib/credits.ts` (`chargeFeature`) és `lib/usage-protection.ts` (`chargeProtectedFeature`) — ugyanazt az optimistic-lock update mintát írják újra a `user_credits` táblán, más költség-táblával.
- **Két párhuzamos cache/dedup rendszer** `viral-score`-nál (legacy `viral_score_searches` + `paid_results`) és `similar-videos`-nál (legacy `similar_video_searches` + `paid_results`) — mindkettő dupla hash-t számol és dupla helyre ment.
- **`DECISION_LABELS` szótár 3x másolva** (`video-audit`, `video-audits`, `video-audits/[id]`).
- **`promoteToTrackedCandidate(...).catch(() => {})` fire-and-forget blokk** szó szerint duplikálva (`memory/route.ts`, `video-packages/route.ts`).
- **Video Idea proof-signal mentési minta** (hash építés → `ensureVideoIdea` → `addVideoIdeaProofSignal` loop → `logVideoIdeaEvent`) szinte azonos szerkezetben `viral-score` és `similar-videos` route-okban — ez már jó jelölt egy megosztott `recordVideoIdeaEvidence()` service-függvényre.
- **`lib/supabase-server.ts` client-boilerplate** újraimplementálva 4+ helyen ahelyett, hogy importálnák.

A **jól működő minta**, amit érdemes lekövetni: `lib/video-ideas/video-idea-service.ts` és `lib/paid-results/paid-results-service.ts` — ezek már valódi, megosztott service-ek, amiket a route-ok konzisztensen hívnak (nem újraírják a logikájukat). A refaktor célja, hogy a kredit- és AI-hívás-logika is elérje ugyanezt az érettségi szintet.

---

## 4. JAVASOLT SERVICE LAYER

```
lib/services/
  ai-provider-service.ts     ← ÚJ, ez a "#12 AI provider layer" tényleges magja
  credit-service.ts          ← ÚJ, egyesíti lib/credits.ts + lib/usage-protection.ts
  paid-result-service.ts     ← MÁR LÉTEZIK (lib/paid-results/paid-results-service.ts), csak bővül
  input-hash-service.ts      ← ÚJ, kiemeli a szétszórt hash-builder függvényeket
  video-idea-service.ts      ← MÁR LÉTEZIK (lib/video-ideas/video-idea-service.ts), változatlan
  youtube-service.ts         ← MÁR LÉTEZIK (lib/youtube-service.ts), csak a duplikált raw-fetch hívásokat kell rá átterelni
  memory-service.ts          ← ÚJ (opcionális), kiemelné a mai `enrichMemoryItems` logikát a route-ból
```

### `ai-provider-service.ts` — a tényleges "#12" tétel
```ts
type AIProviderName = 'anthropic' | 'openai'

interface AICallInput {
  provider: AIProviderName
  model: string
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxTokens: number
  promptTemplateId?: string   // pl. 'opportunity_titles'
  promptVersion?: string      // pl. 'v1'
}

interface AICallResult {
  text: string
  provider: AIProviderName
  model: string
  usage: { inputTokens: number; outputTokens: number }
  estimatedCost: number       // a lib/credits.ts MODEL_PRICING javított táblájával
  promptTemplateId?: string
  promptVersion?: string
}

async function callAIProvider(input: AICallInput): Promise<AICallResult>
function extractJson<T>(text: string): T   // egyetlen, robusztus verzió a jelenlegi 6+ helyett
```
Ez a wrapper NEM ír adatbázisba — csak hív és visszaad egy egységes `AICallResult`-ot, amit a hívó route ad tovább a `paid-result-service.ts`-nek. Így a `paid_results.provider/model/prompt_template_id/prompt_version/estimated_cost` mezők (021-es migráció, ma üresek) végre kitöltődnek, mert a `savePaidResult()` inputja bővül ezekkel a mezőkkel.

### `credit-service.ts` — egyesíti a 2 párhuzamos rendszert
Egy közös `deductCredits(userId, cost, metadata)` primitív (a mai `chargeFeature`/`chargeProtectedFeature` optimistic-lock update-jének egyszeri, közös implementációja), amire mindkét mai fogyasztási minta (fix kredit-ár vs. napi ingyenes limit + kredit) ráépül. Ez NEM változtatja meg a kredit-árakat vagy a napi limiteket — csak az update-mechanikát egyesíti.

### `input-hash-service.ts`
A ma szétszórt `buildPaidResultHash`, `buildViralScoreHash`, `buildSearchContextHash`, `buildVideoIdeaInputHash` egy helyre kerülne, egységes `normalizeText`/hash-építő logikával. A cél hosszú távon a legacy cache-táblák (`viral_score_searches`, `similar_video_searches`) kivezetése, de ez NEM ennek a körnek a része (lásd 6. szakasz — külön fázis).

---

## 5. "NE NYÚLJ HOZZÁ EBBEN A KÖRBEN" — billing-kritikus felület

A user explicit kérése: a billing logika nem változhat emiatt a refaktor miatt. Konkrétan érintetlenül kell hagyni:

1. **`app/api/stripe/webhook/route.ts` teljes switch-blokkja** és a read-then-write kredit-matematikája — az 1-4. hibák valós problémák, de **külön, dedikált, billing-fókuszú körben** kell javítani, nem az AI-provider-layer mellékhatásaként.
2. A `metadata.user_id/plan/package` string-kontraktus a 2 session-létrehozó route és a webhook között.
3. A `PLANS`/`TOPUPS` struktúra `lib/stripe.ts`-ben, beleértve a HUF-hardkódolt `price` mezőt.
4. Bármi, ami a `user_credits` táblán a **jóváírás** (crediting) oldalát érinti — a service layer csak a **levonás** (deduction) oldalát egységesíti, a webhook crediting-logikáját nem.

---

## 6. FÁZISOKRA BONTOTT IMPLEMENTÁCIÓS TERV

Minden fázis külön commit, külön build+tsc ellenőrzés, és — ahol értelmezhető — élő böngészős teszt a preview szerveren, mielőtt a következő fázis elindul.

### Fázis A — Alapréteg, nulla route-módosítás (legalacsonyabb kockázat)
- Létrehozni `lib/services/ai-provider-service.ts`-t: `callAIProvider()`, `extractJson()`, provider='anthropic' implementáció (OpenAI stub egyelőre csak típus szinten).
- Javítani a `MODEL_PRICING` drift hibát (#5) `lib/credits.ts`-ben — ez önmagában egy 1-soros, biztonságos, azonnal értékes fix, függetlenül a többi fázistól.
- Bővíteni `paid-results-service.ts` `savePaidResult()` inputját az 5 új mezővel (provider/model/prompt_template_id/prompt_version/estimated_cost) — bővítés, nem törés, a mezők opcionálisak maradnak.
- Nincs route átírva. Build+tsc zöld. Semmi élesben nem változik.

### Fázis B — Egy alacsony kockázatú route próbaként
- `api/opportunity-explain` és `api/opportunity-similar` átállítása `callAIProvider()`-re, ÉS **egyúttal kijavítva a #6 hibát** (tényleges kredit-levonás bekötése) — ezt érdemes külön megbeszélni a userrel, mert ez bevétel-növelő viselkedésváltozás, nem csak refaktor (a user eddig ingyen kapta ezt a műveletet).
- Ez a 2 route a legkisebb (76-82 sor), legkevesebb függőségű a 9 AI-hívó route közül — ideális "bizonyítsd be, hogy működik" lépés éles forgalommal.

### Fázis C — A nagy, kredit-terhelő route-ok egyenként
Sorrend a kockázat/érték arány szerint, **egyesével, nem egyszerre**:
1. `viral-score` (már a mai session-ben is bővítettük a video-idea integrációt, jól ismerjük)
2. `script-extract` (kis fájl, 1 AI hívás, de javítsuk a "charge after AI succeeds" sorrendet is #12 mellékhatásként)
3. `video-package` (2 AI hívás, legösszetettebb prompt-logika — ide kell a legtöbb regressziós teszt)
4. `video-audit` (raw-fetch → SDK migrálás + YouTube-fetch átterelése `lib/youtube-service.ts`-re)
5. `opportunity` (legnagyobb, két cache-rendszer — ezt hagynám utoljára, itt a legnagyobb a törés esélye)
6. `similar-videos` (hasonlóan nagy és összetett, szintén utolsók között)

### Fázis D — Kredit-rendszer egyesítés
- `credit-service.ts` bevezetése, `lib/credits.ts` és `lib/usage-protection.ts` ráépítése a közös primitívre — ez csak azután, hogy minden AI-hívó route már stabilan megy az új provider-rétegen, mert ez a legkockázatosabb belső mechanika-csere (a `user_credits.balance` optimistic lock).

### Fázis E — Hiányzó kredit-védelmi lyukak (külön döntés kell userrel)
- #7 (`video-packages` nincs kredit/paid_results védelem), #8 (`deep-refresh` nem-atomi kredit+nincs input-hash) — ezek üzleti döntést igényelnek (mennyi kreditet vonjunk le, van-e már éles felhasználó, aki megszokta az ingyenes viselkedést), ezért NEM automatikusan javítom, hanem külön felvetem, mielőtt bármit változtatok.

### Fázis F (később, nem most) — Stripe webhook idempotencia + atomi kredit-matematika
Ez teljesen független az AI provider layertől, de a legsúlyosabb találat volt — javaslom, hogy ezt vegyük fel önálló, soron kívüli tételként, ne várjunk vele a Phase 2/3-ig.

---

## 7. JAVASOLT KÖVETKEZŐ LÉPÉS

Azt javaslom, hogy **Fázis A-val kezdjünk** (nulla route-kockázat, tiszta alapozás), utána álljunk meg és nézzük át együtt, mielőtt bármelyik éles, kredit-terhelő route-hoz hozzányúlnánk (Fázis B/C). A Fázis F-et (Stripe webhook idempotencia) pedig érdemes lenne mielőbb, ettől a refaktortól függetlenül napirendre venni, mert ez valós bevétel-kockázat, nem csak kód-tisztaság.
