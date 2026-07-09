# WILLVIRAL CREATOR OS — MESTERTERV ÁLLAPOT

**Cél**: ez a fájl a "VÉGLEGES FEJLESZTÉSI UTASÍTÁS CODEXNEK — WILLVIRAL CREATOR OPERATING SYSTEM" nevű mesterterv (lásd lent, teljes szöveg) végrehajtási állapotát követi, session-eken át. Új session elején OLVASD EL EZT ELŐSZÖR, utána a `CLAUDE_HANDOVER.md`-t (az általánosabb, git/deploy/migráció-fókuszú átadás).

**Utolsó frissítés**: 2026-07-09
**Utolsó commit ebben a körben**: ld. git log — Phase 1 #10 mélyítés, #12 AI provider layer audit+Fázis A/B/C(1/6), és egy önálló, súlyos Stripe webhook billing-hiba javítása (ld. lent).

**KRITIKUS, 2026-07-09-i találat**: a Stripe webhook `user_credits` táblára vonatkozó feltételezése (külön `topup_credits`/`subscription_credits` oszlop) SOSEM egyezett a valós sémával (csak egy közös `balance` van) — a webhook eredeti kódja emiatt minden éles crediting-eseményre (előfizetés-indítás, topup, renewal) hibázott volna, amit a régi "nyeld el a hibát, adj 200-at" logika örökre elrejtett volna. Javítva + élőben tesztelve, ld. [AI_PROVIDER_LAYER_REFACTOR_PLAN.md](AI_PROVIDER_LAYER_REFACTOR_PLAN.md) Fázis F.

---

## HOGYAN HASZNÁLD EZT A FÁJLT

1. Nézd meg a "PHASE 1 RÉSZLETES ÁLLAPOT" táblázatot — ott van, mi kész, mi részleges, mi nincs.
2. A "KÖVETKEZŐ LÉPÉS JAVASLAT" szakasz mondja meg, mivel érdemes folytatni.
3. A "NYITOTT DÖNTÉSEK / KÜLSŐ FÜGGŐSÉGEK" szakasz azokat a pontokat listázza, amik NEM tisztán kódolási kérdések (pl. Stripe-fiók, YouTube API kvóta, cégalapítás).
4. A fájl alján megtalálod a TELJES eredeti mestertervet, hogy ne kelljen újra beilleszteni.

---

## GYORS ÖSSZEFOGLALÓ

| Fázis | Állapot |
|---|---|
| **PHASE 1 — Creator OS alap** | 10/12 kész, 2/12 részleges, 0/12 nincs elkezdve |
| **PHASE 2 — Versenyképes platform funkciók** | 0/10 — egyik sincs elkezdve |
| **PHASE 3 — Globális SaaS / Agency** | 0/10 — egyik sincs elkezdve (ez várható is volt ezen a ponton) |

---

## PHASE 1 RÉSZLETES ÁLLAPOT

