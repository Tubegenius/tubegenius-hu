# WillViral ↔ vidIQ funkcionális benchmark

Utolsó frissítés: 2026-07-15. Ez nem UI-összehasonlítás és nem a vidIQ zárt algoritmusának visszafejtése. Hivatalos vidIQ-oldalak alapján azt vizsgálja, hogy a WillViral ugyanazt a creator-döntést legalább azonosan védhető adatlogikával támogatja-e.

Jelölések: **igazolt** = kód + adatforrás + teszt áttekintve; **részleges** = funkcionális pár megvan, de adat- vagy képességhiány van; **eltérő előny** = tudatosan más, bizonyíthatóbb Creator OS logika; **hiány** = piaci benchmark alapján tervezendő.

| vidIQ képesség | WillViral pár | Első megállapítás | Állapot |
|---|---|---|---|
| Daily Ideas: csatornatörténet + kulcsszavak + hasonló sikeres videók + trend | Opportunity Engine + Creator Memory + Similar Videos | A bizonyítéklánc erősebb irány, de a napi, csatornatörténetből személyre szabott folyam teljes benchmarkja folyamatban | részleges |
| View Prediction | Opportunity/Viral Score | Konkrét várható view számot megfelelő csatorna-baseline nélkül nem szabad állítani | eltérő előny / hiányzó predikció |
| Keyword Research: becsült YouTube volume, competition, overall score, trend | Keyword Research | YouTube találati minta + Google/Serper jel nem azonos a vidIQ becsült havi YouTube search volume adatával | részleges |
| Keywords For You / Top Search Terms | Niche Expansion + YouTube Analytics | Dinamikus niche seed van; csatornára szabott top search-term és rank-history még nincs igazolva | részleges |
| Competitors: growth idősor, napi views, VPH, top videók | Competitor Tracker + outlier | Valódi snapshot-idősor, napi automatikus mintavétel, mért videó-VPH, 7/14/28 napos csatornanövekedés és top/outlier videók megvannak. VPH csak legalább két mérésből jelenik meg. | igazolt alapfunkció |
| Trend Alerts: keyword/category/competitor monitor, gyakoriság | Tracked Trends + Trend Alerts | Snapshot és emelkedésriasztás megvan; állítható gyakoriság és competitor-VPH trigger nincs | részleges |
| Optimize: tag, leírás, kategória, preview, progress | SEO Optimizer | Tag/leírás/checklist megvan; preview, kategória-ajánlás és időbeli progress nincs | részleges |
| Channel Audit | Channel Audit + Video Audit | Saját audit és következő videó ajánlás megvan; a scorecard dimenziók tételes összevetése folyamatban | részleges |
| AI Coach | Creator OS modulok + Memory | Nem általános chatcoach, hanem bizonyítékhoz és workflow-hoz kötött döntési rendszer | eltérő előny |
| Thumbnail Maker / testing | Thumbnail Studio | Koncepció-intelligence van, képalkotás és valódi A/B thumbnail testing nincs | hiány/részleges |
| Most Viewed / Outliers | Similar Videos + Competitor outlier | Valós evidence, szerveroldali provenance, snapshotból számolt VPH és napi háttérmérés megvan. | igazolt alapfunkció |

## Kötelező értékelési kérdések

1. Ugyanazt a creator-döntést támogatja-e?
2. Mi a tényleges adatforrás, frissesség és mintanagyság?
3. Mért adat, becslés, heurisztika vagy AI-vélemény — és helyesen van-e címkézve?
4. A score stabil-e szélsőértékeken, és nem sugall-e nem létező pontosságot?
5. Személyre szabja-e a csatornatörténet, méret, niche, régió és platform?
6. Továbbvihető-e a Creator OS következő lépésébe adatvesztés nélkül?
7. Miben jobb vagy tudatosan más a WillViral, és ez bizonyítható-e?

## Hivatalos forrásbázis

- vidIQ Daily Ideas, Competitors, Keyword Research, Trend Alerts, Optimize és Features oldalak
- vidIQ Keyword Research, Extension Overview és AI Coach Help Center-oldalak
