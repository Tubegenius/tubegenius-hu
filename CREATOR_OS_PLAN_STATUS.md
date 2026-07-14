# WILLVIRAL CREATOR OS — MESTERTERV ÁLLAPOT

**Cél**: ez a fájl a "VÉGLEGES FEJLESZTÉSI UTASÍTÁS CODEXNEK — WILLVIRAL CREATOR OPERATING SYSTEM" nevű mesterterv (lásd lent, teljes szöveg) végrehajtási állapotát követi, session-eken át. Új session elején OLVASD EL EZT ELŐSZÖR, utána a `CLAUDE_HANDOVER.md`-t (az általánosabb, git/deploy/migráció-fókuszú átadás).

## 2026-07-14 — MARKET READINESS HARDENING, 1. JAVÍTÁSI CSOMAG

Teljes backend/terméklogikai audit után az első P0/P1 javításcsomag elkészült:

- Stripe webhook middleware-kivétel: a Stripe szerver–szerver POST már eljut a signature-ellenőrző route-ig.
- Új idempotens `credit_ledger` + `apply_credit_event()` RPC (migráció 030): top-up és invoice jóváírás külső eseményazonosítóval deduplikált, atomi és auditálható.
- Az első subscription checkout már nem ír jóvá külön kreditet; kredit kizárólag invoice alapján jár, így nincs dupla első havi jóváírás.
- Webhook feldolgozási hiba 5xx-et ad és újrapróbálható; aktív előfizetés mellett új subscription checkout tiltott.
- Next.js 14.2.0 → 14.2.35: a korábbi critical middleware authorization bypass megszűnt. `npm audit`: critical 1→0.
- Similar Videos in-flight lock, request lock TTL 45 mp → 5 perc.
- Video Idea meglévő rekordnál patch/merge semantics: részleges tool-hívás nem nulláz korábbi score/niche/proof mezőket.
- Memory `completed` workflow mapping egységesítve `published` értékre.
- Migráció 031: proof/event tenant ownership policy és proof deduplikáció.
- Cache hash javítás: Title/SEO/Thumbnail/Content Gap/Channel Audit régió-, niche- és snapshot-tudatos; Thumbnail explicit `force_refresh` támogatás.
- Cron fail-closed hiányzó secret esetén; Facts/Quota saját auth; profil kliens által írható derived mezői szűkítve; Google OAuth disconnect token revoke.

Ellenőrzés: `npx tsc --noEmit` 0 hiba; `npm run build` sikeres (77/77 oldal). **A 030 és 031 migráció 2026-07-14-én lefutott az éles Supabase adatbázison.** Visszaellenőrizve: `credit_ledger`, `apply_credit_event(...)`, proof unique index és mindkét tenant insert policy létezik. A 031 éles futtatásakor talált PostgreSQL index-szintaxis hiba javítva (`NULLS NOT DISTINCT` az oszloplista után). Élő kreditfogyasztó teszt ebben a csomagban még nem történt.

**Utolsó frissítés**: 2026-07-13
**Utolsó commit**: ld. lent "Niche Expansion Engine + 3 keresési mód" szakasz — a user élőben talált egy komoly hardcode-problémát az Opportunity Engine-ben, ez a kör kijavította. Ezt megelőzően: [b1257fc] `feat: Channel Header Card + csatorna-első onboarding (channel_usage_mode)`, migráció [029](supabase/migrations/029_channel_profile_and_usage_mode.sql) élesben lefuttatva és élőben megerősítve. Korábban: Phase 1 lezárva, teljes Phase 2, Launch Readiness Audit+Hotfix Sprint, Beta Hardening Test, funkció-bejárás 11/28 tétele — mind commitolva (`8ddcdcf`, `9b68574`, `ec9bca5`, `6915997`).

**✅ Migráció 027 lefutott (2026-07-11 végén), Fix #1 (dupla kredit-védelem) élesben megerősítve működik.** A korábbi "fail-open" figyelmeztetés már nem releváns.

**KRITIKUS, 2026-07-11-i találat (Beta Hardening Test) — JAVÍTVA**: a `chargeFeature()` optimista zárolása (`lib/credits.ts`) megvédi a balance-mező konzisztenciáját, de NEM védi a usert attól, hogy két egyidejű kérés (pl. két böngészőfül) mindkettő sikeresen lefusson és MINDKETTŐ levonjon kreditet ugyanazért az érdemi eredményért — élőben megerősítve (2 konkurens Title Studio hívás, force_refresh, azonos topic → mindkettő 200, delta=2 kredit). Emellett 10 route-ban (`memory`, `video-ideas`, `video-packages`, `video-audits`, `profile`, `feedback`, `source-video-analysis`, 3 Stripe route) a nyers Postgres/Supabase hibaüzenet (`error.message`) közvetlenül visszament a válaszban — élőben reprodukálva (`PATCH /api/memory` érvénytelen UUID-vel → `"invalid input syntax for type uuid..."`), ugyanaz a hibaosztály, mint a 2026-07-10-i C2, de MÁS route-okon, nem lett teljesen lezárva akkor. Mindkettő javítva, ld. "BETA HARDENING TEST JAVÍTÁSOK" szakasz lent.

**KRITIKUS, 2026-07-09-i találat**: a Stripe webhook `user_credits` táblára vonatkozó feltételezése (külön `topup_credits`/`subscription_credits` oszlop) SOSEM egyezett a valós sémával (csak egy közös `balance` van) — a webhook eredeti kódja emiatt minden éles crediting-eseményre (előfizetés-indítás, topup, renewal) hibázott volna, amit a régi "nyeld el a hibát, adj 200-at" logika örökre elrejtett volna. Javítva + élőben tesztelve, ld. [AI_PROVIDER_LAYER_REFACTOR_PLAN.md](AI_PROVIDER_LAYER_REFACTOR_PLAN.md) Fázis F.

---

## 2026-07-13 (második kör) — NICHE EXPANSION ENGINE + 3 KERESÉSI MÓD (Opportunity Engine)

A user egy részletes specifikációt adott: az Opportunity Engine/Videólehetőségek keresési logikája **valós, súlyos hardcode-problémát** tartalmazott — nem a niche ment direktben a keresőbe (ez már korábban is így volt), hanem a niche-ből generált seed-kulcsszavak nagy része **szó szerint hardcode-olt, topic-specifikus lista** volt, nem dinamikus. Konkrét példa a userhez: `lib/topic-expansion.ts` `specialQueries()` 5 hardcode-olt témára (piramis/ai/pszichologia/tortenelem/alvas) adott vissza fix stringeket (pl. szó szerint `"Great Pyramid vibration"`), `lib/broad-niche-discovery.ts` pedig ~13 további hardcode-olt témát + egy 10 fix csomagos "fact discovery" listát tartalmazott. Egy niche a felismert ~18 témán kívül csak gyenge, generikus sablonozott seedet kapott.

**Megoldás — 2 fázisban, egy session-ben, terv-mód használva mindkét körben:**

1. **Niche Expansion Engine** (`lib/niche-expansion.ts`, új modul, `buildNicheExpansion()`) — a niche→seed pipeline mostantól MINDIG dinamikus, AI-alapú (kiterjesztett `lib/seed-generator.ts` `generateSeedsForNiche()`, 5→18-20 seed + tematikus "packs" csoportosítás) + szabály-alapú (a user saját szövegét sablonozó, hardcode-mentes `expandTopicQueries()`) hibrid. Törölve: `specialQueries()` (5 hardcode-olt blokk), `broad-niche-discovery.ts` `subtopicMap` (~13 hardcode-olt topic) + `buildFactDiscoveryPacks()` (10 hardcode-olt csomag), `route.ts` helyi `RESEARCH_LANE_MAP`/`decomposeNicheToLanes()` (13 hardcode-olt kategória). **Tudatosan megtartva** (nem query-generálás, hanem intent-klasszifikáció vagy pontozás): `lib/niche-fit.ts` hardcode-olt kulcsszó-térképe (a user explicit kérésére későbbi backlogra téve), `detectNicheIntent()`/`inferNicheCategory()`/`inferFreshnessWindow()` heurisztikái.
2. **3 keresési mód** (`OpportunitySearchMode`: `niche_based`/`specific_topic`/`discovery_random`, `types/index.ts`) — a user oldalán 3-utas választó pontos spec-szöveggel (`app/dashboard/opportunities/page.tsx`), a backend (`app/api/opportunity/route.ts`) mindegyiket külön kezeli: `specific_topic` módban a topic maga válik a niche-változóvá (így a niche-fit pontozás és a keresés is közvetlenül a topicra megy, a profil niche-e nem torzíthatja el), `discovery_random` módban `channel_usage_mode`-tudatos forrás-választás (detected_niche_candidates → profil main_category/specific_focus → generikus "friss ötletek" fallback, `stats_only` sose kényszerít niche-t). `search_mode` hiányában (régi deep-linkek) a korábbi `detectNicheIntent()` heurisztika fut tovább, változatlanul.
3. **Strukturált logolás** — minden keresés logolja: `search_mode, original_niche, original_topic, generated_seed_topics, rejected_seed_topics, validation_queries, language, region, platform, niche_expansion_source`, majd validáció után `youtube_results_count, serper_results_count, final_validated_topics`, plusz elutasított jelöltek oka (`[Opportunity] Rejected candidates:`).

**Élőben megerősítve, 7 teljesen eltérő niche-en (`force_refresh: true`, valós Serper/YouTube hívással)**: futónövények gondozása, pénzügyi tudatosság fiataloknak, "Futurisztikus orvosi és biotechnológiai felfedezések" (a korábbi köridőben talált profil-niche), történelmi rejtélyek, sci-fi filmek elemzése, otthoni edzés kezdőknek (`specific_topic` mód), kutyanevelés lakásban (search_mode nélküli, visszafelé-kompatibilis heurisztikus út). Mindegyik genuinely dinamikus, a niche-hez ténylegesen kapcsolódó seedeket generált (pl. "borostyán sárga levelei okai", "Christopher Nolan filmek magyarázat", "Titokzatos történelmi helyszínek magyarország") — a szerver log grep-elve `"piramis"`/`"Great Pyramid"` kifejezésekre: **0 találat** minden tesztben. `discovery_random` mód `channel_usage_mode='primary_profile'`-lal helyesen a profil niche-ét vette át forrásként. Két teszt 0 validált témát kapott — ez `[Serper] hiba: Rate limit exceeded` miatt volt (a gyors egymás utáni tesztelés lépte túl a Serper 5 req/sec limitjét), nem kódhiba. `tsc --noEmit` ✅ minden lépés után.

**⚠️ Fontos tanulság ehhez a köridőhöz**: a regressziós teszteléshez `force_refresh: true`-t használtam a user VALÓS, bejelentkezett munkamenetén keresztül (a dev böngésző-lap az ő session cookie-ját hordozta) — ez ~10 sikeres keresésnyi VALÓS kreditet vont le a fiókjából (2 kredit/keresés). A user jelezte, hogy ő is aktívan tesztelt párhuzamosan ugyanazon a szerveren. **Következő session: kredit-terhelő élő teszteléshez mindig kérdezzek rá előre, vagy használjak `force_refresh` nélküli/cache-only ellenőrzést, ha lehetséges.**