| # | Tétel | Állapot | Megjegyzés |
|---|---|---|---|
| 1 | Video Idea központi adatmodell | ✅ Kész | `video_ideas`, `video_idea_proof_signals`, `video_idea_events` táblák (migráció 021). Mezők szinte szó szerint egyeznek a tervvel. |
| 2 | Command Center redesign | ⚠️ Részleges (5/7 szekció) | Megvan: Today's Best Opportunities, **Proof Signals** (ma), Ready-to-Create, Tracked Trends, Next Best Action. Hiányzik: Competitor Moves, Keyword Opportunities — ezekhez előbb kell a mögöttes modul (Phase 2). |
| 3 | Creator-barát navigáció | ⚠️ Részleges | **Elnevezés kész** (Opportunity Engine→Videólehetőségek, Similar Videos→Piaci bizonyítékok, Viral Score→Virális esély, Video Audit→Videódiagnózis, Creator Memory→Tartalommemória, Video Package→Gyártási csomag, Áttekintés→Creator központ). **A menüSZERKEZET nincs újratervezve** a tervben szereplő 15 modulra (Ideas/Trends/Keywords/Competitors/Packages/SEO/Thumbnail/Audit/Calendar/Analytics/Memory/Coach/Billing/Settings) — mert Keywords/Competitors/SEO/Thumbnail/Calendar/Analytics/Coach még nem létező oldalak. |
| 4 | Paid Results stabilizálás | ✅ Kész | Élőben tesztelve korábbi sessionökben és ma is. |
| 5 | Kredit confirmation modal | ✅ Kész | `CreditConfirmModal.tsx`, minden fizetős művelet előtt. |
| 6 | Input hash duplikációvédelem | ✅ Kész | `lib/paid-results/paid-results-service.ts`, minden fizetős tool-on. |
| 7 | Similar Videos proof signal mentés | ✅ Kész | `app/api/similar-videos/route.ts` — sikeres keresésnél `ensureVideoIdea` + proof signal (`signal_type: similar_video`) + `similar_videos_completed` event. Élőben tesztelve. |
| 8 | Viral Score magyarázható eredményoldal | ✅ Kész | `app/api/viral-score/route.ts` — freshness, proof_strength, niche_fit, risk_level (backend számolt) + hook_potential, audience_curiosity, platform_fit, production_difficulty (Claude-ítélt, valós adatra alapozva). Frontend: "Miért ez a pontszám?" kártya. Élőben tesztelve valós adattal. |
| 9 | Video Package prémium eredményoldal | ✅ Kész (platform-specifikus verziók nélkül) | 3 hook (volt 1), thumbnail_concept, pinned_comment, why_it_works, risks, production_checklist, "Naptárba mentés" gomb (→ `/api/video-ideas` PATCH `calendar_status`). Élőben tesztelve, DB-ben ellenőrizve. Hiányzik: platform-specifikus verziók (külön funkció), "későbbi audit" gomb (tudatosan kihagyva — nincs mit auditálni publikálás előtt). |
| 10 | Creator Memory státuszokkal | ✅ Mélyítve (2026-07-08, második kör) | `app/api/memory` PATCH mostmár szinkronizálja a linkelt `video_ideas.workflow_status`-t (`saved→validated`, `in_progress→validating`, `completed→published`, `rejected→rejected`) és logol egy `state_changed` eseményt (`lib/video-ideas/video-idea-service.ts: setVideoIdeaWorkflowStatus`). A `/dashboard/memory` oldal és a `CreatorMemoryPanel` (utóbbi jelenleg NINCS bekötve egyetlen oldalba sem — orphan komponens) mostmár megjeleníti a proof signal összesítőt (erős/közepes/gyenge/elutasított darabszám) és egy kibontható esemény-idővonalat kártyánként. Új: `matchRelatedOutcomes` (`lib/video-ideas/video-idea-service.ts`) topic-szó-átfedés (Jaccard) alapján megkeresi a user korábbi `published`/`audited`/`rejected` állapotú Video Idea-i között a leghasonlóbbat, és `💡 Hasonló téma korábban bejött nálad` / `⚠️ Hasonló témát már elutasítottál` jelzést ad — élőben tesztelve valós adaton, működik. **Amit ez NEM tartalmaz**: nincs valós YouTube performance-alapú tanulás (az OAuth/csatorna-analytics Phase 3-as), a hasonlóság-keresés csak topic-szöveg átfedésen alapul (niche mező gyakorlatilag sosem töltődik ki egyetlen aktív route-ból sem, ezért nem használható matching-alapnak). |
| 11 | language / market / platform mezők | ⚠️ Részleges | `video_ideas` táblában megvan (language/market/country/currency/timezone). **A Stripe árazás VÁLTOZATLANUL kőkeményen HUF-ra hardkódolva** (`lib/stripe.ts`, `app/dashboard/credits/page.tsx`). Nincs currency/market selector a UI-n. Multi-currency-hez **valós Stripe termékek/árak létrehozása szükséges a Stripe dashboardon — ez a userre vár, nem kódolható meg helyette.** |
| 12 | AI provider layer alap | ✅ Fázis A+B+C KÉSZ (2026-07-08), 9/9 AI-hívó route/lib átállítva | Audit+terv: [AI_PROVIDER_LAYER_REFACTOR_PLAN.md](AI_PROVIDER_LAYER_REFACTOR_PLAN.md). **Fázis A**: `lib/services/ai-provider-service.ts` (új), `MODEL_PRICING` drift javítva, `savePaidResult()` bővítve. **Fázis B**: `opportunity-explain`+`opportunity-similar` átállítva, hiányzó kredit-levonás pótolva. **Fázis C (6/6, LEZÁRVA)**: `viral-score`, `script-extract`, `video-package`, `video-audit`, `similar-videos` (lib-en át), `opportunity` — MIND átállítva `callAIProvider()`+`extractJson()`-re. Az `opportunity` route volt a legnagyobb (905 sor) és 2 különálló AI-hívási pontot tartalmazott: a route saját explanation-hívása ÉS a `lib/trend-radar.ts` `rewriteTopicWithHaiku()` (ez utóbbi egy korábban hardkódolt `'claude-haiku-4-5-20251001'` stringet is használt `MODELS.fast` helyett — ezt is javítottam). Mindkettőt migráltam, `opportunityAiCall` csak akkor kerül a `savePaidResult()`-ba, ha a route explanation-hívása ténylegesen lefutott (nem cache-hit/nulla candidate esetén). A `rewriteTopicWithHaiku` kizárólag a `buildTrendCandidates`-en keresztül fut, amit egyedül az `opportunity` route használ — ellenőrizve, zéró kereszthatás. **Ezzel a teljes repóban NULLA route/lib hív már közvetlenül Anthropic API-t** — mind a 9 hívási pont (6 SDK + 2 raw-fetch route + 1 raw-fetch lib, korábbi audit szerint, plusz a trend-radar-beli 2. raw-fetch) a közös rétegen megy át. Élőben tesztelve: valós niche-keresés (`force_refresh: true`), mindkét AI-hívási pont lefutott (route explanation + 17+ sikeres trend-radar Haiku rewrite logolva), 2 kredit levonva pontosan egyszer (59→57), valós magyar hook/cím generálva, cache-reopen ingyenes. **Fázis D (kredit-rendszer egyesítés) és Fázis E-F (nyitott hibák: Stripe webhook idempotencia stb.) NEM indultak el — külön döntés kell rájuk.** |

---

## PHASE 2 — folyamatban (2026-07-09-től), a user kérésére mind a 10 modult megépítjük

**Séma-alap**: [023_phase2_modules_foundation.sql](supabase/migrations/023_phase2_modules_foundation.sql) — EGY migrációban az összes modulhoz szükséges `paid_results` tool_type bővítés (`keyword_research`, `competitor_tracker`, `outlier_detector`, `title_studio`, `thumbnail_studio`, `seo_optimizer`) + `tracked_competitors`/`tracked_competitor_videos`/`trend_alert_dismissals` táblák. Lefuttatva.

**Mellékesen talált+javított hiba**: [024_creator_memory_missing_columns.sql](supabase/migrations/024_creator_memory_missing_columns.sql) — a `creator_memory` tábla sosem tartalmazott `source_context`/`quality_status` oszlopot, pedig az `app/api/memory` POST route régóta feltételesen írja ezeket — bármely hívó, ami truthy értéket küldött ezekhez, 500-as hibát kapott csendben. A Keyword Research "Mentés" gombjának élő tesztje leplezte le. Javítva, élőben ellenőrizve.

