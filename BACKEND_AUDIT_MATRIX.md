# WillViral backend auditmátrix

Utolsó frissítés: 2026-07-15. A frontend vizuális/UX audit nincs ebben a mátrixban.

Jelölések: **lezárt** = kód + regressziós teszt + build; **részleges** = kritikus út ellenőrizve, teljes hibamátrix még hátra van; **függőben** = következő auditblokk.

| Funkció | Fő backend | Módszertan/adat | Cache/kredit | CRUD/biztonság | Teszt | Állapot |
|---|---|---|---|---|---|---|
| Opportunity Engine | `/api/opportunity` | dinamikus niche expansion, döntési kapuk | paid result + lock + soft limit | tenant-szűrt bizonyíték | score/decision edge case | részleges |
| Similar Videos | `/api/similar-videos` | relevancia, velocity, outlier, evidence gate | kvóta + paid result + lock | proof signal tenant policy | decision edge case | részleges |
| Viral Score | `/api/viral-score` | backend score, web buzz, low-data gate | paid result + legacy cache + lock | Video Idea/proof kapcsolat | dátum/score alap | részleges |
| Video Audit | `/api/video-audit` | proxyhatárok javítva; fals retention/időpont/thumbnail jel megszüntetve | paid result + lock + soft limit | userhez kötött mentés | input/módszertan edge case | lezárt |
| Video Package | `/api/video-package` | fact block + opportunity evidence | paid result + lock | Video Idea kapcsolat | cache-flow alap | részleges |
| Keyword Research | `/api/keyword-research` | valós YouTube/Google jel + újrakalibrált score | paid result + lock | user cache | score edge case | részleges |
| Content Gap | `/api/content-gap` | két valós forráshalmaz összevetése | paid result + lock | user cache | prompt/cache alap | részleges |
| Title Studio | `/api/title-studio` | backend heurisztika + AI értékelés | paid result + lock | címmentés tenanttal | prompt/cache alap | részleges |
| Thumbnail Studio | `/api/thumbnail-studio` | koncepcióértékelés | paid result + lock | tenant mentés | függőben | függőben |
| SEO Optimizer | `/api/seo-optimizer` | determinisztikus SEO-score + AI | paid result + lock | tenant mentés | függőben | függőben |
| Script Extractor | `/api/script-extract` | transcript-forrás + strukturálás | paid result + lock | user cache | függőben | függőben |
| Auto Transcript | `/api/transcript` | OpenAI transcript + időbélyeg | paid result + lock | user cache | formatter/cache alap | részleges |
| Channel Audit | `/api/channel-audit` | csatorna snapshot + ajánlás | paid result + lock | aktív csatorna tenanttal | függőben | függőben |
| Competitor Tracker | `/api/competitors` | csatornafeloldás + jelmentés | kredit + lock | tenant CRUD | CRUD alap | részleges |
| Trend tracking/alerts | `/api/dashboard/tracked-trends`, `/api/trend-alerts` | frissesség és trendjel | deep refresh kredit | tenant CRUD + cron | függőben | függőben |
| Niche discovery | `/api/youtube/discover-niche` | csatornaalapú jelöltlista | cache + refresh kredit | aktív csatorna tenanttal | függőben | függőben |
| Creator Memory | `/api/memory` | döntés utáni tanulási minta | nem fizetős | tenant CRUD + validált state/score/text + workflow sync | workflow/input alap | lezárt |
| Video Ideas/Calendar | `/api/video-ideas` | központi állapotgép | nem fizetős | tenant CRUD + score/metadata/dátum/hash védelem | identity/workflow/input alap | lezárt |
| Stripe/credits | `/api/stripe/*`, `/api/credits` | ledger, idempotencia, rollover | atomi jóváírás/levonás + soft limit + paid-save kompenzáció | webhook signature/auth | credit/refund policy alap | részleges |
| YouTube OAuth/Analytics | `/api/youtube/*` | snapshot/analytics | cache | nonce CSRF + tenant token | függőben | részleges |
| AI provider layer | `lib/services/ai-provider-service.ts` | provider fallback + JSON | usage telemetry | szerveroldali kulcsok | függőben | függőben |

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