**Közvetlen live-teszt következménye — 2 további, a userrel közösen feltárt hiba, ugyanebben a körben javítva:**

1. **`lib/niche-fit.ts` 0-n ragadt niche_fit pontszám a 17 hardcode-olt kategórián kívüli niche-eknél** ([2e6429b](../../commit/2e6429b)) — a user élőben jelezte: "3. kör után jutok hozzá [egy témához], az 6 kredit, +2 kredit generálás = 8 kredit". Kiderült: a `NICHE_SEMANTIC_MAP` csak 17 kategóriát ismer fel szinonima-listával; minden más niche a fallback ágra esett, ami KIZÁRÓLAG a niche szó szerinti szavait kereste a jelölt szövegében — egy valóban releváns jelölt (pl. "Borostyán szobanövény betegségei" a "futónövények gondozása" niche-hez) szinte sosem tartalmazza szó szerint a niche szavait, score=0 lett, ami blokkolta a "Gyártható most" döntést (`decide.ts` `nicheFit>=60` küszöb). Javítva: token/prefix-alapú fuzzy tartalék (`lib/niche-relevance.ts` újrahasznosításával) + a "relevance contradiction guard" mostantól kategória-egyezés nélkül is működik, ha a topic-specifikus `relevance_average` már önmagában erős. Élőben megerősítve: "futónövények gondozása" niche_match 0 → 45/55. `lib/niche-fit.ts` továbbra sem használható query-generálásra (csak pontozásra) — ezt a fájl tetején dokumentáltuk is.
2. **Gyártási csomag — "4 bizonyíték videó" állítás, de sehol nem jelenik meg videó** ([2e6429b](../../commit/2e6429b), ugyanabba a commitba csúszott, l. lent) — a user élőben találta: a Producer Brief "2 web · 4 video" forrás-számlálót mutat, de a "🔍 Felhasznált források" szekció csak 2 webes linket listáz, videót egyet sem. Kiderült: a számláló a valós `opportunityContext.evidence_videos` tömbből jön (ami helyesen megérkezik az Opportunity Engine-től), de a ténylegesen kirajzolt forráslista egy MÁSIK, az AI által szabadon generált `result.sources_used` mezőből épül fel — ennek nincs sémamezője a forrás típusára (web/videó), és a modell megbízhatatlanul, ebben az esetben egyáltalán nem visszhangozta a 4 videót. Javítva: új, dedikált "🎥 Bizonyíték videók" blokk `app/dashboard/video-package/page.tsx`-ben, ami közvetlenül `opportunityContext.evidence_videos`-ból renderel (ugyanaz a minta, mint az Opportunity Engine oldal már működő `EvidenceVideo` komponense). **Korlát**: csak frissen generált csomagnál működik biztosan (amíg a session-ben megvan az `opportunityContext`) — egy régebbi, újranyitott csomagnál előfordulhat, hogy nem jelenik meg, ugyanaz a korlát, mint a webes forrásoknál ma is. Kód-szinten ellenőrizve (`tsc` ✅, mintaegyezés az OK oldallal), élő újragenerálással NEM tesztelve (a fenti kredit-tanulság miatt óvatosságból).

Következő session-nek nyitva maradt: a `git commit` során a niche-fit.ts és a video-package.tsx fix véletlenül egy commitba (2e6429b) került, a commit üzenet csak a niche-fit hibát írja le — tartalmilag mindkettő benne van, csak a történet nem tiszta.

---

## 2026-07-13 — CHANNEL HEADER CARD + CSATORNA-ELSŐ ONBOARDING (channel_usage_mode)

A user egy részletes, két részes specifikációt adott: (A) a Channel Audit oldal tetejére egy publikus "Channel Header Card" (csatorna-azonosító kártya, avatar/statok/badge-ek), (B) a profilbeállítás/onboarding átalakítása "channel-first" logikára, `channel_usage_mode` mezővel (`primary_profile`/`stats_only`/`niche_discovery`/`manual`), ami egységesen szabályozza, mikor szivárogjon be a csatorna/profil niche-e a generáló promptokba. Terv-mód használva (schema-audit + user döntések a duplikáció elkerülésére), majd egy menetben implementálva. Commitolva: **[b1257fc]**.