| # | Modul | Állapot | Megjegyzés |
|---|---|---|---|
| 1 | Keyword Research | ✅ Kész (2026-07-09) | `lib/keyword-research.ts` (Serper relatedSearches/peopleAlsoAsk), `app/api/keyword-research/route.ts` (valós YouTube-adat + `buildScoreBreakdown` — nem talált szám, `callAIProvider` a klaszterezéshez), `app/dashboard/keyword-research/page.tsx`. 1 kredit, input-hash cache, `CreditConfirmModal`. Élőben tesztelve: valós keresés (25 YouTube találat), 10 konkrét kulcsszó-javaslat, 1 kredit levonva (57→56), ismételt keresés ingyenes cache-ből, "Mentés Video Idea-ként" működik. |
| 2 | Competitor Tracker | ✅ Kész (2026-07-09) | `lib/competitor-tracker.ts` (`resolveChannel` — URL/@handle/channel ID/névkeresés; `fetchChannelRecentVideos` — kvóta-hatékony `channels`+`playlistItems`+`videos` lánc, 3 egység/ellenőrzés a `search.list` 100 egysége helyett). `app/api/competitors` (GET/POST/DELETE), `app/api/competitors/[id]/refresh`, `app/api/competitors/save-signal` (outlier → `video_idea_proof_signals`, `signal_type: competitor_video`). `app/dashboard/competitors/page.tsx`. 1 kredit hozzáadásért/frissítésért. Élőben tesztelve valós csatornával (@mkbhd → Marques Brownlee, 21.1M feliratkozó): hozzáadás (56→55 kredit), duplikáció-védelem (409), frissítés (55→54), proof signal mentés, törlés — mind hibátlan. |
| 3 | Outlier Detector | ✅ Kész, a Competitor Trackerbe építve (2026-07-09) | Nem külön oldal — a `fetchChannelRecentVideos` minden versenytárs-videóra kiszámolja az `outlier_ratio`-t a csatorna saját átlagához képest (`is_outlier` ha ≥2x), és a UI kiemeli 🔥 jelöléssel. Ugyanaz az adatforrás, külön oldal csak duplikálná. |
| 4 | Title Studio | ✅ Kész (2026-07-09) | `lib/title-studio.ts` (backend heurisztikák: hossz, szám/kérdőjel jelenlét, caps-lock túlzás, clickbait-jel túlzsúfoltság — objektív, nem AI-becsült; `buildTitleStudioPrompt`). `app/api/title-studio/route.ts` (5 cím-variáció `callAIProvider`-rel, mindegyik curiosity/clarity/clickability/risk AI-értékeléssel — UI-n egyértelműen "AI-értékelés", nem mért adat). PATCH: kiválasztott cím mentése `video_ideas.title_ideas`-ba. `app/dashboard/title-studio/page.tsx`. 1 kredit. Élőben tesztelve: 5 valódi, eltérő cím, score-okkal (54→53 kredit), mentés működik, ismételt keresés ingyenes cache-ből. |
| 5 | Thumbnail Studio | Nincs elkezdve | |
| 6 | SEO / Upload Optimizer | Nincs elkezdve | |
| 7 | Content Calendar UI | Nincs elkezdve | A `calendar_status` mező már frissül a Video Package "Naptárba mentés" gombjától, de nincs Calendar NÉZET/oldal. |
| 8 | Video Audit bővítés | Nincs elkezdve | |
| 9 | Trend Alerts | Nincs elkezdve | |
| 10 | Content Gap Finder | Nincs elkezdve | `paid_results.tool_type` már tartalmazza a `content_gap` értéket (021-es migráció). |

## PHASE 3 — MÉG SEMMI NINCS ELKEZDVE

English UI, Stripe globális pricing, YouTube OAuth (saját csatorna analytics), Analytics dashboard, Channel Audit, AI Coach, Team/Agency workspace, PDF report export, böngésző-extension, multi-platform intelligence. Ez a fázis ezen a ponton még nem is várt el semmit.

---

## MÁS, A TERVBEN EXPLICIT KÉRT, DE MÉG HIÁNYZÓ DOLGOK

- **Automatizált tesztek**: a terv kér egy alap teszt-csomagot (kredit levonás, paid result mentés/újranyitás, input hash dedup, Video Idea CRUD/státuszváltás, proof signal mentés, language/market/platform mezők, AI provider választás, API hibakezelés). **Ez nem létezik** — minden idei ellenőrzés kézi, élő böngészős teszt volt, nem egy megmaradó, ismételhető teszt-csomag.
- **Napi soft limit kikényszerítés fizető userekre**: a `CLAUDE_HANDOVER.md` már korábban is jelezte, még mindig nyitott — csak a free-tier userekre van hard limit (`lib/usage-protection.ts`), fizetőkre nincs napi plafon.
- **Prompt Template rendszer**: a promptok még mindig kódba égetve vannak minden route-ban, nincs `prompt_templates` tábla, nincs verziózás/lokalizáció.

---

## NYITOTT DÖNTÉSEK / KÜLSŐ FÜGGŐSÉGEK (nem tisztán kódolási kérdés)

