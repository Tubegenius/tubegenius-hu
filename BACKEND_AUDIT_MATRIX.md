# WillViral backend auditmátrix

Utolsó frissítés: 2026-07-16. A frontend vizuális/UX audit nincs ebben a mátrixban.

Jelölések: **lezárt** = kód + regressziós teszt + build; **részleges** = kritikus út ellenőrizve, teljes hibamátrix még hátra van; **függőben** = következő auditblokk.

| Funkció | Fő backend | Módszertan/adat | Cache/kredit | CRUD/biztonság | Teszt | Állapot |
|---|---|---|---|---|---|---|
| Opportunity Engine | `/api/opportunity` | dinamikus niche expansion; véges, bounded score-ok; fail-closed bizonyíték- és döntési kapuk | paid result + lock + soft limit; cache/Memory DB-hiba fail-closed | tenant-szűrt és HTTP(S)/YouTube-ID/metrika/dátum validált bizonyíték; korlátozott JSON input | score/decision/evidence edge case + teljes regresszió + production build | lezárt |
| Similar Videos | `/api/similar-videos` | relevancia, velocity, outlier; teljes véges/tartományos decision input és fail-closed evidence gate | kvóta + paid result + lock; profil DB-hiba fail-closed | proof signal tenant policy; safe-integer YouTube metrikák; korlátozott JSON input | decision/metrika edge case + teljes regresszió + production build | lezárt |
| Viral Score | `/api/viral-score` | backend score, web buzz; kizárólag valid stats-alapú low-data/confidence/market gate | paid result + legacy cache + lock; profil/cache DB-hiba fail-closed | validált YouTube ID/dátum/safe-integer metrikákból Video Idea proof | metrika/low-data/cache edge case + teljes regresszió + production build | lezárt |
| Video Audit | `/api/video-audit` | proxyhatárok javítva; fals retention/időpont/thumbnail jel megszüntetve | paid result + lock + soft limit | userhez kötött mentés | input/módszertan edge case | lezárt |
| Video Package | `/api/video-package`, `/api/video-packages` | high-risk független forrásminimum; transcript nem kerülőút; Opportunity context nem tényforrás | paid result + lock + refund; korlátozott input | sorrendhelyes legacy package → Video Idea link → ready_to_produce kapcsolat | fact-safety/workflow edge case + teljes regresszió + production build | lezárt |
| Keyword Research | `/api/keyword-research` | relevanciaszűrt YouTube evidenciaminta + Google jel; explicit nem havi volume; fail-closed score | paid result + lock | user cache | score/output/input edge case | lezárt |
| Content Gap | `/api/content-gap` | relevanciaszűrt YouTube-minta + konkrét Google-jelhez kötött rés-jelölt; nem volume/teljes lefedettség | paid result + lock | tool-type ellenőrzött user cache; mentés csak API-siker után | input/evidence/output/cache edge case | lezárt |
| Title Studio | `/api/title-studio` | determinisztikus címjelek + explicit nem-CTR prediktív AI csomagolási értékelés | paid result + lock + boolean refresh | tool-type/provenance ellenőrzött címmentés | input/output/diverzitás/provenance edge case | lezárt |
| Thumbnail Studio | `/api/thumbnail-studio` | 3 gyártható, eltérő koncepció + determinisztikus szöveg-olvashatóság; AI score nem CTR/A-B adat | paid result + lock + boolean refresh | kanonikus tool-type/provenance mentés + deduplikáció | input/output/diverzitás/provenance edge case | lezárt |
| SEO Optimizer | `/api/seo-optimizer` | determinisztikus metaadat-készültségi score + validált AI csomag; nincs rangsorpredikció | paid result + lock | tenant mentés | score/input/output edge case | lezárt |
| Script Extractor | `/api/script-extract` | időzített transcript-részlet vagy explicit metadata-becslés; analysis basis/confidence | kanonikus video ID hash + paid result + lock | tool-type ellenőrzött user cache | URL/output/forrás edge case | lezárt |
| Auto Transcript | `/api/transcript` | OpenAI transcript + validált, rendezett időbélyeg; nincs kitalált cue | tartalom-digest hash + paid result + lock | fájl/nyelv/cím + tool-type validáció | formatter/input/cache edge case | lezárt |
| Channel Audit | `/api/channel-audit` | validált audit-score + elkülönített OAuth-analitika + niche-releváns ajánlás | paid result + lock | aktív csatorna tenanttal | score/input/output/error edge case | lezárt |
| Competitor Tracker | `/api/competitors` | aktuális, két snapshotos VPH; signed 7/14/28 ablakváltozás; robusztus videóminta-medián outlier explicit age-limitációval | kredit + lock + mentési sorrend/kompenzáció | tenant CRUD + saját snapshot/proof provenance + deduplikáció | CRUD/VPH/growth/outlier edge case | lezárt |
| Trend tracking/alerts | `/api/dashboard/tracked-trends`, `/api/trend-alerts` | ismert bizonyítékvideó-pool snapshotjai; evidenciaset-váltásnál új baseline; VPH-gyorsulás/lassulás, nem teljes piaci trendvolume | deep refresh kredit + lock + refund/rollback | tenant CRUD + validált alert input + fail-closed persistence | velocity/evidenciaset/frequency edge case | lezárt |
| Niche discovery | `/api/youtube/discover-niche` | utolsó 15 videó címe + nyers aktuális views; validált, deduplikált, confidence-rendezett jelöltlista; nem teljesítménypredikció | aktív csatornához kötött cache + ingyenes/fizetős lock + refresh refund | profil tenanttal, szigorú boolean input, ellenőrzött mentés | output/dedupe/sorrend/határérték | lezárt |
| Creator Memory | `/api/memory` | döntési minta; published nem performance; provenance-os proof/event | nem fizetős | tenant CRUD/enrichment + validált state/score/text/platform + ellenőrzött workflow sync | workflow/input/tenant/error alap | lezárt |
| Video Ideas/Calendar | `/api/video-ideas` | központi állapotgép | nem fizetős | tenant CRUD + score/metadata/dátum/hash védelem | identity/workflow/input alap | lezárt |
| Stripe/credits | `/api/stripe/*`, `/api/credits` | ledger, esemény- és invoice-idempotencia, rollover; csak paid top-up | atomi jóváírás + CAS levonás/refund + auditlog-kompenzáció + fail-closed soft limit | webhook signature/auth + állapotfeltételes retry claim + ellenőrzött DB-műveletek | credit/refund/soft-limit/Stripe event policy | részleges: Stripe sandbox E2E hátra van |
| YouTube OAuth/Analytics | `/api/youtube/*` | 28 napos valós Analytics; top 10 + top-50 minta alsó 10 explicit határral | 24 órás publikus profilcache; OAuth token refresh | nonce CSRF + kanonikus HTTPS origin + tenant token + fail-closed DB + production 035 RLS | origin policy + teljes regresszió + production disconnect/reconnect és Analytics-visszatérés | lezárt |
| AI provider layer | `lib/services/ai-provider-service.ts` | kötelezően regisztrált prompt ID/verzió + közös JSON parser; modell-, méret-, token- és completion-validáció | teljes direkt + közvetett usage/költség telemetry az Opportunity és Similar Videos fizetős flow-ban | szerveroldali kulcsok; 60s timeout + kontrollált retry; csonkolt/üres válasz fail-closed | 85 regressziós teszt + production build | lezárt |

## Kötelező lezárási kritérium funkciónként

1. Üzleti döntés és ígéret pontosan meghatározva.
2. Csak rendelkezésre álló adatból levonható következtetés.
3. Képlet, küszöb és confidence szélsőértékekkel tesztelve.
4. Cache-frissesség, hash-identitás és fizetett újranyitás helyes.
5. Kredit csak sikeres, menthető eredményért; párhuzamos futás védett.
6. Külső API-hiba fail-closed vagy dokumentált degradáció.
7. Mentés, módosítás, törlés és workflow nem veszít adatot.
8. Minden lekérdezés user/tenant határral rendelkezik.
9. Prompt azonosítható és verziózott; kimenet validált.
10. Determinisztikus regressziós teszt + production build sikeres.
11. Piaci benchmark: a `VIDIQ_FUNCTIONAL_BENCHMARK.md` szerint a megfelelő vidIQ-döntési logika, adatforrás, személyre szabás és funkcióhiány tételesen dokumentált; minden eltérés tudatos és védhető.