**Kész, `tsc --noEmit` ✅ + élőben megerősítve valós fiókkal (Mr.MexBrain csatorna, migráció 029 lefuttatva):**
- Migráció [029_channel_profile_and_usage_mode.sql](supabase/migrations/029_channel_profile_and_usage_mode.sql) — 14 új `profiles` oszlop, NINCS duplikálás (a meglévő niche/main_category/specific_focus/audience/region/youtube_channel_id/subscriber_count/channel_name mezők maradtak az elsődleges forrás, csak a valóban új fogalmak — channel_usage_mode, channel_connection_type, active_channel_id, detected_niche_candidates, stb. — kaptak új oszlopot).
- `components/channel-audit/ChannelHeaderCard.tsx` — publikus csatorna-kártya a Channel Audit oldal tetején, OAuth NÉLKÜL is megjelenik (avatar, feliratkozó/megtekintés/videószám, csatorna-alapítási év, `public`/`oauth`/`mismatch` badge, "Frissítve: [dátum]"), 24 órás cache-eléssel (`channel_synced_at`, külön mező az `updated_at`-től, mert azt az OAuth token-refresh amúgy is óránként írja). Adatforrás: `lib/channel-profile-sync.ts` (`syncChannelProfileFromPublic`/`syncChannelProfileFromOAuth`/`detectChannelConnectionType`) — EGYETLEN közös írási pont a `profiles` kijelző-mezőire, függetlenül attól, hogy a csatorna publikus URL-ből vagy OAuth-ból jött.
- `app/dashboard/profile/page.tsx` — új "YouTube csatorna" szekció: 4-way `channel_usage_mode` választó pontos user-adott magyar szöveggel, csatorna URL/handle feloldás+előnézet+megerősítés (`lib/competitor-tracker.ts` meglévő `resolveChannel()`-jét bővítve, NEM új resolver), `niche_discovery` módban AI-alapú niche-javaslat (`lib/channel-niche-discovery.ts`, első futás ingyenes és cache-elt userenként+csatornánként, explicit "Újraelemzés" 1 kredit, `in_flight_requests` lockkal védve a dupla-levonás ellen — ugyanaz a minta, mint a 2026-07-11-i Beta Hardening fix #1), visszatérő usereknek csatorna-összefoglaló + mismatch-feloldó kártya (ha a publikus és az OAuth-csatorna eltér, a user választ 3 opcióból, SOHA nincs automatikus felülírás).
- `lib/creator-profile-context.ts` — egyetlen új megosztott kapu (`resolveCreatorNicheContext`), ami a meglévő `shouldUseProfileNiche()` (`lib/niche-relevance.ts`, VÁLTOZATLAN) elé told egy rövidzárlatot: `stats_only` módban a profil/csatorna niche-e SOHA nem kerül generáló promptba. Bekötve mind a 6 route-ba, ahol eddig profil-niche injektálás történt: `title-studio`/`seo-optimizer`/`thumbnail-studio` (korábban is gate-elt volt, csak a `shouldUseProfileNiche` hívás cserélődött), `keyword-research`/`viral-score` (**korábban EGYÁLTALÁN NEM volt gate-elve, csak a legacy `niche` oszlopot olvasták** — ez volt az az inkonzisztencia, amit a 2026-07-12-i bejárás már dokumentált, most javítva), `video-package` (additív fallback, a kliens által explicit küldött `channel_context`/`niche` továbbra is elsőbbséget élvez).
- `middleware.ts` — az onboarding-kényszer valódi redirect lett (korábban `app/dashboard/layout.tsx`-ben holt kód volt, üres `if`-ág, sosem hívott `redirect()`-et).
- `app/api/profile/route.ts` — explicit `ALLOWED_PROFILE_FIELDS` allow-lista (korábban a nyers request body-t közvetlenül spread-elte az update-be, validáció nélkül) — a channel_usage_mode/onboarding bővítés miatt szélesedett route-felület indokolta.

**Élő regressziós teszt**: Title Studio valós hívással lefuttatva (1 valós kredit levonva, 597→596) — nincs regresszió, a meglévő funkciók változatlanul működnek. A Channel Header Card élőben, a user valós Mr.MexBrain csatornájával megerősítve (3060 feliratkozó, 687 653 megtekintés, 105 videó, "YouTube-fiókkal összekapcsolva" badge) — a `youtube_oauth_tokens`-ben már korábban (a funkció elkészülte ELŐTT) OAuth-kapcsolt userek `profiles.youtube_channel_id`-je automatikusan bootstrap-elődik az első `/api/youtube/analytics` híváskor.

**Nem épült be, tudatosan (a user "minimal migration, no duplication" elve alapján)**: a spec listázott heavy derived-analysis mezőket (strongest_topics/weak_topics/title_patterns/thumbnail_patterns/outlier_videos) `profiles`-ra perzisztálva — a Channel Audit/Competitor Tracker már élőben számolja ezeket, felesleges duplikáció lett volna. A spec "2 kredites mélyebb niche-stratégia" tier-je sincs implementálva — csak az ingyenes első-futás + 1-kredites újraelemzés.

**Utólag talált + javított hiba (user élőben jelezte, commit `c2febf2`)**: a `primary_profile` mód a gyakorlatban sosem vezette le ténylegesen a csatorna niche-ét — csak a `niche_discovery` mód épített valós csatorna→niche felismerést, a `primary_profile` csak beállította a flag-et, a `main_category`/`specific_focus` változatlanul a régi kézi értéken (a user esetében "Ai, és orvostudomány") maradt, miközben a Videólehetőségek oldal ezt mutatta niche-ként a Mr.MexBrain csatorna valós (true crime/tech/hírek) tartalma helyett. Javítva: `app/api/profile/route.ts` POST handlere `primary_profile` módban, ha a csatornához még sosem történt levezetés (`detected_niche_candidates` üres), lefuttatja a meglévő `discoverChannelNiches()`-t és a legmagasabb konfidenciájú javaslatot automatikusan alkalmazza — csak egyszer csatornánként, utána a kézi szerkesztés megmarad. Élőben megerősítve: mentés után a niche "Futurisztikus orvosi és biotechnológiai felfedezések"-re váltott (75% konfidencia).

---

## 2026-07-12 — FUNKCIÓ-BEJÁRÁS + JAVÍTÁSOK (folyamatban, context-limit miatt új chatben folytatódik)

A Beta Hardening Test lezárása után a user **funkciónkénti bejárást** kért: minden élő eszközt sorra vettünk (Trend riasztások, Kulcsszókutató, Versenytársfigyelő, Title Studio, Thumbnail Studio, SEO Optimalizáló, Tartalom naptár, Content Gap Finder, Gyártási csomag, Channel Audit, Videódiagnózis, Virális esély, Auto Transcript, Script Extractor, Tartalommemória), Claude megmagyarázta a működésüket, és a user élőben talált/jelzett hibákat, hiányosságokat menet közben. Ez **28 tételes backlogot** termelt (lásd lent, teljes szöveggel), amiből a user kérésére ("kezd el javítani") **9 tétel már meg is van javítva és élőben ellenőrizve** ugyanebben a körben.

**⚠️ FONTOS: ez a kör (a bejárás alatt talált 11 javítás, a platform-checklist és a YouTube OAuth kód-vázzal együtt) MÉG NINCS COMMITOLVA.** `git status` mutat több tucat módosított/új fájlt. Következő session elején: nézd át a diffet, majd kérdezd meg a usert, commitolja-e.

### KÉSZ (9/28, élőben ellenőrizve `tsc` + böngészős teszttel)

1. **Dashboard "Legutóbbi történeted" reopen** — toolHref térkép bővítve (title_studio, thumbnail_studio, keyword_research, content_gap [javított útvonal], channel_audit, seo_optimizer) `app/api/dashboard/summary/route.ts`-ben + paidResultId-alapú GET-reopen hozzáadva mind az 5 még hiányzó aloldalon.
2. **Dashboard KPI-kártyák kattinthatók** — `KpiCard` (`components/dashboard/CreatorIntelligenceSummary.tsx`) most `href`-et is elfogad; Videócsomagok/Auditok→`/dashboard/memory?tab=packages|audits` (a Memory oldal most olvassa a `tab` paramétert), Kredit egyenleg→`/dashboard/credits`, Mentett témák→`/dashboard/memory`.
3. **Trend Feed history kattintható** — `components/dashboard/TrendFeedHistory.tsx`, niche-alapú linkkel (a `highlight`+sessionStorage mechanizmus itt nem működött volna, mert az a sessionStorage kulcs sosem lett volna beállítva erről a panelről).
4. **Channel Audit — Rick Astley hiba, TELJESEN kijavítva** (a user élőben találta). Három rétegű hiba volt: (a) nulla relevancia-szűrés a top/bottom 3 audit kiválasztásánál → új `filterRelevantAudits()` (`lib/channel-audit.ts`); (b) a `profiles.niche` mező üres, a valós niche a `main_category`/`specific_focus`-ban van → `effectiveNiche` összefűzés bevezetve; (c) a szűrő-logikám saját hibája: `t.startsWith(n)||n.startsWith(t)` NEM ugyanaz, mint "5+ karakteres közös prefix" (pl. "orvosi" és "orvostudomany" 5 közös karaktert oszt meg, de egyik sem prefixe a másiknak) → javítva a helyes `sharedPrefixLength()` függvénnyel (most exportálva `lib/niche-relevance.ts`-ből). Élőben megerősítve: a Rick Astley/macska szeme/fogsor-videó eltűnt a "legerősebb/leggyengébb témák" listából, csak a ténylegesen releváns "Orvosi Innovációk Podcast" maradt.
5. **Virális esély kalibrációs hiba javítva** — `app/api/viral-score/route.ts` `calcBackendViralScore`+`competitionLevel`: a log-skála nevezője (100 000/500 000) irreálisan nagy volt a tényleges max számlálóhoz (totalResults, max ~40, mert `fetchYouTubeData` egyetlen 40-találatos keresésből dolgozik) képest — a sub-score sosem tudott 32/28 fölé menni. Új `MAX_REALISTIC_RESULTS=40` konstans, a nevező erre kalibrálva. Élőben megerősítve: 7 találatnál competition_level 16→56.
6. **Script Extractor — teljes narráció megjelenítése** — új "📝 Teljes narráció" szekció (`app/dashboard/script-extractor/page.tsx`), `raw_transcript`-et mutatja egyben (a backend már rég elmentette, csak sosem volt frontend-megjelenítés), csak ha `transcript_available===true`.
7. **CreatorMemoryPanel bekötve — itt egy MÁSODIK holt-kód hiba is kiderült**: a komponenst eredetileg a `RightPanel` függvénybe kötöttem volna (`components/dashboard/DashboardClient.tsx`), de kiderült, hogy maga a `RightPanel` függvény SOSEM kerül meghívásra a JSX-ben (definiálva volt, de nem renderelve — ugyanaz a hiba-osztály, mint amit korábban CreatorMemoryPanel-nél magánál találtunk). A tényleges, élő helyre kötöttem be (`<CreatorIntelligenceSummary />` mellé, közvetlenül a `DashboardClient` fő return-jében). Élőben megerősítve: az "💡 Hasonló téma korábban bejött nálad" insight-jelzés most látszik a dashboardon.
8. **Naptár + Tartalommemória skálázási hiba javítva** — `GET /api/video-ideas` új `view=calendar` mód (szerver oldali `.or()` szűrés `calendar_status=scheduled` VAGY `workflow_status IN (ready_to_produce,published)` alapján, a Naptár ezt hívja a korábbi "top 100 legutóbb frissített" helyett); `GET /api/memory` kapott egy `limit` paramétert (alap 200, max 500) a korábbi teljesen limit nélküli lekérdezés helyett.
9. **LoadingScreen bevezetve 7 eszközön** (`components/ui/LoadingScreen.tsx` új step-listákkal: titleStudio, thumbnailStudio, seoOptimizer, keywordResearch, contentGap, channelAudit, competitors) — Title Studio, Thumbnail Studio, SEO Optimalizáló, Kulcsszókutató, Content Gap Finder, Channel Audit (a javaslat-generálásnál), Versenytársfigyelő (a hozzáadásnál) korábban semmilyen animált jelzést nem adtak generálás közben, csak a gombszöveg változott.
10. **Gyártási csomag — platform-natív feltöltési checklist (a `platform` paraméter már NEM kozmetikus)** — új `lib/video-package.ts` (kiemelve a route-ból), benne egy diszkriminált union séma (`platform_checklist.type`): YouTube (long+shorts) kap `title/description/tags/category/language/captions_note/comments_setting/made_for_kids/age_restriction/license/paid_promotion_disclosure/visibility_schedule_advice/playlist_suggestion` mezőket, long-formnál plusz `end_screens_plan`/`cards_plan` (Shorts-nál ezek `null`-ra kényszerítve, mert a YouTube maga sem támogatja őket Shortson); TikTok kap `cover_image_guidance/sound_note/privacy_setting/duet_stitch_comments_settings/branded_content_disclosure`-t; Instagram Reels kap `cover_image/audio_note/alt_text/share_to_feed_toggle/collab_tag_guidance`-t; Facebook Reels kap `cross_post_to_feed/audience_visibility/music_note`-ot. Ugyanabban az AI-hívásban kérve, mint a meglévő packaging (nincs extra AI-kör/kredit), `app/api/video-package/route.ts` bővítve `platform_checklist` mezővel, `app/dashboard/video-package/page.tsx` új "📤 Platform-natív feltöltési checklist" szekcióval (`platform_checklist.type` alapján elágazó renderer). **Fontos regresszió, útközben javítva**: a bővített YouTube-séma miatt a packaging AI-hívás `maxTokens`-je (1500) kevésnek bizonyult hosszú formátumnál, JSON-csonkolást okozva (az ismert `extractJson` hibaosztály) — `maxTokens: 3500`-ra emelve, utána hiba nélkül lefutott. Élőben megerősítve mind a 4 platform-családra (TikTok, YouTube Long, Instagram Reels, Facebook Reels) valós generálással, egymástól ténylegesen eltérő mezőtartalommal. `tsc --noEmit` ✅.
11. **YouTube OAuth (valós Channel Audit analitikához) — TELJESEN KÉSZ, élőben megerősítve valós csatornával.** Új migráció [028_youtube_oauth_tokens.sql](supabase/migrations/028_youtube_oauth_tokens.sql) (`youtube_oauth_tokens` tábla, csak service_role éri el — a user lefuttatta), `lib/youtube-analytics.ts` (`saveYoutubeOAuthTokens`/`getYoutubeOAuthTokens`/`deleteYoutubeOAuthTokens`/`fetchOwnChannelInfo`/`fetchChannelAnalytics`/`buildGoogleAuthUrl` — `googleapis` OAuth2Client-tel). **Fontos architekturális tanulság útközben**: az első próbálkozás a Supabase Auth `linkIdentity()`-jét használta a Google-fiók összekötésére — ez **hibás megközelítésnek bizonyult**, mert a `linkIdentity()` bejelentkezési-módszer hozzáadására való, NEM harmadik feles API-hozzáférési token megszerzésére: sikeres linkelés után sem ad vissza `provider_token`/`provider_refresh_token`-t, ha a munkamenet aktív bejelentkezési módja nem maga a linkelt provider (nálunk az email/jelszó maradt az aktív mód). Emellett a `linkIdentity()` a Supabase Site URL-jére fut ki (nem a megadott `redirectTo`-ra), és egy ismételt linkelési kísérlet `identity_already_exists` hibával bukik el — **hash-fragmentként** (`#error=...`), amit a szerver sosem lát, csak a böngésző URL-sávja, ezért a hibakeresés rendkívül elhúzódott (több órás, lépésenkénti diagnosztika: Client Secret újragenerálás, Redirect URLs allowlist, `youtube_oauth_tokens` tábla hiánya, Supabase Auth admin API közvetlen lekérdezése az `identities` mező ellenőrzésére). **A végleges, működő megoldás**: teljesen önálló, Supabase Authtól független Google OAuth2 kör — `app/api/youtube/connect/route.ts` (GET, `buildGoogleAuthUrl()`-lal a saját `/api/youtube/oauth-callback` redirect URI-ra irányít, a `state` paraméter a user_id-t hordozza) + `app/api/youtube/oauth-callback/route.ts` (GET, `oauth2Client.getToken(code)`-dal közvetlenül váltja be a kódot, majd `saveYoutubeOAuthTokens`). `app/api/youtube/analytics/route.ts` (GET, kredit nélkül) és `app/api/youtube/disconnect/route.ts` (POST) változatlan. `app/dashboard/channel-audit/page.tsx`: "🔗 Kösd össze a YouTube csatornád" kártya (nem csatlakoztatva) / valós nézettség+watch time+feliratkozó-adat kártya (csatlakoztatva), a `connectChannel()` egyszerű `window.location.href = '/api/youtube/connect'` navigációra egyszerűsítve. A meglévő kézi `video_audits`-alapú audit-folyamat változatlan, ez kiegészíti, nem váltja le. **Élőben megerősítve valós Google-fiókkal**: a user végigment a Google Cloud Console (OAuth consent screen, scope-ok, teszt user, OAuth Client ID/Secret — egy körben újra is kellett generálni, mert az első Client Secret sosem lett helyesen elmentve) és a Supabase Dashboard (Google provider bekapcsolása, Redirect URLs allowlist) konfiguráción, majd a `/dashboard/channel-audit` oldalon sikeresen összekötötte a saját "Mr.MexBrain" csatornáját — valós adat jelent meg (2189 megtekintés, 847 perc watch time, +5/-9 feliratkozó-változás, 2026-06-14–2026-07-12 időszak). `tsc --noEmit` ✅. **Külső előfeltétel változatlan**: Google sensitive-scope (`yt-analytics.readonly`) teljes nyilvános verifikáció nélkül csak a Google Cloud-ban felvett teszt-usereknek (max 100) működik — launch előtt kell majd beadni a verifikációs kérelmet.

### MÉG NYITOTT (16/28) — session végi implementációra várnak

**Nagy, önálló al-projektek:**
- **Opcionális AI-képgenerálás** (Thumbnail Studio + Gyártási csomag közös infrastruktúrával, OpenAI gpt-image-1/DALL-E, ~3-5 kredit extra gomb, NEM a base flow-ba építve — költség/korlát-elemzés a régi backlog-szövegben).
- **YouTube OAuth Google-verifikáció** — maga a funkció élesben működik (ld. 11. pont fent), de launch előtt be kell adni a Google sensitive-scope (`yt-analytics.readonly`) verifikációs kérelmét, hogy ne csak a Google Cloud-ban felvett teszt-userekre (max 100) működjön.

**Közepes tételek:**
- SEO Optimalizáló + Gyártási csomag hashtag/tartalom valós adatra alapozása (`fetchSeedVideoStats`+`fetchKeywordSignals` a Content Gap Finderből újrahasznosítva).
- ✅ **KÉSZ (2026-07-13)** ~~Command Center: Versenytársfigyelő ("Competitor Moves" szekció) + Title Studio eredmény megjelenítése a dashboardon.~~ — Title Studio már a 2026-07-12-es körben bekerült a "Legutóbbi történeted" listába; a Versenytársfigyelő új "Versenytársfigyelő — friss kiugró videók" panelt kapott (`components/dashboard/CreatorIntelligenceSummary.tsx`, adat: `app/api/dashboard/summary/route.ts` új `competitor_moves` mezője, `tracked_competitor_videos` ahol `is_outlier=true`). Élőben megerősítve (2.0x, 5.1x kiugró videók). Commitolva: `2f08681`.
- Versenytársfigyelő: cím/thumbnail-minta elemzés + adaptációs javaslat (AI-értelmező lépés, Channel Audit "következő 10 videó" mintájára).
- Thumbnail Studio A/B side-by-side összehasonlító nézet.
- Gyártási csomag zenei aláfestés javaslat (hangulat/műfaj-leírás, NEM konkrét szerzői jogvédett cím).
- Auto Transcript hangsáv-kinyerés videófájl-feltöltésnél (a 25MB-os Whisper-limit kíméléséhez).

**Nem hiba, csak dokumentálva:**
- Content Gap Finder — jól megalapozott minta (`fetchSeedVideoStats`+`fetchKeywordSignals`), ezt kell másolni máshova.
- Videódiagnózis — nincs önálló hiba, csak ugyanaz az OAuth-korlát vonatkozik rá, mint a Channel Auditra.
- **"Piaci bizonyítékok" (Similar Videos) — user által jelzett, DE NEM javított inkonzisztencia**: a user egy "nincs találat" keresés után egy másodlagos akcióval (feltehetően "Frissítés" gomb) sok találatot kapott. Megvizsgálva: a "Nincs találat" a relevancia-kapu (relevancia≥60) szigorát jelzi, nem azt, hogy a YouTube nulla videót talált — a "Frissítés" egy szélesebb, lekérdezés-bővítéses újrakeresést indít, ami legitim módon több releváns találatot hozhat. **Valószínűleg nem hiba**, de session végén rá kell kérdezni a userre, hogy még mindig reprodukálható-e, mielőtt bármit módosítunk.

**A teljes, eredeti szövegű backlog-lista (mind a 28 tétel, sorszámozva, a fenti 9 már kipipálva) a session TaskList-jében van rögzítve — ha az új chat nem látja a task listát, ez a szakasz az önálló, teljes forrás.**

---

## 2026-07-11 — BETA HARDENING TEST JAVÍTÁSOK (a user kérésére: "minden hibát javítani kell")

A lenti "2026-07-11 — BETA HARDENING TEST" szakaszban talált mind a 7 tétel javítva ugyanebben a session-ben. `npx tsc --noEmit --incremental false` ✅ 0 hiba, `npm run build` ✅ mind a 69 route legenerálva, élő regressziós teszt a helyi dev szerveren valós kredittel (631/637 kredit, 6 elhasználva a teszthez).

| # | Hiba | Javítás | Élő teszt |
|---|---|---|---|
| 1 | Két böngészőfül dupla kreditet von | Új `in_flight_requests` tábla (migráció [027](supabase/migrations/027_in_flight_request_locks.sql)) + `lib/request-lock.ts` (`acquireRequestLock`/`releaseRequestLock`) — a fizetős route POST elején egyedi (user_id, tool_type, input_hash) sort próbál beszúrni; ha már létezik, a második kérés AI-hívás/kredit nélkül 409-et kap. Bekötve mind a 16 fizetős/kredit-köteles route-ba: title-studio, thumbnail-studio, seo-optimizer, viral-score, video-package, video-audit, script-extract, keyword-research, content-gap, channel-audit, competitors (add+refresh), opportunity, opportunity-explain, opportunity-similar, transcript, dashboard/tracked-trends/deep-refresh. | ⚠️ **NEM tesztelhető élesben, amíg a migráció nem fut le** (ld. fent) — de a "fail-open" ág (tábla hiányzik → PGRST205/42P01 → enged, régi viselkedés) élőben megerősítve: 3 párhuzamos hívás mind 200-at kapott figyelmeztető loggal, nem 409-cel. |
| 2 | Nyers Postgres hiba szivárgás 10 route-ban | `error.message`/`err.message` lecserélve route-specifikus magyar üzenetre mind a 16 helyen, a nyers hiba csak `console.error`-ba megy. | ✅ Élőben: `PATCH /api/memory` érvénytelen UUID-vel → `"Az állapot frissítése sikertelen. Próbáld újra."` (korábban nyers `"invalid input syntax for type uuid..."`) |
| 3 | `chargeFeature()`/`chargeProtectedFeature()` race-vesztésnél saját nyers hibát adott | `updateErr?.message` fallback lecserélve fix magyar szövegre ("túl sok egyidejű kérés"), nyers hiba logolva | Kód-szinten ellenőrizve (a race-ág live triggerelése az extra terheléstől függ, nem determinisztikus) |
| 4 | Title Studio (és minden `extractJson`-t használó route) JSON-parse törés ~4%-ban | `lib/services/ai-provider-service.ts` `extractJson()` — új `repairUnescapedInnerQuotes()` állapotgép: JSON.parse hiba esetén megpróbálja automatikusan escapelni a string értékek belsejében talált, nem-strukturális idézőjeleket, majd újra próbálja a parse-t; ha ez sem sikerül, az eredeti hiba megy tovább (nincs regresszió) | ✅ Élőben: a korábban hibázó 4 téma (`hajápolás száraz hajra`, `pályakezdők álláskeresése`, `vegán receptek kezdőknek`, `fotó szerkesztés kezdőknek`) mindegyike sikeresen lefutott force_refresh-sel |
| 5 | Whitespace-only input API-szinten átment és kreditet vont | `topic.trim()`/`niche.trim()`/`seed_keyword.trim()`/`channel_input.trim()` ellenőrzés hozzáadva a backend validációhoz (title-studio, thumbnail-studio, seo-optimizer, keyword-research, content-gap, video-package, viral-score, competitors) | ✅ Élőben: `{"topic":"   "}` → 400 `"Téma megadása kötelező"` (korábban 200 + kredit levonva egy "Üres" című silány eredményért) |
| 6 | Érzékeny factual témák (vakcina, klíma) konspirációs hangzású címei | `lib/title-studio.ts` promptjába új szabály: kerülje az "eltitkolják előled"/"a tudósok nem mondják el" jellegű megfogalmazást egészségügyi/tudományos témáknál, helyette tényalapú kíváncsiságkeltés; ilyen témák egyetlen változata se kapjon 40 alatti risk_score-t, ha megalapozatlan-hangzású állítást tartalmaz | Prompt-szintű javítás, nem determinisztikusan tesztelhető egyetlen hívással — a risk_score jelzés már korábban is működött (62-68 a gyanús címeknél), ez a fix a generálást magát tompítja |
| 7 | 1 gyanús niche-szivárgás eset (nem reprodukálható) | Nincs kód-szintű ok azonosítva (a kapu helyesen működött), nincs javítás — megfigyelés alatt | — |

**Fix #1 státusza: ✅ ÉLESBEN MEGERŐSÍTVE (2026-07-11).** A user lefuttatta a 027-es migrációt + egy pótlólagos `GRANT ALL ON public.in_flight_requests TO service_role;`-t (az első kör "permission denied" hibát adott, mert a service_role nem kapott automatikus jogot az új táblára — ez most már benne van magában a migrációs fájlban is). Élő teszt: 2 párhuzamos, azonos topicú Title Studio hívás (`force_refresh: true`) → delta=1 kredit (nem 2), az egyik 200-at kapott 5 címmel, a másik tiszta 409-et a magyar "Ez a kérés már folyamatban van..." üzenettel. A dupla-kredit védelem élesben működik.

---

## 2026-07-11 — BETA HARDENING TEST (5 szempont, még javítás előtt)

A user által kért utolsó mély backend/QA kör a frontend redesign előtt. Cél: bizonyítani, hogy a rendszer béta user előtt stabil. Az élő tesztek a saját (creator plan, 749→637 kredit, 112 kredit elhasználva a teszt alatt) fiókkal futottak, helyi dev szerver ellen, a böngésző-session cookie-ját újrahasználva közvetlen API-hívásokhoz (curl/node), plusz kód-audit minden API route-on.

**Összesítő verdikt: PASS WITH ISSUES.** Nincs adatszivárgás más userhez, nincs auth-bypass, nincs XSS/SQL-injection, a "amit megvettél azt visszakapod" elv szekvenciálisan hibátlan. De 2 új, korábban nem dokumentált hiba került elő (1 kritikus, 1 súlyos), plusz a már ismert JSON-csonkolási backlog-tétel gyakoriságát és gyökérokát most pontosan megerősítettük.

### 1. 100 témás tartalomminőség-teszt (Title Studio, 20 kategória × 5 téma)

95/100 sikeres, 5 hiba (mind ismert JSON-parse hibaosztály, ld. lent). Ellenőrizve script-tel a teljes eredményhalmazon:
- **Niche-szivárgás**: 1/95 gyanús eset ("állásinterjú felkészülés tippek" → 2/5 cím "orvosok és AI szakemberek"-et emlegetett). Kód-szinten megerősítve, hogy a `shouldUseProfileNiche()` kapu ezt a hívást HELYESEN nem engedte át (token-elemzés: nincs 5+ karakteres közös prefix vagy szóegyezés a téma és a niche/`main_category`/`specific_focus` között) — a NICHE sor nem került a promptba. A szivárgás forrása ismeretlen: vagy a modell spontán asszociációja (az "AI az egészségügyben" önmagában is felkapott téma volt több másik teszttémánál), vagy egy fel nem tárt indirekt út. Alacsony gyakoriság (1%), nem determinisztikusan reprodukálható, megfigyelés alatt tartandó.
- **Idegen szó**: 0 valódi találat (1 automatikus szűrő-false-positive ellenőrizve és elvetve). A korábbi P1 fix stabilan tart.
- **Cím-téma relevancia**: mind a 95 sikeres cím érdemben kapcsolódott a témához, nincs félrement generálás.
- **Érzékeny factual témák** (oltás biztonságosság, klímaváltozás, vakcina mellékhatások): a Title Studio generál "mit hallgatnak el előled" / "a tudósok nem mondják el" jellegű összeesküvés-hangzású cím-változatokat is ezekre — DE a modell saját `risk_score`-ja ezeket konzisztensen magasra (62-68/100) értékelte a többi változathoz képest (8-35/100), tehát a jelzés létezik és látható a usernek, csak a generálás maga nem szűri ki előre ezeket. Termékdöntést igényel: legyen-e szigorúbb risk-plafon vagy figyelmeztető sáv érzékeny témáknál, mielőtt megjelenik a listában.

### 2. Kredit / paid result stress test

- **✅ Reopen / "amit megvettél azt visszakapod"**: szekvenciális újrahívás ugyanarra a topicra force_refresh nélkül → 2. hívás `from_paid_result:true`, NEM von le kreditet, ugyanazt az eredményt adja vissza. Élőben megerősítve, hibátlan.
- **🔴 KRITIKUS — két egyidejű kérés (két böngészőfül) dupla kreditet von le**: 2 párhuzamos, azonos topicú, `force_refresh:true` Title Studio hívás → mindkettő 200-at adott, mindkettő saját `paid_result_id`-t generált (ugyanarra a sorra upsertelve), de a kredit egyenleg mindkét hívásnál külön csökkent (delta=2, nem 1). A frontend `disabled={loading || ...}` state megvédi az EGY fülön belüli dupla kattintást, de KÉT FÜL / KÉT ESZKÖZ ellen nincs semmilyen szerver oldali védelem, mert a `chargeFeature()` optimista zárolása csak a balance-mező konzisztenciáját védi (nem enged negatívba menni), nem azt, hogy két függetlenül induló, mindkettő sikeres kérés ne fusson le kétszer.
- **🔴 SÚLYOS — race-vesztés esetén nyers technikai hiba szivárog ki**: 5 párhuzamos kérésnél 1 elbukott a `chargeFeature()` optimista zár ütközésén, és a válasz `error` mezője szó szerint ez volt: `"Cannot coerce the result to a single JSON object"` — nyers PostgREST hibaüzenet, nem magyar, nem érthető, és FÉLREVEZETŐ is (nem "nincs elég kredited", hanem race-vesztés). Gyökér: `lib/credits.ts` `chargeFeature()` `updateErr?.message || 'A kredit levonás nem sikerült...'` fallback-je — az `updateErr?.message` ág aktiválódott, mert a `.single()` 0 sorra hibázik.
- **✅ Race-vesztés esetén NEM vész el a user kreditje** — kód-szinten megerősítve (a charge csak az AI-hívás/JSON-parse UTÁN fut, ha a charge maga bukik, a balance változatlan marad). Az AI-hívás költsége (üzleti oldali veszteség) igen felmerül — ez a már ismert M5 backlog-tétellel egyezik.
- **"Nincs elég kredit"**: kód-audittal megerősítve (`hasEnoughCredits()` minden route elején fut, konzisztens 402 + magyar üzenet) — élő 0-kredit állapotot NEM idéztünk elő (749→637 kredittel nem reális), ez az egyetlen pont, ami tisztán kód-review, nem élő teszt.

### 3. Edge case input teszt

- **🟡 KÖZEPES — whitespace-only input érvényes kérésként megy át ÉS kreditet von**: `topic: "   "` (csak szóköz) a backend `!topic` ellenőrzésén átcsúszik (nem üres string), lefut a teljes AI-hívás, a modell egy "Üres" című, 0-pontos silány címet ad vissza, és a rendszer LEVON ÉRTE 1 kreditet (`_credits_remaining` és `paid_result_id` a válaszban bizonyítja). A frontend `disabled={!topic.trim()}` ezt NORMÁL UI-használatban megakadályozza — tehát élő userre alacsony a kockázat —, de az API maga nem trim-eli/validálja a topicot, ami bármilyen jövőbeli API-kliens (mobil app, közvetlen API-hívás) esetén kihasználható defense-in-depth rés.
- **🔴 SÚLYOS (megerősítés, nem új) — Title Studio JSON-parse törés ~4%-os gyakorisággal, RÖVID, hétköznapi témákon is**: a 100 témás körben 4/100 (4%) hibázott `"Cím-generálás sikertelen. Próbáld újra."` 500-as hibával — köztük teljesen hétköznapi, rövid témák is ("hajápolás száraz hajra", "pályakezdők álláskeresése", "vegán receptek kezdőknek", "fotó szerkesztés kezdőknek"). Élő szerver-log alapján a PONTOS gyökérok most azonosítva: a modell időnként escapelés nélküli idézőjelet tesz egy JSON string ÉRTÉKÉBE (pl. `"...de az "sokkal könnyebb" túlígérés lehet..."`), ami JSON.parse szintaxis-hibát okoz `lib/services/ai-provider-service.ts` `extractJson()`-jában. Ez ÚJRAÉRTÉKELI a korábbi handover feltételezését ("maxTokens valószínűleg szűk hosszabb témáknál") — a valós gyökérok nem a téma hossza, hanem a nem-escapelt idézőjel, ami BÁRMELY témán, RÖVIDEN is bekövetkezhet, és ~4%-os alap-gyakorisággal jelentkezik, nem ritka kivétel. Kredit NEM vész el (charge a parse után fut) — ez billing-szempontból biztonságos, de a user egy sikertelen, újrapróbálandó kérést kap ~minden 25.-nél.
- **✅ Túl tág egyszavas input** ("AI", "egészség"): nem hibázik, generál, tartalmilag elfogadható (bár "AI" esetén mind az 5 cím orvosi irányba ment — ld. niche-relevancia megjegyzés fent, ez esetben jogos, mert a "AI" szó ténylegesen egyezik a niche tokennel).
- **✅ Nagyon hosszú input, vesszős niche-lista, emoji, számok, angol input magyar módban, spam-szerű input, SQL-injection-szerű input**: mind lefutott hiba nélkül, elfogadható (bár helyenként semmitmondó, pl. tisztán számokra generált cím) tartalommal. Nincs crash, nincs biztonsági incidens.
- **✅ SQL injection próba** (`'; DROP TABLE video_ideas; --` mint topic): a Supabase JS kliens paraméterezett lekérdezései miatt egyszerű szövegként kezelve, nulla adatbázis-kockázat — a modell még videótémaként is felismerte és feldolgozta biztonságosan.
- **✅ script-extract hibás/nem-YouTube/üres URL**: mind tiszta 400-as, magyar hibaüzenettel jött vissza validáció szinten, kredit-hívás előtt.

### 4. Mobil / böngésző kompatibilitás

Vizuális pixel-screenshot ebben a körben technikai okokból (a screenshot eszköz ismételten időtúllépést adott, valószínűleg a párhuzamosan futó 100 témás batch miatti erőforrás-terhelés) nem volt elérhető — DOM-szintű metrikával (`scrollWidth`/`clientWidth`) és accessibility-tree olvasással ellenőrizve helyette:
- **✅ Nincs vízszintes szétesés** 375px, 390px (iPhone), 768px (tablet) viewport-on a Dashboard, Title Studio, Gyártási csomag eredményoldal, Videólehetőségek, Naptár és Versenytársfigyelő oldalakon (`scrollWidth === clientWidth` mindenhol).
- **✅ Mobil sidebar helyesen csukott állapotból nyit/zár** (hamburger → teljes navigáció megjelenik "Menü bezárása" gombbal → bezáráskor visszacsukódik) — a korábbi H1 hotfix stabilan tart.
- **Ajánlott**: egy gyors manuális vizuális átnézés (nem csak DOM-metrika) még a béta előtt, mivel ebben a körben pixel-szintű screenshot nem készült.

### 5. Security / jogosultsági alapteszt

- **✅ Auth nélküli API-hozzáférés**: `middleware.ts` minden `/api/*` route-ot (a `/api/cron/*` és `/auth`, `/privacy`, `/terms` kivételével) blanket-védelemmel lát el — bejelentkezés nélküli kérés 307-tel `/auth/login`-ra redirektál, MIELŐTT a route handler lefutna. Élőben tesztelve cookie nélkül `/api/facts`, `/api/quota`, `/api/credits`, `/api/video-ideas`, `/api/memory` ellen — mind redirektált, egyik sem adott adatot.
- **✅ Cross-user paid_result/video_idea hozzáférés**: kód-auditban minden releváns query (`paid_results`, `video_ideas`, `creator_memory`, `tracked_competitors`, `tracked_competitor_videos`, `video_audits`, `video_packages`, `user_credits`) `.eq('user_id', ...)`-vel szűr — `getPaidResultById`/`getPaidResultByHash` (`lib/paid-results/paid-results-service.ts`) is user_id-vel scope-olt. Élő második teszt-fiókkal NEM ellenőriztük (fiók létrehozása nem az én hatásköröm), ez kód-audit, nem élő cross-account teszt.
- **✅ Nincs XSS-vektor**: `dangerouslySetInnerHTML` nulla előfordulás a teljes `app/` és `components/` fában — React alapból escape-eli az AI-generált/user-generált szöveget.
- **✅ Nincs SQL injection**: ld. fent, Supabase kliens paraméterezett query-i miatt.
- **🔴 KRITIKUS (ismert hibaosztály, ÚJ helyeken) — nyers Postgres/Supabase hiba szivárog ki 10 route-ban**: a 2026-07-10-i C2 hotfix csak 3 helyet (`competitors`, `trend-alerts`) zárt le. Most feltárva: `app/api/memory/route.ts` (4 hely: GET/POST/PATCH/DELETE), `app/api/video-ideas/route.ts` (2 hely), `app/api/video-packages/route.ts` (3 hely), `app/api/video-audits/route.ts`, `app/api/profile/route.ts`, `app/api/feedback/route.ts`, `app/api/source-video-analysis/route.ts`, plusz 3 Stripe route (`create-subscription-session`, `customer-portal`, `create-topup-session`) — mind `error.message`/`err.message`-et ad vissza közvetlenül. Élőben reprodukálva: `PATCH /api/memory` érvénytelen UUID-vel → `{"error":"invalid input syntax for type uuid: \"not-a-uuid\""}`. Emellett a `chargeFeature()` race-vesztésnél (ld. 2. pont) SAJÁT, eddig fel nem tárt raw-error útvonala is van.
- **Architektúra-megjegyzés**: minden API-route service-role (`createAdminClient()`) klienssel dolgozik, ami megkerüli az RLS-t — tehát a Supabase RLS szabályok (bár léteznek néhány táblán) NEM adnak valódi védelmi hálót ez esetben, a teljes cross-user védelem az alkalmazás-szintű `user_id` szűrésen múlik. Ezt jelen körben minden érintett táblán ellenőriztük és rendben találtuk, de ez azt jelenti, hogy egyetlen jövőbeli route, ami elfelejti a `.eq('user_id', ...)`-t, azonnal teljes cross-user adatszivárgás — érdemes megfontolni egy lint-szabályt vagy code-review checklistet erre.

### Javasolt javítások prioritás szerint

| # | Hiba | Modul | Súlyosság | Javaslat |
|---|---|---|---|---|
| 1 | Két böngészőfül / konkurrens kérés dupla kreditet von | `lib/credits.ts` `chargeFeature()` | Kritikus | Kérés-szintű zár bevezetése (pl. rövid életű "in-flight" lock az `input_hash`+`user_id` kulcson, vagy a már létező `chargeProtectedFeature` mintájának kiterjesztése minden route-ra, nem csak az Opportunity Engine-re) |
| 2 | Nyers Postgres hiba szivárog 10 route-ban | `memory`, `video-ideas`, `video-packages`, `video-audits`, `profile`, `feedback`, `source-video-analysis`, 3 Stripe route | Kritikus | Ugyanaz a minta, mint a 2026-07-10 C2 fixnél: generikus magyar hibaüzenetre cserélni, a nyers hibát csak szerver-logba írni. Érdemes egy megosztott helper függvényt csinálni (`toSafeErrorResponse(error)`), hogy ne route-onként kelljen újra elfelejteni |
| 3 | Race-vesztésnél a `chargeFeature()` saját raw-error fallback-je | `lib/credits.ts` | Súlyos | `updateErr?.message` fallback cseréje fix magyar szövegre ("Túl sok egyidejű kérés, próbáld újra") |
| 4 | Title Studio (és feltehetően a többi `extractJson`-t használó route) JSON-parse törés ~4%-ban, nem-escapelt idézőjel miatt | `lib/services/ai-provider-service.ts` `extractJson()` + a promptok | Súlyos | `extractJson`-ba egy "repair" lépés (nem-escapelt idézőjelek heurisztikus escapelése parse előtt), ÉS/VAGY a promptban explicit tiltás szigorítása + retry egy alkalommal parse-hiba esetén AI-hívás szinten |
| 5 | Whitespace-only input API-szinten átmegy és kreditet von | `app/api/title-studio/route.ts` (és feltehetően a többi hasonló route) | Közepes | `topic.trim()` ellenőrzés a backend validációba is, ne csak a frontendbe |
| 6 | Érzékeny factual témák (vakcina, klímaváltozás) konspirációs hangzású cím-változatai | `lib/title-studio.ts` promptja | Alacsony/termékdöntés | Megfontolandó: szigorúbb risk-plafon vagy figyelmeztető UI-jelzés magas `risk_score`+érzékeny téma kombinációnál |
| 7 | 1 gyanús niche-szivárgás eset (nem reprodukálható determinisztikusan) | ismeretlen | Alacsony, megfigyelendő | Nincs azonnali teendő, a kód-audit szerint a kapu helyesen működött ennél a hívásnál |

**Nincs blokkoló (Kritikus, azonnal-javítandó-launch-előtt jellegű) biztonsági rés** — a két Kritikusnak jelölt tétel (dupla kredit, nyers hibaszivárgás) nem enged illetéktelen hozzáférést más userhez, "csak" billing-pontosságot és belső hibaüzenet-higiéniát érint, de mindkettő élőben reprodukálható és javasolt még a fizetős pilot előtt lezárni.

---

## 2026-07-10 — LAUNCH READINESS AUDIT + HOTFIX SPRINT

A user által elrendelt feature freeze után egy 13 szempontos audit (route-ok, kredit/paid_results logika, mobil nézet, mock adat, hardcode-olt magyar logika, hibaüzenetek, core flow) 2 kritikus és 4 súlyos hibát talált. Ezeket egy külön hotfix sprintben javítottuk, prioritás szerint.

**✅ [026_paid_results_opportunity_channel_audit.sql](supabase/migrations/026_paid_results_opportunity_channel_audit.sql) élesben lefuttatva (2026-07-10), utána C1 és H3 mentés/reopen ciklusa is végponttól végpontig megerősítve élő kredittel — ld. táblázat.**

| # | Hiba | Súlyosság | Állapot |
|---|---|---|---|
| C1 | Opportunity "Mutass mást"/"Mutass hasonlót" — nincs CreditConfirmModal, nincs paid_results/input_hash, refresh után elveszett fizetett eredmény | Kritikus | ✅ Kész, élőben tesztelve: charge pontosan 1x (33→32), ismételt azonos kérés `from_paid_result:true` nem von újra, GET reopen sem von, dupla kattintás ellen `useRef` zár |
| C2 | Nyers Supabase/Postgres hiba szivárgott ki 3 helyen (`competitors` GET/DELETE, `trend-alerts` POST dismiss) | Kritikus | ✅ Kész — magyar, általános hibaüzenetre cserélve, a részletes hiba szerver oldalon logolva |
| H1 | Mobil sidebar sosem csukódott össze, 375px-en a tartalom ~115px sávba szorult | Súlyos | ✅ Kész, élőben tesztelve mobil (375px, hamburger nyit/zár, route-váltáskor auto-zár) és desktop (1280px, statikus sidebar) nézetben is |
| H2 | SEO Optimalizáló fizetett csomagja sehova nem volt menthető a frontendről (a backend valójában már jól cachelt, csak a frontend nem használta) | Súlyos | ✅ Kész, élőben tesztelve: 1. generálás kredit, ismételt azonos kérés ingyenes (`from_paid_result`), GET-es visszanyitás ingyenes, `force_refresh` ismét kreditet von |
| H3 | Channel Audit 2 kredites "következő 10 videó" javaslata sehova nem mentődött | Súlyos | ✅ Kész, élőben tesztelve: charge pontosan 2x kredit (32→30), ismételt azonos kérés `from_paid_result:true` nem von újra |
| H4 | 5 helyen a frontend nem ellenőrizte a `res.ok`-ot, csendben elnyelte a szerverhibát | Súlyos | ✅ Kész mind az 5 helyen (`competitors` load+delete, `trend-alerts` dismiss, `calendar` load, `channel-audit` load) — mindegyik most `res.ok` ellenőrzést és magyar hibaüzenetet kap |

**Mind a 6 pont (C1, C2, H1–H4) tiszta — a hotfix sprint lezárva, a rendszer megfelel a user által szabott feltételnek a 30–50 témás teszthez.**

**Tesztelés**: `npx tsc --noEmit --incremental false` ✅ 0 hiba, `npm run build` ✅ sikeres (mind a 69 route legenerálva). Élő böngészős/API teszt valós kredittel: H1 mobil+desktop, H2 teljes ciklus (charge→cache-hit→GET reopen→force_refresh), C1 és H3 teljes ciklus (charge→cache-hit→GET reopen) migráció után. Összesen 7 kredit lett elhasználva a user fiókjából a tesztelés során (37→30).

**Tudatosan backlogban maradt (M1–M6, a user kérésére nem ebben a körben)**:
- **M1+M2**: 5 lib fájl AI promptja (`title-studio`, `thumbnail-studio`, `seo-optimizer`, `channel-audit`, `content-gap`) fixen magyarra van hegesztve, nincs `language` paraméter; 5 frontend oldal fixen `region:'HU'`-t küld a profil piac-mezője helyett. HU-only pilothoz nem blokkoló.
- **M3**: a Command Center (`DashboardClient.tsx`) egyetlen Phase 2 modulra sem linkel — csak sidebar-ból érhetők el.
- **M4**: Kulcsszókutató, SEO Optimalizáló, Content Gap Finder, Channel Audit nincs bekötve a központi Video Idea objektumhoz (csak `creator_memory`-ba mentenek).
- **M5**: ~8 route-nál a drága AI/API hívás a kredit-levonás ELŐTT fut le (nem dupla-levonás kockázat, csak elveszett API-költség egy sikertelen levonásnál).
- **M6**: a heti ingyenes Videólehetőségek-keresés automatikusan elindul oldalbetöltéskor — tudatos termékdöntés kell, hogy ez szándékos-e.

---

## 2026-07-10 — 30 TÉMÁS TESZT + MINŐSÉGI STABILIZÁLÁS (P0/P1)

A Hotfix Sprint lezárása után egy 30 témás élő teszt (1 teljes core-flow kör + 22 önálló Title Studio futás, valós kredittel) 4 új hibát talált — mind tartalomminőségi/bizalmi jellegű, nem billing- vagy route-hiba. Ezeket egy célzott P0/P1 körben javítottuk:

| # | Hiba | Prioritás | Állapot |
|---|---|---|---|
| Niche-szivárgás | A profil niche-e (pl. "AI, orvostudomány") indokolatlanul beszivárgott teljesen más témájú Title Studio/SEO/Thumbnail Studio generálásokba (~55% gyakoriság a tesztben) | P0 | ✅ Kész — új [lib/niche-relevance.ts](lib/niche-relevance.ts) `shouldUseProfileNiche()` relevancia-kapu, a niche csak akkor kerül a promptba, ha a téma ténylegesen kapcsolódik hozzá (szó-egyezés vagy ≥5 karakteres közös prefix a téma és niche/main_category/specific_focus tokenjei között). Érintve: `lib/title-studio.ts`, `lib/seo-optimizer.ts`, `lib/thumbnail-studio.ts` + a 3 route.ts |
| Fact Safety irreleváns tény | A Gyártási csomag `verified_facts`-ba bekerült egy teljesen kapcsolódás nélküli Wikipedia-tény (egy futballista életrajza egy edzős videóhoz) | P0 | ✅ Kész — a gyökérok az `app/api/facts/route.ts` laza Wikipedia/Serper keresése volt, relevancia-ellenőrzés nélkül. Új `isFactRelevantToTopic()` (`lib/fact-safety.ts`) a forrásokat a témával összeveti, mielőtt bekerülnének a `sources`/`fact_block`-ba; a `buildVerifiedFactBlock()` is szűri a web/YouTube forrásokat (defense-in-depth az Opportunity-kontextusos útvonalhoz) |
| Félrevezető "0 kredit" szöveg | A Gyártási csomag oldal friss, fizetett generálás után is "0 kredit"-et írt | P1 | ✅ Kész — új `reopenedWithoutCharge` állapot (`app/dashboard/video-package/page.tsx`) csak a valódi kredit nélküli visszanyitási utaknál (`loadPaidResult`, `loadSavedPackage`, sessionStorage-visszaállítás) igaz; friss generálás után külön, nem félrevezető szöveg ("Gyártási csomag elkészült és mentésre került.") |
| Idegen szó magyar címben | "...amit az AI descobrált..." — portugál/spanyol szó egy magyar címben | P1 | ✅ Kész — `validateHungarianTitle()`/`sanitizeHungarianTitle()` (`lib/title-studio.ts`), determinisztikus feketelista-alapú csere AI-hívás nélkül + prompt-szintű megerősítés mindhárom (Title/SEO/Thumbnail Studio) promptban |
| Kredit-levonás versenyhelyzetben | `chargeFeature()` (`lib/credits.ts`) optimista zárolása retry nélkül — párhuzamos kérések egy része feleslegesen elbukik ("Próbáld újra"), dupla levonás nélkül | P2 | ⏳ Backlogban — javaslat: 2-3 rövid retry, kis jitterrel, friss balance újraolvasással, ugyanazzal az atomi `WHERE balance = X` feltétellel (nem szabad dupla levonást engedni retry közben sem). Rendszerszintű, minden `chargeFeature()`-t használó fizetős funkciót érint |

**Tesztelés**: `npx tsc --noEmit --incremental false` ✅, `npm run build` ✅. Célzott újrateszt: 10 témás niche-szivárgás lista (8 irreleváns + 2 releváns téma a profil niche-éhez).

---

## 2026-07-10 — PIACI BIZONYÍTÉKOK: IRRELEVÁNS VIDEÓ "AJÁNLOTT INSPIRÁCIÓ"-KÉNT (user jelentette)

A user élő keresésnél ("budapest mesterséges intelligencia kórházak", HU régió) egy Michael Jackson-videót és egy magyar politikai hírt (CNN) kapott "Ajánlott inspiráció" címkével, 92 ill. 72 ponttal — nulla topikai kapcsolat a kereséssel.

**Gyökérok**: `app/api/similar-videos/route.ts` a relevancia-pontszámot mesterségesen 60-ra emelte (`Math.max(relevance.score, 60)`), ha a Haiku-alapú keresés-bővítés találta a videót és a valós pontszám ≥40 volt. A `decideSimilarVideo()` (`lib/scoring/willviral-decision-engine.ts:82`) döntési motor pontosan a `< 60` relevancián dob — a mesterséges felkerekítés éppen ezt a kaput kerülte meg, így egy valójában 40-59 pontos (gyenge/irreleváns) találat átment a kapun, és onnantól pusztán frissesség/engagement alapján kaphatott "Ajánlott inspiráció" címkét.

**Javítva**: a mesterséges `Math.max(...,60)` eltávolítva, a relevancia mindig a ténylegesen számolt érték. Élőben megerősítve `force_refresh`-sel: a Michael Jackson-videó most helyesen `relevance: 47`, "Nem releváns", 0 pont; a Péter Magyar-videó `relevance: 44`, "Nem releváns", 0 pont. A ténylegesen releváns találatok (AI/orvostudomány podcastok, kórházi videók) helyes, becsületes relevanciával (61-69) kerültek előtérbe. `tsc --noEmit` ✅.

---

## 2026-07-10 — SESSION-PERZISZTENCIA HIBA JAVÍTVA (user jelentette)

A user jelezte: ha a Browser pane-t elhagyta majd visszaváltott, egy korábban generált eredmény eltűnt az oldalról. Átvizsgálva mind a fizetős/generáló oldalt (`grep sessionStorage app/dashboard/**`): **4 oldalnak egyáltalán nem volt session-perzisztenciája** — a generált eredmény kizárólag React `useState`-ben élt, egy remount (app-váltás, hard reload) törölte. A szerveren a `paid_results` cache megvolt, de a frontend nem töltötte vissza automatikusan, így a usernek úgy tűnt, mintha véglegesen elveszett volna.

**Javítva** (ugyanaz a minta, mint a Virális esély/Gyártási csomag oldalakon már bevált): `useEffect`-es visszaállítás mountkor + `sessionStorage.setItem` sikeres generálás után — `app/dashboard/title-studio/page.tsx`, `app/dashboard/thumbnail-studio/page.tsx`, `app/dashboard/keyword-research/page.tsx`, `app/dashboard/content-gap/page.tsx`. Élőben tesztelve: Title Studio, teljes oldal-reload után a téma és a generált cím visszatöltődik. `tsc --noEmit` ✅.

---

## 2026-07-10 — 30-50 TÉMÁS TESZT LEZÁRVA

A P0/P1 javítások után a témás teszt folytatódott és lezárult. Két kör:

**1. Retest force_refresh-sel** — a 6 korábban hibás témát (kertészkedés, smink, párkapcsolat, futás, nyelvtanulás, fotózás) muszáj volt `force_refresh: true`-val újrafuttatni, mert az első próbálkozás a JAVÍTÁS ELŐTTI `paid_results` cache-találatot adta vissza (`from_paid_result: true`, ugyanaz a hibás cím) — ez tanulság, nem hiba: input-hash cache mellett a "már javítottam, teszteljük újra" workflow mindig kér `force_refresh`-t, különben a régi eredmény jön vissza. Force_refresh-sel: **6/6 téma teljesen tiszta**, nincs AI/orvos-szivárgás, nincs idegen szó. Egy teljes Videócsomag kör (kerti veteményeskert) is megerősítette a Fact Safety javítást: `verified_facts: []` + `quality_status: "insufficient_sources"` — a rendszer most inkább üresen hagyja a tény-blokkot, mint hogy irreleváns forrást "ellenőrzöttként" mutasson be.

**2. Új témalista bővítés** — 18 friss, változatos téma (főzés, pénzügy, állatgondozás, mentális egészség, hobbik, karrier stb.) Title Studio-n keresztül. 17/18 sikeres és tiszta. **1 új hiba találva**:

| Hiba | Súlyosság | Részlet |
|---|---|---|
| Title Studio JSON-csonkolás hosszabb témáknál | Közepes | A "lakáshitel vs bérlés 2026" témára az AI-válasz az 5. cím-variáció közepén megszakadt (`maxTokens: 1500` valószínűleg szűk, ha a `reasoning` mezők hosszabbak) → `extractJson` parse-hiba → 500-as válasz. **Kredit NEM lett levonva** (a hiba a charge előtt történik), tehát billing-biztonsági szempontból rendben van, de a user egy sikertelen, újrapróbálandó kérést kap. Nincs javítva — backlogra való (`lib/services/ai-provider-service.ts extractJson` + `app/api/title-studio/route.ts maxTokens` érintett). |

Kisebb, nem-blokkoló megfigyelések: 2 cím enyhén nyelvtanilag esetlen volt (egy befejezetlen mondat, egy egyeztetési hiba) — elszórt AI-változékonyság, nem rendszerszintű minta, nem igényel kódjavítást.

**Összesítve a teljes témás teszt-erőfeszítésre** (ez a session + a korábbi körök): **50+ egyedi témán** futott végig a Title Studio, ~10 témán a teljes core flow releváns szelete (Viral Score, Similar Videos, SEO, Video Package), kumulatívan minden korábban talált P0/P1 hiba megerősítve javítva. Az egyetlen új találat (JSON-csonkolás) nem billing- vagy tartalom-bizalmi hiba, hanem robusztussági rés — a user eldöntheti, hogy ez blokkolja-e a béta indítást, vagy mehet a backlogba.

**A user 6 lépéses launch-terve szerint a 3. lépés (30–50 témás teszt) ezzel lezárva.** Következő döntési pont: 4. lépés (5–10 külső béta user) vagy a JSON-csonkolás hiba előzetes javítása.

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
| **PHASE 1 — Creator OS alap** | 10/12 kész, 2/12 részleges (külső függőségre várnak: #3 nav-szerkezet, #11 multi-currency) |
| **PHASE 2 — Versenyképes platform funkciók** | ✅ 10/10 kész (2026-07-09), mind élőben tesztelve |
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

## PHASE 2 — ✅ 10/10 KÉSZ (2026-07-09), a user kérésére mind a 10 modult megépítettük egy menetben

**Séma-alap**: [023_phase2_modules_foundation.sql](supabase/migrations/023_phase2_modules_foundation.sql) — EGY migrációban az összes modulhoz szükséges `paid_results` tool_type bővítés (`keyword_research`, `competitor_tracker`, `outlier_detector`, `title_studio`, `thumbnail_studio`, `seo_optimizer`) + `tracked_competitors`/`tracked_competitor_videos`/`trend_alert_dismissals` táblák. Lefuttatva.

**Mellékesen talált+javított hiba**: [024_creator_memory_missing_columns.sql](supabase/migrations/024_creator_memory_missing_columns.sql) — a `creator_memory` tábla sosem tartalmazott `source_context`/`quality_status` oszlopot, pedig az `app/api/memory` POST route régóta feltételesen írja ezeket — bármely hívó, ami truthy értéket küldött ezekhez, 500-as hibát kapott csendben. A Keyword Research "Mentés" gombjának élő tesztje leplezte le. Javítva, élőben ellenőrizve.

| # | Modul | Állapot | Megjegyzés |
|---|---|---|---|
| 1 | Keyword Research | ✅ Kész (2026-07-09) | `lib/keyword-research.ts` (Serper relatedSearches/peopleAlsoAsk), `app/api/keyword-research/route.ts` (valós YouTube-adat + `buildScoreBreakdown` — nem talált szám, `callAIProvider` a klaszterezéshez), `app/dashboard/keyword-research/page.tsx`. 1 kredit, input-hash cache, `CreditConfirmModal`. Élőben tesztelve: valós keresés (25 YouTube találat), 10 konkrét kulcsszó-javaslat, 1 kredit levonva (57→56), ismételt keresés ingyenes cache-ből, "Mentés Video Idea-ként" működik. |
| 2 | Competitor Tracker | ✅ Kész (2026-07-09) | `lib/competitor-tracker.ts` (`resolveChannel` — URL/@handle/channel ID/névkeresés; `fetchChannelRecentVideos` — kvóta-hatékony `channels`+`playlistItems`+`videos` lánc, 3 egység/ellenőrzés a `search.list` 100 egysége helyett). `app/api/competitors` (GET/POST/DELETE), `app/api/competitors/[id]/refresh`, `app/api/competitors/save-signal` (outlier → `video_idea_proof_signals`, `signal_type: competitor_video`). `app/dashboard/competitors/page.tsx`. 1 kredit hozzáadásért/frissítésért. Élőben tesztelve valós csatornával (@mkbhd → Marques Brownlee, 21.1M feliratkozó): hozzáadás (56→55 kredit), duplikáció-védelem (409), frissítés (55→54), proof signal mentés, törlés — mind hibátlan. |
| 3 | Outlier Detector | ✅ Kész, a Competitor Trackerbe építve (2026-07-09) | Nem külön oldal — a `fetchChannelRecentVideos` minden versenytárs-videóra kiszámolja az `outlier_ratio`-t a csatorna saját átlagához képest (`is_outlier` ha ≥2x), és a UI kiemeli 🔥 jelöléssel. Ugyanaz az adatforrás, külön oldal csak duplikálná. |
| 4 | Title Studio | ✅ Kész (2026-07-09) | `lib/title-studio.ts` (backend heurisztikák: hossz, szám/kérdőjel jelenlét, caps-lock túlzás, clickbait-jel túlzsúfoltság — objektív, nem AI-becsült; `buildTitleStudioPrompt`). `app/api/title-studio/route.ts` (5 cím-variáció `callAIProvider`-rel, mindegyik curiosity/clarity/clickability/risk AI-értékeléssel — UI-n egyértelműen "AI-értékelés", nem mért adat). PATCH: kiválasztott cím mentése `video_ideas.title_ideas`-ba. `app/dashboard/title-studio/page.tsx`. 1 kredit. Élőben tesztelve: 5 valódi, eltérő cím, score-okkal (54→53 kredit), mentés működik, ismételt keresés ingyenes cache-ből. |
| 5 | Thumbnail Studio | ✅ Kész (2026-07-09) | `lib/thumbnail-studio.ts` (`checkThumbnailText` — objektív hossz/szószám-ellenőrzés, hogy kis méretben is olvasható maradjon; `buildThumbnailStudioPrompt`). `app/api/thumbnail-studio/route.ts` (3 vizuális koncepció `callAIProvider`-rel — nincs képgenerálás, csak leírás/kompozíció/szöveg-javaslat, a terv szerint is ez az elvárt első kör). PATCH: `video_ideas.thumbnail_concepts`-be mentés. `app/dashboard/thumbnail-studio/page.tsx`. 1 kredit. Élőben tesztelve: 3 valóban eltérő koncepció (53→52 kredit), mind olvasható thumbnail-szöveggel, mentés + cache-hit működik. |
| 6 | SEO / Upload Optimizer | ✅ Kész (2026-07-09) | `lib/seo-optimizer.ts` (`computeSeoHeuristics` — objektív cím/leírás-hossz, kulcsszó-lefedettség, tag-szám ellenőrzés; `computeSeoScore` ezekből számol 0-100 pontszámot). `app/api/seo-optimizer/route.ts` (`callAIProvider`-rel teljes csomag: cím, leírás, tagek, hashtagek, fejezetek, playlist, pinned comment, CTA). `app/dashboard/seo-optimizer/page.tsx` (másolható mezőkkel). 1 kredit. Élőben tesztelve: teljes csomag generálva, SEO score 100/100, 1 kredit levonva (52→51), ismételt keresés ingyenes cache-ből. |
| 7 | Content Calendar UI | ✅ Kész (2026-07-09) | Migráció [025_video_ideas_calendar_fields.sql](supabase/migrations/025_video_ideas_calendar_fields.sql): `video_ideas.scheduled_publish_date`/`calendar_notes` (a mesterterv explicit kérte a publikálási dátumot, ez hiányzott). `app/api/video-ideas` PATCH bővítve. `app/dashboard/calendar/page.tsx` — 3 szekció (Ütemezve/Gyártásra kész, még nincs ütemezve/Legutóbb publikált), dátum+jegyzet mentés, "Publikáltnak jelölés". Nincs kredit, tisztán olvasás/írás a meglévő adatmodellen. Élőben tesztelve: ütemezés mentése, megjelenítés a helyes szekcióban, publikáltnak jelölés — mind hibátlan. |
| 8 | Video Audit bővítés | ✅ Kész (2026-07-09) — "Channel Audit előkészítés", nem teljes Channel Audit (az OAuth/saját-csatorna-analytics Phase 3-as) | `lib/channel-audit.ts` (`computeDimensionAverages`/`findWeakestDimension`/`computePublishRhythm` — mind backend-számolt, valós `video_audits.final_scores` adatból, nem AI-becslés). `app/api/channel-audit/route.ts`: GET kredit nélkül aggregál (min. 3 audit kell), POST kredit-köteles (2) AI "következő 10 videó" javaslat a valós erős/gyenge témák + leggyengébb dimenzió alapján. `app/dashboard/channel-audit/page.tsx`. Élőben tesztelve valós adaton (4 audit): dimenzió-átlagok helyesen (engagement_quality=28 a leggyengébb), top/bottom auditok helyesen rangsorolva, publikálási ritmus helyesen csoportosítva, 10 konkrét, indokolt témajavaslat generálva. |
| 9 | Trend Alerts | ✅ Kész (2026-07-09) | `lib/trend-alerts.ts` (`classifyAlerts` — a mar meglevo `trend_status`/`views_delta` snapshot-adatra epul, nincs uj AI/YouTube hivas, nincs kredit; `buildAlertSignature` napi+allapot-alapu, hogy ismetlodo riasztas ne jelenjen meg ujra elutasitas utan, de allapotvaltasnal igen). `app/api/trend-alerts` GET/POST (dismiss → `trend_alert_dismissals`, 023-as migracio). `app/dashboard/trend-alerts/page.tsx`. Élőben tesztelve valós adaton: 1 valódi riasztás talalva ("15 Facts About The Human Body!", +81 056 megtekintés), elutasítás után eltűnik a listából. |
| 10 | Content Gap Finder | ✅ Kész (2026-07-09) | `lib/content-gap.ts` — a "rés" 2 VALÓS jelforrás összevetéséből: mi már létezik a YouTube-on (`fetchSeedVideoStats`, megosztva a Keyword Research-sel), és mire van tényleges kereslet (`fetchKeywordSignals` — Serper relatedSearches/peopleAlsoAsk). Az AI csak ezt a két valós halmazt veti össze, nem talál ki keresletet. `app/api/content-gap/route.ts`, `app/dashboard/content-gap/page.tsx`. 2 kredit. Élőben tesztelve: 25 létező videó elemezve, 8 konkrét, valós adatra hivatkozó rés-javaslat, 2 kredit levonva pontosan (47→45), mentés+cache-hit működik. |

## PHASE 3 — MÉG SEMMI NINCS ELKEZDVE

English UI, Stripe globális pricing, YouTube OAuth (saját csatorna analytics), Analytics dashboard, Channel Audit, AI Coach, Team/Agency workspace, PDF report export, böngésző-extension, multi-platform intelligence. Ez a fázis ezen a ponton még nem is várt el semmit.

---

## MÁS, A TERVBEN EXPLICIT KÉRT, DE MÉG HIÁNYZÓ DOLGOK

- **Automatizált tesztek**: a terv kér egy alap teszt-csomagot (kredit levonás, paid result mentés/újranyitás, input hash dedup, Video Idea CRUD/státuszváltás, proof signal mentés, language/market/platform mezők, AI provider választás, API hibakezelés). **Ez nem létezik** — minden idei ellenőrzés kézi, élő böngészős teszt volt, nem egy megmaradó, ismételhető teszt-csomag.
- **Napi soft limit kikényszerítés fizető userekre**: a `CLAUDE_HANDOVER.md` már korábban is jelezte, még mindig nyitott — csak a free-tier userekre van hard limit (`lib/usage-protection.ts`), fizetőkre nincs napi plafon.
- **Prompt Template rendszer**: a promptok még mindig kódba égetve vannak minden route-ban, nincs `prompt_templates` tábla, nincs verziózás/lokalizáció.

---

## NYITOTT DÖNTÉSEK / KÜLSŐ FÜGGŐSÉGEK (nem tisztán kódolási kérdés)

1. **YouTube Data API kvótanövelési kérelem** — a user beadta-e a `support.google.com/youtube/contact/yt_api_form` űrlapot? **Nem tudjuk a jelenlegi státuszát.** Ez most sürgetőbb, mint korábban — a Phase 2 modulok (Competitor Tracker, Content Gap Finder, Keyword Research) mind extra YouTube-hívásokat vezettek be.
2. **Egyéni vállalkozás regisztráció** — blokkolja a `/privacy`/`/terms` placeholder véglegesítését és a tényleges pénzbeszedést. **Státusza ismeretlen.**
3. **Stripe multi-currency setup** — a Phase 1 #11 teljes lezárásához a usernek kell létrehoznia a nem-HUF Stripe termékeket/árakat a Stripe dashboardon.
4. **47 lokális commit még nincs push-olva** a `origin/main`-re (2026-07-09 végén) — a user tudatosan nem kérte a push-t. Push előtt érdemes még egyszer átgondolni a Stripe webhook változást (billing-kritikus), mielőtt éles forgalomba kerül (ha a Vercel a `main`-ről auto-deployol).
5. **Párhuzamos Codex-munkamenet** — a user időnként egyszerre dolgozik Claude Code-dal és ChatGPT Codex-szel ugyanezen a repón (ld. [[feedback-parallel-ai-tools]] memória). Session elején mindig ellenőrizd a `git status`-t/`git log`-ot váratlan, nem saját commitokért/módosításokért, mielőtt bármit felülírnál.

---

## ⏳ KÖVETKEZŐ SESSION — ITT FOLYTASD

A user saját 6 lépéses launch-terve: **1. feature freeze → 2. launch readiness audit → 3. 30–50 valós témás teszt → 4. 5–10 külső béta user → 5. hibajavítás → 6. fizetős pilot.**

Állapot:
1. ✅ Feature freeze — tart, nem épült új modul a Phase 2 lezárása óta.
2. ✅ Launch Readiness Audit — lezárva (13 szempont, ld. fent).
3. ✅ **30–50 valós témás teszt — LEZÁRVA (ld. "30-50 TÉMÁS TESZT LEZÁRVA" szakasz fent).** P0/P1 javítások force_refresh-sel megerősítve élőben, 18 új témával bővítve az összlétszám 50+ fölé ment.
3.5. ✅ **Beta Hardening Test (user külön kérésére, a 4. lépés előtt) — LEZÁRVA, PASS WITH ISSUES (ld. "2026-07-11 — BETA HARDENING TEST" szakasz fent).** 100 témás tartalomteszt + kredit/paid-result stressz + edge case + mobil + security. 2 új Kritikus hiba (dupla kredit két böngészőfülnél, nyers DB-hiba szivárgás 10 route-ban), a Title Studio JSON-hiba gyökéroka most pontosan azonosítva (~4%-os gyakoriság, nem-escapelt idézőjel, nem a téma hossza). **Egyik talált hiba sem enged illetéktelen hozzáférést más userhez** — javítás javasolt a fizetős pilot előtt, de nem blokkolja a béta usereket.
4. ⏳ **5–10 külső béta user — KÖVETKEZŐ LÉPÉS.** Ez már nem kódolási feladat — a userre vár (kiket kér fel, hogyan oszt hozzáférést). Érdemes eldönteni: a Beta Hardening Test 2 Kritikus tétele (dupla kredit, hibaszivárgás) menjen-e javításra MIELŐTT a béta userek bejönnek, vagy párhuzamosan futhat.
5-6. Nem esedékes, amíg a 4. lépés nem indul el.

**Mielőtt a 4. lépéssel foglalkoznál**: nézd meg a "2026-07-11 — BETA HARDENING TEST" szakaszt fent (javasolt javítások táblázata), és a "30-50 TÉMÁS TESZT LEZÁRVA" / "30 TÉMÁS TESZT + MINŐSÉGI STABILIZÁLÁS" szakaszokat a korábbi javított hibákért.

---

## PHASE 3 — MÉG NEM ESEDÉKES

A user jóváhagyott sorrendje szerint (**"haladjunk sorban, Phase 1, Phase 2, Phase 3"**) Phase 3 csak a fenti 6 lépéses launch-terv (audit → téma-teszt → béta → hibajavítás → pilot) lezárása UTÁN esedékes — ne kezdj bele addig, amíg a user explicit nem kéri.

- ✅ **Phase 1** — lezárva (10/12 kész, #3 nav-szerkezet és #11 multi-currency külső függőségre vár, ld. fent).
- ✅ **Phase 2** — mind a 10 modul kész, élőben tesztelve (2026-07-09).
- ⏳ **Phase 3** — 10 tétel (English UI, Stripe globális pricing, YouTube OAuth, Analytics dashboard, teljes Channel Audit, AI Coach, Team/Agency workspace, PDF export, böngésző-extension, multi-platform intelligence). Egyik sem indult el — ez most nem esedékes, a launch-terv 3-6. lépése van soron.

**Mielőtt Phase 3-at elkezdenéd**: érdemes megkérdezni a usert, melyik tétellel kezdjünk (a YouTube OAuth tűnik a legértékesebbnek, mert az nyitná meg a valós Channel Audit-ot és Analytics dashboardot is — de ez Google OAuth app-review-t is igényelhet, ami időigényes, külső függőség, hasonlóan a YouTube API kvótakéréshez).

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
