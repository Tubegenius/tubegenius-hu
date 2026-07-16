# WillViral backend auditmátrix

Utolsó frissítés: 2026-07-16. A frontend vizuális/UX audit nincs ebben a mátrixban.

Jelölések: **lezárt** = kód + regressziós teszt + build; **részleges** = kritikus út ellenőrizve, teljes hibamátrix még hátra van; **függőben** = következő auditblokk.

| Funkció | Fő backend | Módszertan/adat | Cache/kredit | CRUD/biztonság | Teszt | Állapot |
|---|---|---|---|---|---|---|
| Opportunity Engine | `/api/opportunity` | dinamikus niche expansion, döntési kapuk | paid result + lock + soft limit | tenant-szűrt bizonyíték | score/decision edge case | részleges |
| Similar Videos | `/api/similar-videos` | relevancia, velocity, outlier, evidence gate | kvóta + paid result + lock | proof signal tenant policy | decision edge case | részleges |
| Viral Score | `/api/viral-score` | backend score, web buzz, low-data gate | paid result + legacy cache + lock | Video Idea/proof kapcsolat | dátum/score alap | részleges |
| Video Audit | `/api/video-audit` | proxyhatárok javítva; fals retention/időpont/thumbnail jel megszüntetve | paid result + lock + soft limit | userhez kötött mentés | input/módszertan edge case | lezárt |
| Video Package | `/api/video-package` | fact block + opportunity evidence | paid result + lock | Video Idea kapcsolat | cache-flow alap | részleges |
| Keyword Research | `/api/keyword-research` | relevanciaszűrt YouTube evidenciaminta + Google jel; explicit nem havi volume; fail-closed score | paid result + lock | user cache | score/output/input edge case | lezárt |
| Content Gap | `/api/content-gap` | relevanciaszűrt YouTube-minta + konkrét Google-jelhez kötött rés-jelölt; nem volume/teljes lefedettség | paid result + lock | tool-type ellenőrzött user cache; mentés csak API-siker után | input/evidence/output/cache edge case | lezárt |
| Title Studio | `/api/title-studio` | determinisztikus címjelek + explicit nem-CTR prediktív AI csomagolási értékelés | paid result + lock + boolean refresh | tool-type/provenance ellenőrzött címmentés | input/output/diverzitás/provenance edge case | lezárt |
| Thumbnail Studio | `/api/thumbnail-studio` | koncepcióértékelés | paid result + lock | csak saját fizetett eredményből származó koncepció menthető | kimenet/provenance alap | részleges |
| SEO Optimizer | `/api/seo-optimizer` | determinisztikus metaadat-készültségi score + validált AI csomag; nincs rangsorpredikció | paid result + lock | tenant mentés | score/input/output edge case | lezárt |
| Script Extractor | `/api/script-extract` | időzített transcript-részlet vagy explicit metadata-becslés; analysis basis/confidence | kanonikus video ID hash + paid result + lock | tool-type ellenőrzött user cache | URL/output/forrás edge case | lezárt |
| Auto Transcript | `/api/transcript` | OpenAI transcript + validált, rendezett időbélyeg; nincs kitalált cue | tartalom-digest hash + paid result + lock | fájl/nyelv/cím + tool-type validáció | formatter/input/cache edge case | lezárt |
| Channel Audit | `/api/channel-audit` | validált audit-score + elkülönített OAuth-analitika + niche-releváns ajánlás | paid result + lock | aktív csatorna tenanttal | score/input/output/error edge case | lezárt |
| Competitor Tracker | `/api/competitors` | csatornafeloldás + snapshotból mért VPH és 7/14/28 napos növekedés | kredit + lock | tenant CRUD + saját snapshotok | CRUD/VPH/growth alap | részleges |
| Trend tracking/alerts | `/api/dashboard/tracked-trends`, `/api/trend-alerts` | frissesség és trendjel | deep refresh kredit | tenant CRUD + cron | függőben | függőben |
| Niche discovery | `/api/youtube/discover-niche` | csatornaalapú jelöltlista | cache + refresh kredit | aktív csatorna tenanttal | függőben | függőben |
| Creator Memory | `/api/memory` | döntési minta; published nem performance; provenance-os proof/event | nem fizetős | tenant CRUD/enrichment + validált state/score/text/platform + ellenőrzött workflow sync | workflow/input/tenant/error alap | lezárt |
| Video Ideas/Calendar | `/api/video-ideas` | központi állapotgép | nem fizetős | tenant CRUD + score/metadata/dátum/hash védelem | identity/workflow/input alap | lezárt |
| Stripe/credits | `/api/stripe/*`, `/api/credits` | ledger, idempotencia, rollover | atomi jóváírás/levonás + soft limit + paid-save kompenzáció | webhook signature/auth | credit/refund policy alap | részleges |
| YouTube OAuth/Analytics | `/api/youtube/*` | snapshot/analytics | cache | nonce CSRF + tenant token | függőben | részleges |
| AI provider layer | `lib/services/ai-provider-service.ts` | kötelezően regisztrált prompt ID/verzió + közös JSON parser | usage/költség telemetry | szerveroldali kulcsok; 60s timeout + kontrollált retry | registry/timeout alap | részleges |

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