1. **YouTube Data API kvótanövelési kérelem** — a user beadta-e a `support.google.com/youtube/contact/yt_api_form` űrlapot? (Korábbi session-ben megbeszéltük a szöveget és a javasolt 30 000–50 000 egység/nap kérést.) **Nem tudjuk a jelenlegi státuszát.**
2. **Egyéni vállalkozás regisztráció** — a usernek még nincs bejegyzett vállalkozói neve, ez blokkolja a `/privacy` és `/terms` oldalak `[CÉGNÉV / EGYÉNI VÁLLALKOZÓ NEVE]` placeholder véglegesítését, és a tényleges pénzbeszedés elindítását. **Státusza ismeretlen.**
3. **Stripe multi-currency setup** — a Phase 1 #11 teljes lezárásához a usernek kell létrehoznia a nem-HUF Stripe termékeket/árakat a Stripe dashboardon, mielőtt a kód ezekre tudna hivatkozni.
4. **AI provider layer refaktor terjedelme** (Phase 1 #12) — ez az egyetlen Phase 1 tétel, ami MINDEN Claude-hívást érintő route-ot módosítana (opportunity, viral-score, video-package, script-extract, video-audit). Nagyobb a kockázata, mint bármi eddig — érdemes külön megbeszélni, mielőtt nekiállunk.

---

## KÖVETKEZŐ LÉPÉS JAVASLAT

A user korábban ezt a sorrendet hagyta jóvá: **"haladjunk sorban, Phase 1, Phase 2, Phase 3"**. A Phase 1-ből 1 tétel maradt:

1. ~~**#10 Creator Memory mélyítés**~~ — **KÉSZ** (2026-07-08, második kör).
2. ~~**#12 AI provider layer alap**~~ — **KÉSZ a core-refaktor szintjén** (2026-07-08, harmadik kör): mind a 9 AI-hívó route/lib átállítva a közös rétegre, `paid_results` provider/model/cost mezői élesben töltődnek. Amit a master terv eredeti #12 tétele még kér, de EZ a kör nem csinált meg (tudatosan, külön döntés kell): OpenAI mint második provider bekötése az absztrakcióba (jelenleg csak `'anthropic'` van implementálva, típusban van hely `'openai'`-nak), `prompt_templates` tábla/verziózás (jelenleg a `promptTemplateId`/`promptVersion` csak string literál minden hívásnál, nincs mögötte adatbázis), Fázis D (`lib/credits.ts` + `lib/usage-protection.ts` egyesítése egy közös kredit-primitívre).
3. **#11 Multi-currency** — csak akkor zárható le teljesen, ha a user létrehozta a Stripe termékeket. Addig legfeljebb a kód-oldali előkészítés (selector UI, market-alapú ár-lookup logika) mehet.

Az audit (lásd [AI_PROVIDER_LAYER_REFACTOR_PLAN.md](AI_PROVIDER_LAYER_REFACTOR_PLAN.md)) 13 önálló hibát/rést is talált. A legsúlyosabb — **Stripe webhook nem idempotens + a `user_credits` séma sosem egyezett a webhook kódjával** — **KÉSZ (2026-07-09)**, ld. Fázis F. Nyitva maradt, tudatosan: Fázis D (kredit-rendszer egyesítés) és Fázis E (#7 `video-packages`, #8 `deep-refresh` kredit-védelmi lyukak — üzleti döntést igényelnek).

Ezzel a Phase 1 gyakorlatilag lezárva (10/12 kész, #3 és #11 részleges, mindkettő külső/Phase 2 függőségre vár). **Következő lépés a Phase 2** — itt kell megkérdezni a usert, melyik modullal kezdjünk (Keyword Research vagy Competitor Tracker tűnik a legértékesebbnek a Command Center hiányzó két szekciója miatt).

---

## EBBEN A SESSION-BEN TÖRTÉNT (2026-07-08), COMMIT SORREND

```
9722e32 feat: Video Idea Creator OS foundation, Auto Transcript MVP, proof signals, and pre-launch fixes
1e84566 feat: Command Center ranks Video Ideas by proof signal strength, not just scores
a38fef2 feat: rename tool-jargon UI labels to creator-friendly names (Phase 1 #3)
8184575 feat: add Proof Signals section to Command Center (Phase 1 #2)
18cfdce feat: Viral Score becomes an explainable decision score (Phase 1 #8)
864c8c1 feat: Video Package becomes a premium result page (Phase 1 #9)
```

Minden commit előtt/után lefutott: `npx tsc --noEmit --incremental false` + `npm run build`, és a legtöbb változtatást élő böngészős teszttel (bejelentkezve, valós Similar Videos/Viral Score/Video Package futtatással, DB-ből közvetlenül ellenőrizve Supabase REST-en) is megerősítettem, nem csak build-del.

**Semmi nincs push-olva** — a user nem kérte, minden commit lokális.

---

## EBBEN A SESSION-BEN TÖRTÉNT (2026-07-08, második kör) — Phase 1 #10 mélyítés

Módosított/bővített fájlok (MÉG NINCS COMMITOLVA — a user nem kérte):
- `types/index.ts` — `VideoIdeaEvent`, `MemoryProofSignalSummary`, `MemoryOutcomeMatch`, `MemoryInsight` típusok hozzáadva.
- `lib/video-ideas/video-idea-service.ts` — `mapMemoryStateToWorkflowStatus`, `setVideoIdeaWorkflowStatus`, `fetchDecisiveVideoIdeas`, `matchRelatedOutcomes` (topic-token Jaccard-átfedés a `published`/`audited`/`rejected` otletek pool-jan).
- `app/api/memory/route.ts` — GET most proof signal + esemény + insight-tal dúsítja a válaszokat (`enrichMemoryItems`, batch lekérdezéssel, nem N+1). PATCH szinkronizálja a linkelt `video_ideas.workflow_status`-t és logol egy `state_changed` eseményt.
- `app/dashboard/memory/page.tsx` — insight banner, proof signal chip, kibontható esemény-idővonal a `MemoryCard`-on.
- `components/dashboard/CreatorMemoryPanel.tsx` — insight egysoros jelzés (ez a komponens jelenleg NINCS bekötve egyetlen oldalba sem, orphan — nem én okoztam, korábbról így volt).

Ellenőrzés: `npx tsc --noEmit --incremental false` ✅, `npm run build` ✅, élő böngészős teszt bejelentkezve (`/dashboard/memory`): proof signal chip és idővonal helyesen jelent meg valós adaton, PATCH state-váltás ("✅ Kész") ténylegesen frissítette a linkelt Video Idea `workflow_status`-át `published`-re és logolt egy `state_changed` eseményt, majd egy másik, hasonló témájú (`"mesterséges intelligencia"` + `"2026"` szóátfedés) memória-tételen ténylegesen megjelent a `💡 Hasonló téma korábban bejött nálad` insight. A tesztelés után a state-et visszaállítottam `in_progress`-re (a workflow_status emiatt `validating`-re állt, ami helyesebb, mint az eredeti elavult `new_idea` — ez a feature helyes működése, nem hiba).

Tudatos döntés: a `creator_memory` POST-ban (új tétel mentésekor) A RÉGI mapping-et hagytam változatlanul (`rejected→rejected`, `completed→validated`, egyébként `new_idea`) — NEM az új `mapMemoryStateToWorkflowStatus`-t, mert az `in_progress→ready_to_produce` vagy `saved→validated` mappelés összeütközne a Command Center már éles, tesztelt logikájával (`app/api/dashboard/summary/route.ts` `readyIdeas` szűrése `workflow_status === 'ready_to_produce'` alapján, illetve a `validated` állapotot "készíts csomagot" javaslat kiváltására használja). Az új, gazdagabb mapping kizárólag a PATCH (explicit állapotváltás) útvonalon fut, ami korábban semmit nem csinált — ez tisztán additív, nem módosít meglévő, éles viselkedést.

---

## A TELJES EREDETI MESTERTERV (változatlan, szó szerint, referenciaként)

VÉGLEGES FEJLESZTÉSI UTASÍTÁS CODEXNEK — WILLVIRAL CREATOR OPERATING SYSTEM

A WillViral célja nem egy egyszerű AI script generátor. A WillViral egy teljes Creator Operating System / Creator Intelligence Platform, amely hosszú távon globális SaaS termékké válik.

A fejlesztés célja:
olyan erős alapplatformot kell építeni, amely versenyképes a nagy creator growth platformokkal, miközben a WillViral saját előnye megmarad:

Idea → validáció → bizonyítékok → Viral Score → gyártási csomag → naptár → publikálás → audit → memória → tanulás

A rendszer fő ígérete:
A creator ne találgassa, mit gyártson, hanem bizonyítékok, trendjelek, hasonló videók, versenytársadatok és pontozás alapján kapjon konkrét döntési segítséget, majd ebből azonnal készíthető videócsomagot.

FONTOS STRATÉGIAI IRÁNY

A WillViralnak nem kis AI toolként kell működnie, hanem teljes creator munkaközpontként.

A cél:

* feature parity irány a nagy creator platformokkal;
* saját WillViral intelligence réteg;
* prémium UX;
* globális piacra előkészített architektúra;
* költségvédett AI/API működés;
* skálázható SaaS alap.

Ne úgy építsd, hogy csak magyar piacra jó legyen.
Úgy építsd, hogy az első piac lehet Magyarország / CEE, de a rendszer később angol, amerikai, európai és globális piacra is vihető legyen.

NE legyen hardcode-olva:

* magyar nyelv;
* HUF ár;
* magyar piac;
* egyetlen AI provider;
* egyetlen platform;
* egyetlen promptlogika.

Legyen minden bővíthető:

* language;
* market;
* country;
* currency;
* timezone;
* platform;
* niche;
* content_format;
* ai_provider;
* prompt_template_id.

KÖZPONTI ADATMODELL

A rendszer központi objektuma legyen a Video Idea.

Ne tool-központú rendszert építs, hanem Video Idea-központú rendszert.

Minden funkció egy Video Idea létrehozását, validálását, gazdagítását, csomagolását, ütemezését, auditját vagy tanulását szolgálja.

A Video Idea tartalmazza legalább:

* id
* user_id
* title
* topic
* short_description
* niche
* platform
* language
* market
* country
* currency
* timezone
* content_format
* keywords
* trend_signals
* similar_videos
* competitor_proof
* source_links
* viral_score
* opportunity_score
* competition_score
* risk_factors
* proof_summary
* title_ideas
* hook_ideas
* thumbnail_concepts
* video_package_id
* audit_result_id
* calendar_status
* publish_status
* workflow_status
* paid_result_reference
* input_hash
* created_at
* updated_at

Workflow státuszok:

* new_idea
* validating
* validated
* ready_to_produce
* scheduled
* published
* audited
* rejected
* archived

FŐ NAVIGÁCIÓ

A jelenlegi tool-lista jellegű működést át kell alakítani creator OS navigációra.

Fő menüpontok:

1. Command Center
2. Ideas
3. Trends
4. Keywords
5. Competitors
6. Packages
7. SEO
8. Thumbnail
9. Audit
10. Calendar
11. Analytics
12. Memory
13. Coach
14. Billing / Credits
15. Settings

A user ne technikai toolokat lásson, hanem creator munkaterületeket.

COMMAND CENTER

A dashboard legyen prémium napi creator irányítóközpont.

Cél:
a user 10 másodperc alatt értse:

* mit érdemes ma gyártania;
* miért érdemes;
* milyen bizonyíték támasztja alá;
* mi a következő lépés.

A Command Center tartalmazza:

1. Today's Best Opportunities

* 3–5 ajánlott videóötlet;
* Viral Score;
* Opportunity Score;
* trendfrissesség;
* verseny erőssége;
* rövid indoklás;
* fő CTA: „Videócsomag készítése";
* másodlagos CTA: „Mentés", „Figyelés", „Elutasítás".

2. Proof Signals

* hasonló videók;
* competitor videók;
* nézettség;
* publikálási kor;
* relevancia indoklás;
* gyenge / elutasított jelek külön jelölése.

3. Competitor Moves

* figyelt versenytársak új videói;
* top performer videók;
* outlier videók;
* adaptációs lehetőség.

4. Keyword Opportunities

* erős kulcsszólehetőségek;
* alacsony verseny + jó kereslet;
* kapcsolódó témák.

5. Ready-to-Create Packages

* már elkészült, de még nem publikált videócsomagok.

6. Tracked Trends

* figyelt trendek állapota;
* új mozgás;
* erősödő / gyengülő trend.

7. Next Best Actions
   A rendszer mindig javasoljon következő lépést:

* pontozd ezt a témát;
* készíts videócsomagot;
* auditáld a régi videódat;
* nézd meg a versenytárs új outlier videóját;
* ütemezd be a kész csomagot.

UX alapelv:
minden képernyő válaszoljon erre a három kérdésre:

1. Mi ez?
2. Miért bízhatok benne?
3. Mit csináljak most?

KULCSSZÓKUTATÓ MODUL

Kell egy valódi Keyword Research modul.

Funkciók:

* keyword keresés;
* related keywords;
* long-tail keyword javaslatok;
* competition score;
* opportunity score;
* search volume becslés, ha adatforrásból elérhető;
* platform szűrés;
* language szűrés;
* market szűrés;
* keyword mentése Video Idea-hoz;
* Video Idea generálása keywordből;
* keyword → topic cluster;
* keyword → video angle javaslat.

Fontos:
a kulcsszókutató ne csak SEO-lista legyen, hanem creator döntési eszköz.

VERSENYTÁRSFIGYELŐ MODUL

Kell Competitor Intelligence modul.

Funkciók:

* competitor channel hozzáadása;
* competitor lista;
* competitor recent videos;
* competitor top videos;
* views;
* publish date;
* engagement jelek, ha elérhetők;
* views per hour vagy hasonló becsült momentum jel;
* outlier detection;
* competitor topic map;
* competitor title pattern elemzés;
* competitor thumbnail pattern elemzés;
* adaptációs javaslat saját niche-re;
* competitor video mentése proof signal-ként egy Video Idea alá.

Outlier logika:
ne csak magas nézettséget mutasson, hanem azt is, ha egy videó a csatorna saját átlagához képest kiugróan teljesít.

Példa:
„Ez a videó 4,2x jobban teljesít a csatorna átlagánál."

SIMILAR VIDEOS

A meglévő Similar Videos funkciót erősíteni kell.

Cél:
ne kamu inspirációt adjon, hanem piaci bizonyítékot.

Szabályok:

* külön kezelje a kézi keresést, URL-es keresést és profilalapú keresést;
* ne keverje automatikusan a user niche-ét, ha a user konkrét témára vagy URL-re keres;
* mutassa, miért releváns egy találat;
* jelölje a gyenge találatokat;
* jelölje az elutasított találatokat;
* menthető legyen proof signal-ként;
* használható legyen Viral Score és Video Package bemenetként.

VIRAL SCORE

A Viral Score legyen magyarázható döntési pontszám.

Ne csak egy szám legyen.

Tartalmazza:

* összpontszám 0–100 között;
* trend strength;
* freshness;
* competition level;
* proof strength;
* niche fit;
* platform fit;
* production difficulty;
* risk level;
* hook potential;
* audience curiosity;
* confidence level;
* rövid döntési javaslat.

Kimeneti logika:

* 80–100: erős lehetőség, érdemes gyorsan csomagot készíteni;
* 60–79: használható, de javítás / jobb angle kell;
* 40–59: gyenge vagy bizonytalan;
* 0–39: nem ajánlott, hacsak nincs erős saját ok.

VIDEO PACKAGE

A Video Package legyen prémium eredményoldal, ne sima AI-szöveg.

Tartalmazza:

* recommended title;
* 5 címvariáció;
* 3 hook verzió;
* narráció;
* jelenetlista;
* vizuális script;
* thumbnail concept;
* thumbnail text javaslat;
* SEO description;
* tags / hashtags;
* CTA;
* pinned comment javaslat;
* platform-specifikus verziók;
* gyártási checklist;
* kockázatok;
* miért működhet;
* mentés Calendarba;
* későbbi audit gomb.

Fontos:
a Video Package mindig kapcsolódjon egy Video Idea-hoz.

TITLE STUDIO

Kell Title Studio modul.

Funkciók:

* címgenerálás;
* title score;
* curiosity score;
* clarity score;
* clickability score;
* risk score;
* túl hosszú cím figyelmeztetés;
* túl általános cím figyelmeztetés;
* platform szerinti címvariációk;
* A/B címötletek;
* cím mentése Video Idea alá.

THUMBNAIL STUDIO

Kell Thumbnail Studio modul.

Első körben nem kell feltétlenül képgenerálás, de kell thumbnail intelligence.

Funkciók:

* thumbnail concept generálás;
* thumbnail text javaslat;
* kompozíció javaslat;
* kontraszt / figyelem / curiosity értékelés;
* túlzsúfoltság figyelmeztetés;
* arc / tárgy / szimbólum / konfliktus javaslat;
* A/B thumbnail concept;
* később: kép feltöltéses thumbnail audit.

SEO MODUL

Kell SEO / Upload Optimizer.

Funkciók:

* cím SEO ellenőrzés;
* leírás javaslat;
* keyword coverage;
* tag javaslat;
* hashtag javaslat;
* description first lines ellenőrzés;
* chapters javaslat;
* playlist javaslat;
* pinned comment;
* end screen / CTA javaslat;
* SEO score;
* publikálás előtti checklist.

AUDIT MODUL

A Video Audit funkciót teljes Analytics & Audit Center irányba kell vinni.

Video Audit értékelje:

* topic strength;
* hook strength;
* title strength;
* thumbnail strength;
* retention risk;
* pacing;
* clarity;
* SEO;
* CTA;
* platform fit;
* viral potential;
* improvement plan.

Channel Audit későbbi, de elő kell készíteni:

* legerősebb témák;
* leggyengébb témák;
* outlier videók;
* publikálási ritmus;
* title/thumbnail problémák;
* következő 10 videó javaslat.

CREATOR MEMORY

A Creator Memory legyen a retention motor.

Ne egyszerű mentett lista legyen, hanem creator munkamemória.

Tárolja:

* mentett ötletek;
* elutasított témák;
* validált témák;
* kész csomagok;
* auditok;
* figyelt trendek;
* competitor proofok;
* korábbi döntések;
* user preferenciák;
* csatorna/niche tanulságok.

A rendszer később tudjon ilyeneket mondani:

* „Ez a tématípus korábban jól működött nálad."
* „Ezt a témát már egyszer elutasítottad."
* „Ez hasonlít egy korábbi gyenge videódhoz."
* „Ez a competitor angle most jobban működik, mint a korábbi."
* „Ebben a niche-ben nálad a mystery/science angle erősebb."

CALENDAR

Kell Content Calendar alap.

Funkciók:

* Video Idea naptárba helyezése;
* státuszok kezelése;
* platform;
* publikálási dátum;
* kampány;
* megjegyzés;
* ready_to_produce csomagok ütemezése;
* később published status és audit reminder.

ANALYTICS

Első körben lehet alap, később erősebb.

Alap funkciók:

* user aktivitás;
* generált ötletek;
* validált ötletek;
* kész csomagok;
* auditok;
* kreditfelhasználás;
* leggyakrabban használt niche;
* legtöbbet mentett témák.

Később:

* YouTube OAuth;
* valós csatorna analytics;
* videó performance;
* outlier detection saját csatornán;
* régi videók újraoptimalizálása.

AI COACH

Későbbi modul, de a struktúrát elő kell készíteni.

AI Coach cél:

* ne általános chatbot legyen;
* a user saját Video Idea, Memory, Audit, Competitor és Trend adatai alapján válaszoljon;
* kontextusvezérelt creator tanácsadó legyen.

Példa kérdések:

* „Mit gyártsak ma?"
* „Miért nem működött ez a videóm?"
* „Melyik témát válasszam a három közül?"
* „Hogyan javítsam ezt a címet?"
* „Milyen videósorozatot építsek ebből?"

AUTO TRANSCRIPT

A meglévő Auto Transcript irányt tartsd meg.

Funkciók:

* audio/video input;
* TXT export;
* SRT export;
* VTT export;
* időkódos leirat;
* mentett eredmény;
* input hash védelem;
* kreditvédelem;
* provider layer OpenAI / később más STT szolgáltató.

SCRIPT EXTRACTOR

A Script Extractor maradjon inspirációs és reverse engineering eszköz.

YouTube URL alapján:

* transcript, ha van;
* ha nincs transcript, metadata alapú becsült struktúra;
* hook elemzés;
* cím elemzés;
* lehetséges script szerkezet;
* adaptálható angle;
* kapcsolódás Video Package-hez.

AI PROVIDER LAYER

Kötelező AI provider abstraction layer.

Ne legyen a rendszer közvetlenül egyetlen providerhez kötve.

Provider logika:

* Claude: mély elemzés, stratégiai döntés, Video Package, audit;
* OpenAI: transcription, structured output, gyorsabb generálás;
* később: olcsóbb speech-to-text provider;
* később: saját/nyílt modellek.

Minden AI-hívásnál legyen tárolva:

* provider;
* model;
* prompt_template_id;
* prompt_version;
* input_hash;
* estimated_cost;
* credit_cost;
* result_id;
* created_at.

PROMPT TEMPLATE RENDSZER

Minden prompt legyen verziózott és lokalizálható.

Prompt template mezők:

* prompt_template_id
* language
* market
* platform
* task_type
* version
* provider
* system_prompt
* user_prompt_template
* output_schema
* created_at
* updated_at

Ne legyenek promptok szétszórva a kódban.

KREDITRENDSZER ÉS KÖLTSÉGVÉDELEM

Minden drága AI/API művelet kredithez kötött legyen.

Kreditköteles lehet:

* Opportunity Engine;
* Viral Score;
* Video Package;
* Video Audit;
* Script Extractor;
* Auto Transcript;
* Thumbnail Audit;
* Channel Audit;
* Competitor deep analysis;
* AI Coach mély válasz.

Szabályok:

1. Minden fizetős művelet előtt confirmation modal kell.

2. A modal mutassa:

   * művelet neve;
   * kreditköltség;
   * aktuális kredit;
   * várható új egyenleg;
   * eredmény mentésre kerül;
   * mentett eredmény újranyitása nem kerül új kreditbe.

3. Ha ugyanazt az inputot újra futtatná:

   * input_hash alapján ellenőrizni kell;
   * ha van mentett paid_result, ajánlja fel annak megnyitását;
   * ne vonjon le új kreditet.

4. Minden paid result legyen újranyitható kredit nélkül.

5. API protection:

   * rate limit;
   * daily soft limit;
   * caching;
   * input hash;
   * duplicate request prevention;
   * error handling;
   * user-friendly magyar hibaüzenetek.

PAID RESULTS

Paid Results rendszer kötelező.

Menteni kell:

* user_id
* action_type
* input_hash
* input_payload
* result_payload
* credit_cost
* provider
* model
* created_at
* expires_at, ha szükséges
* linked_video_idea_id

Újranyitás:

* nem von le kreditet;
* egyértelműen mutassa, hogy mentett eredmény.

UX IRÁNY

A frontendnek prémium creator command center érzetet kell adnia.

Ne tűnjön egyszerű admin panelnek.
Ne tűnjön egyszerű AI form kitöltőnek.
Ne legyen túl technikai.

A user-facing neveket cserélni kell creator-barát nevekre.

Példák:

* Opportunity Engine → Videólehetőségek
* Similar Videos → Piaci bizonyítékok
* Viral Score → Virális esély
* Video Package → Gyártási csomag
* Video Audit → Videódiagnózis
* Creator Memory → Tartalommemória
* Tracked Trends → Figyelt trendek
* Paid Results → Mentett elemzések
* Keyword Research → Kulcsszókutató
* Competitor Tracker → Versenytársfigyelő
* Command Center → Creator központ

Minden eredményoldalon legyen:

1. Összefoglaló döntés
2. Pontszám
3. Bizonyítékok
4. Kockázatok
5. Következő lépés
6. Mentés / csomagkészítés / naptárba rakás CTA

GLOBÁLIS FELKÉSZÍTÉS

Minden user-facing szöveg legyen lokalizálható.

Legyen előkészítve:

* magyar UI;
* angol UI;
* market selector;
* language selector;
* currency selector;
* platform selector.

Későbbi célpiacok:

* Hungary
* CEE
* United States
* United Kingdom
* Germany
* Global English
* Latin America

Ne legyen olyan adatstruktúra vagy prompt, amelyet később teljesen újra kell írni globális indulás miatt.

ADATBÁZIS / MIGRATION ELV

Mielőtt nagy változást végzel:

1. Vizsgáld meg a jelenlegi adatbázis-sémát.
2. Ne törölj meglévő adatot.
3. Készíts migrációt.
4. Őrizd meg a meglévő funkciók működését.
5. Új mezőket backward compatible módon adj hozzá.
6. Ha meglévő funkciót módosítasz, ne törd el a jelenlegi flow-t.

TESZTELÉS

Kell alap tesztelés:

* kredit levonás;
* paid result mentés;
* paid result újranyitás kredit nélkül;
* input hash duplikációvédelem;
* Video Idea létrehozás;
* Video Idea státuszváltás;
* Video Package mentése;
* Similar Videos mentése proof signalként;
* Competitor video mentése proof signalként;
* language/market/platform mezők működése;
* AI provider kiválasztás;
* API error kezelés.

HIBAKEZELÉS

Minden hiba legyen user-barát.

Példák:

* „A napi ingyenes keresési kereted elfogyott. Próbáld újra holnap, vagy használj kreditet."
* „Ezt az elemzést már korábban elkészítetted. Megnyithatod új kredit levonása nélkül."
* „Nem találtunk elég erős piaci bizonyítékot ehhez a témához."
* „A videó transcriptje nem érhető el, ezért metaadatok alapján becsült elemzést készítettünk."
* „Ez a művelet nem futtatható, mert nincs elég kredited."

FEJLESZTÉSI PRIORITÁS

Most nem új, szétszórt funkciókat kell halmozni, hanem platformalapot kell építeni.

Prioritási sorrend:

PHASE 1 — Creator OS alap

1. Video Idea központi adatmodell
2. Command Center redesign
3. Creator-barát navigáció
4. Paid Results stabilizálás
5. Kredit confirmation modal
6. Input hash duplikációvédelem
7. Similar Videos proof signal mentés
8. Viral Score magyarázható eredményoldal
9. Video Package prémium eredményoldal
10. Creator Memory státuszokkal
11. language / market / platform mezők bevezetése
12. AI provider layer alap

PHASE 2 — Versenyképes creator platform funkciók

1. Keyword Research
2. Competitor Tracker
3. Outlier Detector
4. Title Studio
5. Thumbnail Studio
6. SEO / Upload Optimizer
7. Content Calendar
8. Video Audit bővítés
9. Trend Alerts
10. Content Gap Finder

PHASE 3 — Globális SaaS / Agency irány

1. English UI
2. Stripe / globális pricing
3. YouTube OAuth
4. Analytics dashboard
5. Channel Audit
6. AI Coach
7. Team / Agency workspace
8. PDF report export
9. Browser extension
10. Multi-platform intelligence

VÉGSŐ TERMÉKLOGIKA

A WillViral ne csak azt tudja, hogy:
„ír egy scriptet".

Hanem ezt:

1. Megtalálja a lehetőséget.
2. Validálja piaci bizonyítékokkal.
3. Pontozza virális esély alapján.
4. Megmutatja a kockázatot.
5. Elkészíti a gyártási csomagot.
6. Naptárba rakja.
7. Publikálás után auditálja.
8. Megtanulja, mi működik a creatornek.
9. Következő alkalommal jobb ajánlást ad.

Ez a WillViral valódi célja.

VÉGSŐ POZICIONÁLÁS

Angol belső pozíció:

WillViral is a global Creator Operating System that helps creators discover, validate, package, optimize and learn from video ideas using proof-based creator intelligence.

Magyar belső pozíció:

A WillViral egy globális creator operációs rendszer, amely segít megtalálni, bizonyítékokkal validálni, becsomagolni, optimalizálni és visszamérni a videóötleteket.

A fejlesztés során minden döntést ehhez kell igazítani.
