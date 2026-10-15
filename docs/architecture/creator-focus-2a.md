# Creator Focus 2A — eredet-jelölt fókuszprofil és konzervatív illeszkedés

Státusz: **draft PR (#12), nem integrált** csomag (Creator Intelligence 2A). Tiszta modul (`lib/creator-focus/`),
DB-mentes tesztekkel; **semmi nem importálja**, nem működő Creator Intelligence felület. **Nincs** migráció, API,
UI, új AI-hívás vagy kreditművelet, és **nem tárol tartós megerősítést vagy korrekciót**.

## Mi ez, és mi nem

- Egy `profiles` sorból **állításokat** (claim) épít, mindegyiken explicit **eredettel** (`origin`), hogy egy
  rendszerjavaslat sose váljon észrevétlenül tényállítássá.
- Egy témáról konzervatív, determinisztikus, forrásra visszavezethető **illeszkedési** (`fits` / `partial` /
  `does_not_fit` / `unknown`) és egy (mindig `unknown`) lane-jelzést ad.
- **Nem** állít közönségpreferenciát, retentiont vagy várható teljesítményt, és nem használja a validálatlan
  Editing Pattern metrikát, retention-becslést vagy stílusklasztert. A kimenet `limitations` listája ezt kimondja.
- A tiszta függvények nem olvasnak adatbázist, hálózatot, fájlrendszert, környezeti változót, órát vagy véletlent
  (lásd: `tests/creator-focus-purity.test.ts`).

## Fájlok

| Fájl | Szerep |
|---|---|
| `lib/creator-focus/contract.ts` | verziózott (`creator-focus.v1`) típusok, korlátok, `FIT_LIMITATIONS` |
| `lib/creator-focus/profile-adapter.ts` | `profiles` sor → `FocusProfile`; **eredet-szabálytábla** |
| `lib/creator-focus/transitions.ts` | explicit, **nem tartós** állapotátmenetek |
| `lib/creator-focus/eligibility.ts` | az egyetlen szabály, ami eldönti, mi használható ténynek |
| `lib/creator-focus/profile-validate.ts` | érkező profil szigorú szerkezeti és konzisztencia-ellenőrzése |
| `lib/creator-focus/fit.ts` | `assessFocusFit` (illeszkedés; a lane mindig `unknown`) |
| `lib/creator-focus/text.ts` | szövegsegédek (a meglévő `niche-relevance` tokenizálóra épít) |
| `tests/creator-focus-{adapter,transitions,fit,fit-defense,purity}.test.ts`, `tests/support/creator-focus-fixtures.ts` | 146 DB-mentes teszt |

## Íróaudit: minden felhasznált `profiles` mezőnél

A repóban **ismert** írók (forrás: kódolvasás). Az adatbázis-oldali író, amit találtam, az `auth.users` triggere,
ami csak a `user_id`-t tölti (migráció `001`, `handle_new_user`).

**A lista teljességét ez a csomag nem bizonyítja.** `tests/creator-focus-adapter.test.ts` egy korlátozott
**forrás-sentinel**: szövegkeresés az `app/`, `lib/`, `components/` TypeScript fájljaiban. Két szintje van:
(1) közvetlenül `from('profiles')`-ra láncolt `update/upsert/insert/delete`; (2) olyan fájl, ami a `profiles`
táblára hivatkozik **és** bárhol tartalmaz írást (ez fogja meg a változóra bontott lekérdezést is; a kézzel átnézett
nem-író fájlok külön listán vannak). Negatív kontrollok rögzítik, mit lát és mit nem.

A sentinel **nem látja** (a tesztben is rögzítve, „BLIND” kontrollokkal):
- táblanév-konstanssal vagy argumentummal hívott írót (`.from(TABLE)`), számított táblanevet;
- egy fájlban épített, másikban végrehajtott lekérdezést;
- `.rpc(...)` hívást, SQL-függvényt vagy triggert (csak a `handle_new_user` ismert);
- nyers SQL-t, a Supabase konzolt, más repókat, a `scripts/` és `e2e/` fixture-öket, JavaScript fájlokat;
- régebbi vagy más alkalmazásverzió által korábban írt sorokat.

A sentinel tehát egy új, ismert alakú író megjelenésekor jelez, hogy az eredet-szabályt újra át kell nézni; nem
állítja, hogy más író nem létezik.

| Írási pont | Mit ír | Ki indítja |
|---|---|---|
| `app/api/profile/route.ts:45` | engedélyezett mezők: `niche`, `main_category`, `specific_focus`, `audience`, `avoid_topics`, `channel_usage_mode`, `selected_main_niche` stb. | a bejelentkezett felhasználó (űrlapmentés) |
| `app/api/youtube/confirm-channel/route.ts:31` | `channel_usage_mode` (a kérés törzséből) | felhasználó |
| `app/api/youtube/resolve-niche-review/route.ts:31, 61` | `niche_validated_for_channel_id`, `niche_needs_review=false`; `select_candidate` esetén `niche`, `main_category`, `specific_focus` a **tárolt rendszerjavaslatból** | felhasználó (explicit kattintás) |
| `app/api/youtube/discover-niche/route.ts:61, 101` | `detected_niche_candidates`, `niche_confidence` | rendszer (AI), service role |
| `app/api/youtube/resolve-mismatch/route.ts:52, 64` | `channel_connection_type`, `active_channel_id`, `niche_needs_review=true` | felhasználó döntése + rendszer |
| `lib/channel-profile-sync.ts:90, 108, 157` | csatorna-megjelenítő mezők, `channel_connection_type`, `active_channel_id`, `niche_needs_review=true` | rendszer (YouTube-szinkron) |

### Mező-szintű eredet (a modul szabálya)

| Mező | Eredmény | Indok |
|---|---|---|
| `audience`, `avoid_topics` | `user_declared` | csak az űrlapmentés írja |
| `specific_focus`, `main_category` — **nem egyezik tárolt javaslattal** | `user_declared` | csak felhasználó-indított írók |
| `specific_focus`, `main_category` — egyezik az **aktív csatorna** javaslatával (a jelölővel vagy anélkül) | `unknown`, `channel_derived` | a sor nem bizonyítja, hogy a javaslatot a felhasználó fogadta el (lásd lent) |
| egyezés **másik / ismeretlen csatorna** javaslatával | `unknown`, `channel_derived` | a csatornához kötött állítás nem hordozható át |
| `user_confirmed` | **sorból sosem** | csak a memóriabeli `confirmSuggestion` átmenet állítja elő |
| `channel_usage_mode` ≠ `manual` | `user_declared` | felhasználó-indított írók |
| `channel_usage_mode` = `manual` | `unknown` | ez az adatbázis `NOT NULL DEFAULT` értéke is: alapérték ≠ nyilatkozat |
| `main_category` = `other` | `unknown` | az űrlap induló értéke is |
| `niche` | **figyelmen kívül** | legacy formátum (a kategóriacímke is beleíródhatott); a `specific_focus` a forrás |
| `selected_main_niche`, `primary_creator_lane` | **figyelmen kívül** | nincs repón belüli író: az eredet nem bizonyítható |
| `detected_niche_candidates` | `system_suggested` (külön lista) | soha nem állítás; a modell önbizalma és az indoklás szövege nem kerül át |

### A `niche_validated_for_channel_id` jelölő pontosan mit bizonyít

**Csak azt, hogy a felhasználó valamikor döntött a niche-ről az adott csatornára vonatkozóan**, nem azt, hogy egy
konkrét javaslatot elfogadott:

- a `resolve-niche-review` **mindkét** ága beállítja (`keep_current`: `route.ts:31`, az érték érintetlen;
  `select_candidate`: `route.ts:61`, az érték a tárolt javaslatból);
- a `POST /api/profile` mentés a fókuszt a jelölő törlése nélkül módosíthatja (a jelölő nincs az engedélyezett
  mezők között), tehát a jelölő és az érték **külön időpontban, külön okból** íródhat.

Ezért a javaslattal egyező érték a jelölővel együtt is `unknown` (`channel_derived`), és az okok között a
`validation_marker_proves_a_channel_level_decision_only` szerepel. Egy `keep_current` után hagyott, a javaslattal
véletlenül egyező saját érték és egy `select_candidate` után kapott sor **megkülönböztethetetlen** (a teszt
rögzíti). A jelölő a csatorna-szintű `needs_review` predikátumban továbbra is számít, de **claim eredetet nem ad**.

Tesztelt sorállapotok: `select_candidate`, `keep_current` (egyező és nem egyező érték), későbbi profilmentés
(a jelölő megmarad, az érték változik), egy másik javaslat-szöveg kézzel beírva, és a javaslatlista frissülése.

**Fontos korlát az „user_declared” jelentésén:** az eredet azt jelzi, *ki döntött az állítás tartásáról* (a
felhasználó-indított írók bizonyítottak), **nem** azt, hogy a szavakat ki írta. Ha a javaslat-lista azóta frissült,
vagy a felhasználó később átírta a fókuszt, egy korábban elfogadott AI-javaslat szövege már nem egyezik semmivel,
és `user_declared`-nek látszik. Ez a sorból nem különböztethető meg (a teszt „KNOWN LIMIT” esete); ld.
„Nyitott állítások”.

## Állapotátmenetek — NEM TARTÓSAK

`confirmSuggestion`, `declareOrCorrectClaim`, `dismissSuggestion`: tiszta függvények, új objektumot adnak, a
bemenetet nem módosítják. Az **előzmény (`history`) csak a függvény bemenetében/kimenetében létezik**: nem kerül
sem adatbázisba, sem gyorsítótárba, sem fájlba. Újraindítás után, vagy ha a profilsort újra beolvassuk az
adapterrel, a megerősítés, a korrekció és az előzmény **nincs meg** (`tests/creator-focus-transitions.test.ts`,
„the history is NOT durable”). A tartós tárolás külön, még el nem döntött lépés.

- A rendszerjavaslat **csak** a `confirmSuggestion` explicit hívásával válik `user_confirmed` állítássá; semmi más
  nem léptet elő javaslatot, és `user_confirmed` egy adatbázissorból soha nem olvasható ki.
- Bizonytalan csatorna-kontextusban (`niche_needs_review` vagy `mismatch`) a megerősítést a modul **elutasítja**
  (`channel_context_uncertain`): azt a meglévő `resolve-niche-review` folyamat végzi, ami a perzisztens állapotot is
  törli.
- Korrekció: a régi érték és eredet az előzmény-bejegyzésben marad; az új állítás a felhasználó saját szava,
  ezért nem csatorna-eredetű, és bizonytalan csatorna-kontextusban is tény marad.

## Csatorna-eltérés és `needs_review`: pontosan mi válik bizonytalanná

Csak a **csatornából származó** állítások (`channel_derived`): a javaslat-egyezésű fókusz/kategória (a sorból
ezek `unknown` eredetűek, ezért tényként amúgy sem szolgálnak) és a memóriában megerősített javaslat
(`user_confirmed`, amely bizonytalan kontextusban megszűnik ténynek lenni). A felhasználó
saját, önálló állításai (`audience`, `avoid_topics`, `channel_usage_mode`, egy javaslatot nem másoló fókusz)
**megmaradnak ténynek**. A modul a meglévő termékpredikátumot használja újra
(`isNicheReviewRequired`, `candidatesForActiveChannel`), így nem alakul ki második, eltérő definíció. A
figyelmeztetés (`niche_review_pending`, `channel_mismatch`, `channel_derived_claims_unreliable`) a kimenetben
külön látszik.

## Illeszkedés és lane — szabályok (az első érvényes dönt)

1. hibás **vagy inkonzisztens** bemenet → `unknown` (`invalid_input`; ismeretlen kulcsot, rossz verziót,
   inkonzisztens profilt elutasít, nem dob kivételt; részletek: „A bemeneti profil nem megbízható”)
2. felhasználó által megadott `stats_only` mód → `unknown` (`stats_only_mode`): a termékszabály szerint ebben a
   módban a profil-niche nem hajthat semmit
3. a téma túl rövid → `unknown` (`topic_too_short`)
4. `avoid_topics` találat **és** fókusz-találat együtt → `unknown` (`conflicting_claims`)
5. `avoid_topics` találat → `does_not_fit` (**csak** felhasználó által megadott kizárás mondhat „nem”-et)
6. nincs ténynek használható fókusz → `unknown` (`no_eligible_focus`, okkal)
7. nincs szóegyezés → `unknown` (`no_lexical_overlap`): a közös szavak hiánya **nem bizonyíték** az
   illeszkedés hiányára
8. ≥ 2 fókusz-szó egyezik → `fits`; pontosan 1 → `partial`

Az egyezés a meglévő relevancia-kapu szabályát követi (pontos szó, vagy ≥ 5 karakteres közös prefix).
**A `calculateNicheFit` nincs átemelve:** szemantikus szótárat és *fuzzy* tartalék-egyezést (`hasFallbackFuzzyMatch`)
használ, 0–100 pontszámot ad, ami nem auditálható igen/részben/nem/nem-tudjuk döntés.

**Lane-javaslat: a 2A-ban mindig `unknown`.** A `topic.linked_signal_cluster_id` a hívó által adott,
ellenőrizetlen string: a modul nem tudja, hogy létezik-e, a felhasználóé-e, zárolt `evidence_led` ideához tartozik-e
(a séma CHECK-je, migráció `067`, ezt csak zárolt sorra engedi). Ezért a kimenetben
`lane_suggestion = { value: 'unknown', reasons, unverified_link }`, ahol az `unverified_link` legfeljebb a kapott
azonosító visszaadása `status: 'unverified'` jelzéssel; **nem bizonyíték**, és sem a státuszt, sem semmi mást nem
változtat (üres profilnál, `stats_only` módban, túl rövid témánál és ellentmondó állításoknál is ugyanígy).
Érvénytelen bemenetnél az azonosító sem kerül vissza. `evidence_led` javaslathoz később **hitelesített
kapcsolat** (a szerver oldali, a felhasználóhoz kötött `video_ideas` sor) és **külön döntés** kell; az
`entertainment_led` a profilból vagy a kategóriából sosem következtethető ki (a repó egyetlen dokumentuma sem
definiálja a lane-eket kategóriák alapján, és a `primary_creator_lane`-nek nincs írója). A javaslat sosem ír vagy
zár lane-t.

## A bemeneti profil nem megbízható

Az `assessFocusFit` nem fogadja el tekintélyként a profilban érkező `fact_eligible` jelzőt:

- `profile-validate.ts` szigorúan validálja a teljes profilt (kulcsok, típusok, hosszok, értéktartományok,
  `claims` kulcs = `field`, a javaslatok az aktív csatornához tartoznak, `persistence: 'none'`, előzmény
  `persisted: false`), és ellenőrzi a **konzisztenciát**: a jelzőnek pontosan az `eligibility.ts` szabályának kell
  megfelelnie (`origin` ∈ {user_declared, user_confirmed, user_corrected} **és** nem csatorna-eredetű bizonytalan
  csatorna-kontextusban); `system_suggested` nem lehet állítás; `user_confirmed` csatorna-eredetű, a saját szó
  (`user_declared` / `user_corrected`) nem az; `context_uncertain` = `niche_review_required` ∨ `mismatch`;
  `mismatch` = (`connection` = `mismatch`).
- Inkonzisztens profil **egészben** elutasításra kerül (`unknown` / `invalid_input`, az okok az `issues`
  listában). Egy érvényes jelző sem érvényesül „magától”: a tényként használhatóságot a fit a claim eredetéből
  és a csatorna-kontextusból **újraszámolja** (`isFactEligible`); erre külön, a validátort kikapcsoló
  védelmi-mélységi teszt van (`creator-focus-fit-defense.test.ts`).

**Amit egy tiszta modul nem tud:** hitelesíteni, hogy egy `origin` tényleg igaz-e, azaz hogy a felhasználó
valóban megadta vagy megerősítette-e az állítást. Egy tökéletesen konzisztens, kézzel épített `user_declared`
claim megkülönböztethetetlen az adapter által készítettől (a teszt ezt kimondja és rögzíti). Az `origin` annak
állítása, aki a profilt összeállította (az adapter a termék felhasználó-indított íróival írt sorokból); valódi
hitelesítéséhez hitelesített, tartós rekord kell (P1). A kimenet `limitations` listája ezt mindig kimondja
(`claim_origin_is_asserted_by_the_caller_and_not_authenticated`).

## Meglévő termékkockázat (nem módosítva, az új modulba NEM került át)

`app/api/opportunity/route.ts:244-248`: `discovery_random` keresésnél, `niche_discovery` módban és
`use_channel_signals` mellett a `candidates[0]` (a legjobb AI-javaslat) **felhasználói jóváhagyás nélkül** kerül a
keresési `main_category` / `specific_focus` / `niche` mezőkbe. Ebben a csomagban ez változatlan. Az új modul sehol
nem használ `candidates[0]`-t; ezt `tests/creator-focus-purity.test.ts` forrásszinten őrzi.

## Tesztek (146)

| Terület | Fájl |
|---|---|
| eredetkezelés (táblázatos), javaslat ≠ tény, a jelölő csak csatorna-szintű (keep_current / select_candidate / későbbi mentés / lista-frissülés), csatorna-eltérés, hibás sorok, forrás-sentinel negatív kontrollokkal | `creator-focus-adapter.test.ts` |
| megerősítés/korrekció/elvetés, nem tartós előzmény, determinisztikusság | `creator-focus-transitions.test.ts` |
| fits/partial/does_not_fit/unknown, unknown elsőbbsége, lane mindig unknown (cluster ID mellett is), kézzel épített / hamisított profilok elutasítása, tiltott mezők hiánya, hibás bemenet | `creator-focus-fit.test.ts` |
| a validátor kikapcsolva sem fogad el `fact_eligible` jelzőt tekintélyként | `creator-focus-fit-defense.test.ts` |
| nincs import / hívás DB-re, hálózatra, AI-ra, kreditre, órára, véletlenre | `creator-focus-purity.test.ts` |

Futtatás: `node node_modules/vitest/vitest.mjs run tests/creator-focus-*.test.ts` — DB-mentes, nem indít helyi
Supabase-t.

## Nyitott döntések és állítások

- **P1** megerősítések/korrekciók tartós tárolása (migráció, megőrzési idő, ki láthatja/törölheti). A 2A nem tárol.
- **P2** a `candidates[0]` jóváhagyás nélküli használata (fent) megtartandó-e.
- **P3** lane-javaslat: hitelesített kapcsolat + külön döntés + UI és `explicit_user` megerősítési folyamat; a `primary_creator_lane` írója hiányzik.
- **P4** idea → publikált YouTube-videó kapcsolat (a tanulási hurok előfeltétele); ezért a tanulási hurok nincs a
  csomagban.
- Nyitott állítás: a `profiles` írók listája a **forrás-sentinelre és kódolvasásra** épül, nem teljes bizonyíték
  (lásd az íróaudit szakaszt); adatbázis-konzolon, régi alkalmazásverziókkal vagy más eszközzel írt sorokra nem
  vonatkozik. Éles sorokat nem vizsgáltam.
- Nyitott állítás: egy adatbázissorból **nem** olvasható ki, hogy a felhasználó elfogadott-e egy javaslatot; ehhez a
  P1 szerinti tartós, hitelesített rekord kell.
- Nyitott állítás: az `origin` hitelessége nem bizonyítható tiszta modulból (lásd fent); a konzisztencia-ellenőrzés csak az egyszerű hamisítást fogja meg.
- Nyitott állítás: lexikai egyezés nem szemantikus megértés; a magyar ragozásra csak a közös-prefix szabály nyújt
  közelítést.
