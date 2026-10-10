# Fizetős műveletek (D1/D2) — állapotmodell és három rögzített döntés

Státusz: **végrehajtható állapotmodell + szerződésteszt, nem migráció és nem DB-bizonyíték.** Semmi nem fut belőle éles úton: a modell a
`tests/support/paid-operations-state-model.ts` fájlban él (a vitest csak a `*.test.ts`-t futtatja, `app/` és `lib/` nem importálja). Minden DB-állítás
(advisory lock, a zár utáni READ COMMITTED újraolvasás, trigger, CHECK, függvény-jogosultság) itt **modellezett**, valódi PostgreSQL-en még nem
igazolt. **A katalógus-snapshotok szimuláltak:** a modell által épített snapshotok eredete `authored_in_test` vagy `derived_from_migrations`, egyik sem
`pg_catalog_query`, ezért az ezeken engedélyezett átvezetés bizonyítéka a modellben `simulated`, soha nem `database`. Egy forrás-teszt védi, hogy a
`pg_catalog_query` címkét a modellen és tesztjein kívül senki ne használja.

Tesztek: `tests/paid-operations-state-model.test.ts` (átmenetek, kötés, státusz, verseny-, összeomlás-, válaszvesztés-, zársorrend- és eszközszintű
szinkronizációs mátrix) és `tests/paid-operations-projection-legacy-cutover.test.ts` (a három döntés, a mezőosztályok, a katalógus-szabály és az
evidencia-címkék). Mindkettő DB-mentes és provider-mentes.

## 1. döntés — a `paid_results` vetület generációs oszlop nélkül lép előre

- **Nincs új oszlop** a `paid_results`-on. A vetület generációja a generációs táblából **származtatott**: a legnagyobb generáció. Ha még nincs generációs
  sor, egy `completed` legacy sor **implicit 1. generáció**, minden más (nincs sor, `failed` / `refreshed` / `archived`) 0 — ahogy az olvasók ma is
  csak a `completed` sort látják.
- **Csak a commit tranzakcióban léphet előre, pontosan +1-gyel**, a zárak és a `expected_generation` összevetés (CAS) után. Külön
  `WHERE generation < új` feltétel nem kell, mert a zár és a CAS együtt monoton: egy elavult író (`expected` kisebb) `generation_conflict`-ot kap, és a
  vetületet nem viheti vissza.
- **Integritás az összes generációhoz kötött mezőre:** a generációs sor a hordozott mezők teljes pillanatképét és annak digestjét tárolja. A vetület
  konzisztens, ha a `paid_results` sor `completed`, és **minden** hordozott mezője megegyezik a legnagyobb generáció pillanatképével (nem csak a
  `result_json`). Eltérés (kézi szerkesztés, az átállás előtti legacy író) esetén a commit **fail-closed**: `projection_diverged`, nincs levonás.
- **Copy-on-first-refresh:** az első generációs commit a régi sor **összes** hordozott mezőjét 1. generációként lemásolja, **mielőtt** a vetület a
  2.-ra lép. Tömeges backfill nincs. Egy **elutasított** commit semmit nem materializál.
- Nyitott: hogy a digest a DB-ben (`jsonb::text`) kanonikus-e, valódi DB-n igazolandó.

### 1b. A `paid_results` mezői: generációhoz kötött és szándékosan módosítható

A modell a **valódi 27 oszlopot** (019 + 021) pontosan egyszer sorolja be; a teszt az oszlopkészletet a migrációk SQL-jéből olvassa, így egy új oszlop
addig bukik, amíg nincs besorolva.

| Osztály | Mezők | Szabály átvezetett `tool_type`-on |
|---|---|---|
| **Azonosító** (5) | `id`, `user_id`, `tool_type`, `input_hash`, `created_at` | semmilyen írás nem változtathatja |
| **Generációhoz kötött / hordozott** (19) | `normalized_input`, `original_input`, `main_category`, `specific_focus`, `region`, `language`, `platform`, `result_json`, `summary_json`, `credit_cost`, `status`, `last_refreshed_at`, `fresh_until`, `source_run_id`, `provider`, `model`, `prompt_template_id`, `prompt_version`, `estimated_cost` | csak új generáción át (commit) változhat; legacy írás **azonos `result_json` mellett sem** módosíthatja egyiket sem |
| **Szándékosan módosítható** (3) | `updated_at`, `last_opened_at`, `linked_video_idea_id` | írható marad |

A módosítható mezők indoka **forrásból igazolt**: az app/lib kódban a `paid_results`-ot csak a `savePaidResult` upsert és az `openPaidResult`
`last_opened_at` frissítése írja (forrás-teszt őrzi: egy új író addig bukik, amíg nincs besorolva); a `linked_video_idea_id` az upsertben opcionális, és a
021 FK-ja (`ON DELETE SET NULL`) maga is UPDATE, amelyet egy védett-mező ellenőrzés elutasítana.

**A trigger szabálya** (modellezett, az OLD és a NEW sor alapján, identitás nélkül): törlés tiltott; az azonosítók nem változhatnak; az a UPDATE, amely
**nem** változtat hordozott mezőt, engedett (így a cache-találat `last_opened_at` frissítése és az FK-művelet működik); minden más írás csak akkor, ha a
NEW sor **minden** hordozott mezője egyezik a legnagyobb generáció pillanatképével. A szabály akkor is érvényes, ha a sor **volt** átvezetett
`tool_type`-on: egy UPDATE nem viheti ki a sort egy másik `tool_type` beírásával (ezt a modell tesztje találta meg: az első változat csak az új értéket
nézte).

## 2. döntés — a levonáshoz nem köthető legacy 1. generáció jelölése

- A materializált 1. generáció: `chargeLink = 'unlinked_legacy'`, `creditTransactionId = NULL`, `origin = 'legacy_backfill'`. A hozzá tartozó
  műveletsor `committed`, de **nincs mögötte levonás**, és a materializálás **nem ír ledger-sort**.
- A műveleti azonosítója a `paid_results.id`-ből **determinisztikusan** származik, **saját névtérben** (`legacyOperationId`), ezért ismételhető, és soha
  nem egyenlő egy tokenből származtatott azonosítóval. Egyszer jön létre.
- **Következmény:** üzleti jóváírás rá **nem adható** (`charge_not_linkable`), mert nincs levonás, amelyhez kötni lehetne.
- A levonáshoz nem köthető **legacy árva levonás** rendezése külön emberi döntés bizonytalanságban (`operator_credit_uncertain`, saját hivatkozás
  `opc:<spend>`, operátor és bizonyíték-lista kötelező, „uncertain” jelölés). Nincs automatikus hívója, és **nem változtat** eredményen, generáción vagy
  vetületen: egy későbbi legacy mentés továbbra is lehetséges (csak a jelentés mutathatja). A `credit_refund` és ez **kölcsönösen kizárja egymást**
  ugyanarra a levonásra — ez a meglévő `refund_credit_spend` módosítását igényli (D-d).

## 3. döntés — a régi írók kizárása átvezetett `tool_type`-nál, hívó-azonosság nélkül

**Javított állítás.** Az első változat azt állította, hogy egy `current_user`-ellenőrzés (a commit tulajdonosa) kizárja a közvetlen hívókat. Ez
**téves**: a `spend_credits` maga `SECURITY DEFINER` (`037_credit_buckets.sql:256`, tulajdonos `postgres`, EXECUTE csak `postgres` és `service_role`,
`090:159`), ezért benne a `current_user` **minden** hívónál a tulajdonos — a commit függvénynél is. Függvényen belül a hívó nem látszik, így a modell
semmilyen kerítést nem épít hívó-azonosságra.

**A) `paid_results`: adat-invariáns, minden íróra egyformán** (az 1b szabálya). A commit azért megy át, mert előbb beszúrja a generációs sort; a legacy
upsert csak akkor, ha **minden** hordozott mezőben azonos a pillanatképpel (no-op). A valódi `savePaidResult` hívás alakja (azonos `result_json`, de
alapértelmezett `summary_json`, `credit_cost`, friss `last_refreshed_at`) elutasított. A csak legacy sort tartalmazó sor is védett.

**B) `spend_credits`: hívótól független wrapper + jogosultsággal védett core.**
- A `spend_credits` megtartja az aláírását `(uuid, numeric, text, text, jsonb)` és a viselkedését az át nem vezetett funkciókra; az átvezetett funkciót
  és a fenntartott **`gop:`** hivatkozás-névteret (a D1/D2 levonásoké; az `op:` a 093-é marad, érintetlenül) **minden hívónak** elutasítja. A döntése csak az argumentumoktól és a regisztertől függ.
- A jelenlegi törzs átkerül a `spend_credits_core`-ba, amelyre **a `service_role`-nak nincs EXECUTE joga**. Csak a `SECURITY DEFINER` commit függvény
  éri el.
- **Jogosultsággal ellenőrizhető szabályok** (`checkSpendFenceCatalog`; valódi DB-n a `pg_proc.proacl` / `has_function_privilege` és a
  `pg_auth_members` adná a snapshotot): (1) a core-t senki nem hívhatja a tulajdonosán kívül; (2) a wrapper marad hívható a `service_role`-nak, és zárt
  az anon, authenticated, PUBLIC felé; (3) a commit függvény `SECURITY DEFINER`, és csak a `service_role` hívhatja; (4) a commit tulajdonosa eléri a
  core-t; (5) egyetlen kérés-szerepkör sem válhat a core tulajdonosává, tagsági láncon át sem.
- **Elvetett alternatívák:** a `current_user`-ellenőrzés a `spend_credits`-ben (hatástalan); a `spend_credits` EXECUTE jogának elvétele a
  `service_role`-tól (a legacy hívókat — a 17 `chargeFeature` hívási hely és a `chargeProtectedFeature` — eltörné); tranzakció-lokális GUC jelölő
  (közvetlen DB-kapcsolattal hamisítható, nem jogosultsággal ellenőrizhető).
- **Ha a split nem fogadható el:** marad a statikus hívóhely-leltár, amely a közvetlen hívókat **nem zárja ki** — ekkor az átvezetésre nem szabad
  atomikus garanciát állítani.

**C) A commit és a visszalépés ugyanazon eszközszintű szinkronizáción belül dönt.**
- A **zársorrend rögzített: eszköz (`tool`) → művelet (`op`) → hatókör (`scope`)**. A commit mindhármat veszi ebben a sorrendben, a `rollbackCutover` és
  az `enableCutover` az eszköz-zárat, a seal az `op` és `scope` zárat, az üzleti jóváírás az `op` zárat; a státusz nem vesz zárat.
- **Zármódok (pontosítás, a felhasználói felvetés nyomán):** az eszköz-zár **megosztott** (`pg_advisory_xact_lock_shared`) minden commitnál, importnál és (kvótás) ingyenes commitnál, és
  **kizárólagos** csak az `enableCutover` / `rollbackCutover` alatt. A PostgreSQL-dokumentáció szerint „a shared lock does not conflict with other shared locks”, csak a kizárólagossal, ezért
  **egyetlen globális eszköz-zár sem sorosítja a felhasználók commitjait és ingyenes kéréseit**, miközben a commit és a visszalépés kölcsönös kizárása megmarad: a visszalépés a kizárólagos zárra
  vár, amíg a futó commitok véget nem érnek, és utána látja a commitolt generációkat; az utána induló commit megvárja a visszalépést, és a zár után olvassa újra a regisztert. A modell ma egyetlen,
  módtalan eszköz-zárat ír le (a `paid_results` invariáns-trigger (B2) a regiszter olvasása előtt szintén megosztott eszköz- és hatókör-zárat szerez: lásd *A visszaengedés az előzetes import után*); a mód-bontás (megosztott / kizárólagos) a következő kódlépés (a holtpont-szimulátort is bővíteni kell megosztott zárral).
- **Minden döntés a zár után születik:** a commit az átvezetési állapotot (`tool_not_cutover`) az eszköz-zár után olvassa, a visszalépés pedig a
  commitolt generációkat az eszköz-zár után. A tesztek a „már elindult” hívást is modellezik (a hívás elindult, de még nem zárolt, és közben a másik
  fut): a már elindult commit a visszalépés után `tool_not_cutover`-t kap (nincs levonás, generáció, vetület), a már elindult visszalépés pedig a
  közben commitolt generáció miatt `atomic_generation_exists`-szel elutasított. Mindkét soros sorrend és minden permutáció is ellenőrzött; egy
  invariáns kizárja, hogy átvezetetlen eszközön levonáshoz kötött generáció maradjon.
- **A zársorrend őre:** `assertLockOrder` a rangot (tool < op < scope) kényszeríti; két negatív kontroll (op/scope megfordítva; op az eszköz-zár előtt)
  a szimulációban holtpontra fut, a valódi, rangsorolt sorozatok minden indítási sorrendben nem.

**Visszalépés (rollback).** Tiltott **bármely** commitolt, levonáshoz kötött atomikus generáció után — az 1. generáció után is. (A terv szerint ugyanez érvényes a commitolt **`free`** generációra is: a
legacy író visszakapcsolása azt is eltérítené; a modell ma még csak a `linked` generációt vizsgálja — a következő kódlépés tárgya.) Addig a pontig, amíg
nincs ilyen generáció (semmi nem commitolt, vagy csak lezáró tombstone van), a visszalépés megengedett. Utána az egyetlen irány előre: az eszköz
leállítása, a legacy író soha nem kapcsolható vissza.

**Amit ez NEM zár ki (dokumentált maradék):** az át **nem** vezetett `tool_type` semmilyen kerítést nem kap (`fenced:false`, mezővédelem sincs); a
wrapper csak a regiszterben szereplő funkciónevet ismeri, egy ismeretlen név nincs lefedve; az owner, a superuser és a közvetlen DB-kapcsolat, valamint a
trigger-megkerülő szerepkörök (`session_replication_role`) nem bizonyíthatóan kizártak.

## Válaszazonosító-szerződés — `generationId` és `paidResultId` két külön azonosító

**Forrásból igazolt kiindulás:** a meglévő újranyitási út a `paid_results.id`-t veszi: `GET ?paidResultId=` → `getPaidResultById(userId, id)` (csak a
tulajdonos, csak `completed` sor), a mentés-válasz `paid_result_id` mezője (`app/api/title-studio/route.ts:209`, `paidResultResponseMeta`) és a PATCH
`paid_result_id` mezője is ez. Az első modell `resultId` néven a **generációs sor** azonosítóját adta vissza, amelyet ez az út **nem talál meg** — ezért
a kétértelmű név megszűnt.

| Mező | Mi ez | Mire jó |
|---|---|---|
| `generationId` | a generációs sor azonosítója (ennek a műveletnek a saját, változatlan eredménye) | előzmény / audit; a meglévő újranyitási út **nem** fogadja el |
| `paidResultId` | a hatókör `paid_results` sorának azonosítója; **minden generációra ugyanaz**, és frissítés után is megmarad | a **meglévő újranyitási út** kulcsa (`paid_result_id`); a régi kliens által tartott érték érvényes marad |
| `paidResultGeneration` | melyik generációt adja most a `paidResultId` megnyitása (mindig a legnagyobbat) | egyezik a `generation`-nel, amíg a művelet generációja az aktuális; régebbi műveletnél az újabb |

- **Mindhárom válaszban** (siker, duplikátum, státusz) ugyanez a három mező szerepel; a `sealed`, `not_visible`, `rejected` válasz és az elutasított
  commit egyiket sem hordozza.
- **A válasz nem ad ki kulcsot — de ez NEM fail-closed újranyitás.** Ha a sor hiányzik, vagy nem a legnagyobb generáció tartalma (eltérés, vagy már
  nem `completed`), a `paidResultId` és a `paidResultGeneration` `null`; a `generationId` ilyenkor is jelen van. **Ennyit tesz, többet nem.** A mai
  `GET` (`getPaidResultById`) egy **korábban ismert** azonosítót továbbra is elfogad, és kiszolgálja a sor tartalmát: a mai út csak az azonosítót, a
  tulajdonost és a `completed` státuszt ellenőrzi, a sort **soha nem veti össze** a legnagyobb generációval. Egy eltért sort (kézi szerkesztés, az
  átállás előtti legacy író) így a korábban kapott azonosítóval **meg lehet nyitni**, és a megnyitás a legnagyobb generációt állítja, miközben a sor
  már nem azonos vele. **A teljes fail-closed újranyitás ezért külön, megvalósítandó kapu (G-REOPEN) — ma NEM működik** (lásd lent).
- **Újranyitási út:** a `paidResultId` a **meglévő** utat használja, és mindig az **aktuális** generációt adja. **Régebbi generációhoz nincs meglévő út**; a
  `generationId`-val olvasó előzmény-lekérdezés (`readGeneration`) **javasolt, ma nem létezik**, a modellben tulajdonos-ellenőrzött és csak olvas. Az
  UI (Codex) kizárólag a `paidResultId`-t használja, a `paid_result_id` válaszmező értéke változatlanul a `paid_results.id` marad.
- **Folytonosság:** az első generációs commit egy legacy sor fölött a **legacy sor azonosítóját** adja vissza `paidResultId`-ként, a materializált 1.
  generáció saját `generationId`-t kap.
- Tesztek: a két azonosító külön sorokon, siker / duplikátum / státusz útvonalra, frissítés előtt és után, régebbi művelet duplikátumára és
  státuszára, hiányzó / eltért / archivált sorra, idegen felhasználóra, ismeretlen azonosítóra; mindkét olvasás csak olvas.

### G-REOPEN — a teljes fail-closed újranyitás: megvalósítandó route-/DB-kapu, NEM működik

**Forrásból igazolt, hogy ma nincs:**
- A `getPaidResultById` (`lib/paid-results/paid-results-service.ts`) csak `.eq('id')`, `.eq('user_id')`, `.eq('status', 'completed')` szűrést tartalmaz, generációra,
  digestre vagy vetületre nem hivatkozik.
- **21 route-hívási helye** van (GET újranyitás, PATCH/POST azonosítóval, az `opportunity-*` tartalék-ága az azonosítóra, `video-packages`), mindegyik ugyanezt
  az utat használja.
- Ismert azonosítót a kliens háromféleképp szerezhet, és egyik sem megy át a válasz visszatartásán: egy korábbi válaszból (a `title-studio` oldal a
  `sessionStorage`-ban tartja, `page.tsx:72-79,149-150`), linkből (`?paidResultId=`, `page.tsx:60-62`), és a dashboard-összesítőből, amely az `id`-t is
  kiválasztja (`app/api/dashboard/summary/route.ts:44`).
- Az `app/` és `lib/` kódban nincs `G-REOPEN`, `projection_unverified` vagy generációs tábla-hozzáférés (forrás-teszt őrzi). A migrációkat ez a teszt nem
  vizsgálja, és a generációs tábla ma nem is létezik.

**Mit kellene tennie (két megvalósítási lehetőség, egyik sem épült meg):**
1. *Route-kapu:* a `getPaidResultById` után, kiszolgálás vagy módosítás előtt a sor hordozott mezőinek digestjét össze kell vetni a legnagyobb generációéval;
   eltérésnél elutasítás (pl. `projection_unverified`), nem tartalom-kiszolgálás.
2. *DB-kapu:* egy `STABLE` megnyitó függvény, amely csak a legnagyobb generációval azonos sort adja vissza; a route-ok a táblaolvasás helyett ezt hívják.
Mindkettő érinti a 21 hívási helyet, és a generációs táblára épül (tehát az átvezetett eszközökre értelmezett; a legacy-only sor definíció szerint konzisztens).

**Állapot a modellben:** `FAIL_CLOSED_REOPEN_GATE = { id: 'G-REOPEN', implemented: false }`; a `reopenPaidResult` a **mai** utat modellezi (nem
fail-closed), a `reopenPaidResultFailClosed` **javasolt, nem megvalósított**, csak a követelményt és az eltérést mutatja. A tesztek a mai viselkedést
**rögzítik** („KNOWN OPEN GAP”), nem azt állítják, hogy a kapu működik; ha a kapu megépül, ezeket a pineket tudatosan a pozitív párjukra kell cserélni.

**Döntés — D-g = igen (rögzítve 2026-10-05):** átvezetett `tool_type` esetén a G-REOPEN **az éles cutover előtt kötelező**. Következmény: a G-REOPEN
**cutover-blokkoló (B4)**; amíg nincs megvalósítva és valódi DB-n igazolva, semmilyen `tool_type` nem vezethető át élesen. A döntés rögzítése csak ez a
dokumentum; a modell `enableCutover`-ének B4-előfeltétele és a hozzá tartozó teszt még **nem** készült el (kód nem módosult). A megvalósítási terv a
2026-10-05-i munkamenetben készült, jóváhagyásra vár; ebbe a dokumentumba csak az elfogadott változata kerül.

**A 21 hívási hely leltára (forrásból, 2026-10-05).** Három, élesen különböző osztály:

| Osztály | Helyek | Mit tesz a lekért sorral | Hiba / null ma |
|---|---|---|---|
| **A — csak olvas, újranyitás (13)** | `content-gap:188`, `script-extract:268`, `transcript:218`, `title-studio:305`, `thumbnail-studio:228`, `viral-score:700`, `video-audit:432`, `video-package:363`, `keyword-research:183`, `channel-audit:27`, `opportunity-explain:138`, `opportunity-similar:139`, `seo-optimizer:197` (mind GET) | kiszolgálja a `result_json`-t; `openPaidResult` (`last_opened_at`) | a `null` 404 lesz |
| **B — módosít, a sor bizonyíték vagy forrás (3)** | `title-studio:253` (PATCH), `thumbnail-studio:185` (PATCH), `video-packages:55` (POST) | a sor tartalma igazolja, hogy a cím / koncepció a fizetett eredményé, majd `video_ideas`-ba, illetve `video_packages`-be ír | a `null` elutasítás (véletlenül fail-closed) |
| **C — töltésképes POST, cache-nyitás (5)** | `similar-videos:518`, `viral-score:286`, `opportunity-explain:36`, `opportunity-similar:36`, `opportunity:335` | azonosító szerinti, majd hash szerinti kereséssel újranyit; **a `null` ág nem tér vissza, a folyamat halad tovább a fizetős generálás és a levonás felé** (a teljes utat route-onként nem követtem végig) | a nyelt hiba `null`, tehát cache-hiány, tehát **új levonás kockázata** |

Megfigyelések: a `viral-score`, `video-audit`, `video-package`, `keyword-research`, `channel-audit`, `seo-optimizer` és `opportunity-*` GET-jei **nem ellenőrzik a
`tool_type`-ot**, tehát a kapunak a **sor saját** `tool_type`-jára kell döntenie, nem a route-éra. A **hash szerinti olvasás ugyanazt a rést hordozza**
(16 hely: 12 `getPaidResultByHash` és 4 `readPaidResultByHash`), ezért a kapu hatóköre csak vele együtt teljes (D-h).

#### A `not_found` / `unverified` határ (pontosítva, 2026-10-05)

`not_found` = „a rendszernek **nincs** commitolt eredménye erre a kulcsra” — a hívó a keresési úton **továbbmehet**, de ez **nem bizonyítja, hogy korábbi
levonás nem történt** (lásd lent). `unverified` = „a rendszernek **van**
commitolt eredménye, de nem szolgálható ki” — a hívó **megáll**, és soha nem vonhat le újra. Ezért ha commitolt generáció már létezik, a **hiányzó** vagy
**nem `completed` (archivált, failed, refreshed)** vetület **nem** `not_found`: különben egy töltésképes POST a már kifizetett eredményre újra levonna.

| Eszköz átvezetve | Commitolt generáció | Sor (azonosító / hash szerint) | Verdikt |
|---|---|---|---|
| nem | — | `completed` | `found` (passthrough, mint ma) |
| nem | — | hiányzik, vagy nem `completed` | `not_found` (mint ma) |
| igen | nincs | `completed` | `found` (`legacy_only`) |
| igen | nincs | hiányzik, vagy nem `completed` | `not_found` (a legacy viselkedés megmarad) |
| igen | van | `completed`, minden hordozott mező azonos a legnagyobb generációval | `found` (`verified_generation`) |
| igen | van | `completed`, de eltér | `unverified` |
| igen | van | **hiányzik** | `unverified` |
| igen | van | **létezik, de nem `completed`** (archived / failed / refreshed) | `unverified` |
| — | — | idegen felhasználó sora, ismeretlen azonosító | `not_found` (nincs létezés-szivárgás) |
| — | — | bármilyen olvasási hiba | `read_error` |

Következmények a tervre: (1) a generációs sor **tárolja a `paid_results.id`-t** (FK nélkül, hogy a sor törlése után is megmaradjon), így egy törölt sor ismert
azonosítója is a hatókörére oldódik és `unverified` lesz; (2) a hash szerinti kereséskor a hatókör a kérésből adott; (3) a lezáró tombstone (`sealed`)
**nem** commitolt generáció, nem számít; (4) a regiszter a **sor vagy a generáció** `tool_type`-ja alapján dönt, nem a route-éra. Külön tesztek: hiányzó
vetület + commitolt generáció (hash szerint és azonosító szerint), archivált vetület + commitolt generáció (azonosító és hash szerint; failed / refreshed
is), és az ellenpárok (generáció nélkül `not_found`; idegen felhasználó; csak tombstone). **A mostani modell-teszt ezzel ellentmond:** a javasolt kapura is
`not_found`-ot vár archivált sorra; a pontosított határ szerint generáció mellett `unverified`. A javítás a következő kódlépés, most nem módosult.

**A `not_found` NEM bizonyítja a korábbi levonás hiányát.** A verdikt csak azt mondja: a sikeres lekérdezés nem talált commitolt eredményt (legacy esetben
`completed` sort). Egy **levont, de el nem mentett** futás (mentési hiba, elveszett válasz, összeomlás a levonás és a mentés között) sem sort, sem generációt
nem hagy, a legacy ledger-sor pedig véletlen hivatkozású (`spend:<uuid>`), nincs kapcsolata az eredménnyel (D1/D2: „`absent` ≠ nincs korábbi levonás”). Ezért:
(1) a `not_found` eredmény **típusa nem hordozhat** „nincs levonás” állítást (nincs `noPriorCharge`-szerű mező, a hívó, a napló és a felhasználói szöveg sem
állíthatja); (2) a `not_found` utáni továbbhaladás a **legacy úton** a D1/D2 ismert maradéka marad (egy korábbi, el nem mentett levonás mellé új levonás
következhet), és **csak a tokenes atomikus út** zárja ki (egy művelet-azonosítóhoz legfeljebb egy levonás); (3) a „rendben” ítéletek a lenti C-táblában
kizárólag azt jelentik, hogy a **hiba és az `unverified` nem jut levonásig**, nem azt, hogy `not_found` után a levonás biztonságos.

#### A C osztály végigkövetése (forrásból, 5 route)

| Route | Keresés helye | Továbbhaladás `not_found` után | Levonásig vezető feltétel | Kapu után |
|---|---|---|---|---|
| `similar-videos` | a használat-ellenőrzés és a zár **előtt** | `getCachedSearch` (a hibát **nyeli**, hiba = hiány), `cache_only` visszatérés, `checkUsagePermission`, zár, YouTube-keresés | `chargeProtectedFeature` (`:781`) ha `usageCheck.cost > 0` és van valódi találat; **a nyelt keresési hiba ma idáig elér** | a kapu a gyorsítótárak előtt megáll; **F1:** a `getCachedSearch` hibájának is meg kell állítania a folyamatot |
| `viral-score` | zár után, `try/finally` | `getCachedViralScore` (**dob** hibára, a külső `catch` 500-at ad, levonás nincs), találatnál legacy `savePaidResult` backfill, `cache_only`, hozzáférés, AI | `chargeFeature` (`:525`) | rendben; **F2:** a backfill és a további írások (`:304`, `:386`, `:573`) legacy írók |
| `opportunity-explain` | zár után, `try/finally` | nincs más tartalék | hozzáférés → AI → `chargeFeature` (`:89`) | rendben |
| `opportunity-similar` | zár után, `try/finally` | nincs más tartalék | ugyanez (`:90`) | rendben |
| `opportunity` | zár után, `try/finally`; az azonosító-ág hiánya nem tér vissza | használat-ellenőrzés (`usage_blocked` / `needs_confirmation`, levonás nélkül), majd ingyenes heti keretes generálás | `chargeProtectedFeature` **csak** `force_refresh && validCount > 0` (`:956`), és a `force_refresh` **minden keresést kihagy** | levonásig **nem** vezet út keresésből; ingyenes heti keretes generálásig igen, ezt a kapu hibánál / `unverified`-nél megállítja |

Szabály: `read_error` és `unverified` **minden** route-on a keresés pontján tér vissza — a hozzáférés-ellenőrzés, az AI-hívás, a szolgáltatói hívás, a
gyorsítótárak és a levonás **előtt**; a zárat a `finally` felengedi (a `similar-videos`-ban a keresés a zár előtt van). Leletek: **F1** a `getCachedSearch`
nyelt hibája levonásig elérhet; **F2** a `viral-score` legacy írói a cutover után blokkolva lennének — **mindkettő az érintett eszköz kötelező cutover-kapuja**
(lásd az „Eszközönkénti kötelező cutover-kapuk” szakaszt); **F3** az `opportunity` azonosító szerinti `not_found` esete ma továbbhalad generálásra
(megmarad, de ha egy generáció hivatkozik az azonosítóra, az `unverified`). A legacy zár fail-open volta nem a G-REOPEN tárgya (a D1/D2 tokenes védelem fedi).

#### Eszközönkénti kötelező cutover-kapuk (F1 és F2)

Az F1 és az F2 **nem javaslat, hanem az érintett eszköz cutoverének kötelező kapuja**: az adott `tool_type` nem vezethető át, amíg a kapuja nincs teljesítve és
bizonyítva. A B1–B4 minden eszközre érvényes; ez ezen felül, eszközönként:

| Eszköz | Kötelező kapu | Mit kell teljesíteni | Bizonyíték |
|---|---|---|---|
| `similar_videos` | **F1** | (1) a `getCachedSearch` (a hibát nyeli) háromállapotú (`found` / `absent` / `read_error`, pozitív bizonyítékkal, soha nem dob és nem `null`), a route `read_error`-nál a használat-ellenőrzés, a zár, a keresés és a levonás **előtt** 503-mal tér vissza; (2) a **`found` legacy-cache találat sorsa meghatározott**: átvezetett eszközön generáció nélkül **közvetlenül nem szolgálható ki, és futásidőben sem importálható**: az átvezetés **előtti teljes importtal** lesz generáció (1. generáció, `unlinked_legacy`) — lásd az F1 szakaszt; (3) a régi írók kizárása és a **nulla maradékot igazoló végső census**; kimaradt sor → fail-closed megállás és kézi egyeztetés | route-teszt: `read_error` → nincs `checkUsagePermission`, zár, YouTube-hívás, levonás; import-, census- és „generáció nyer” tesztek (lásd lent); statikus teszt: nincs hibát hiányra képező olvasó a keresési úton |
| `viral_score` | **F2** | a három legacy író **generáció-tudó formában marad meg**, nem kikapcsolódik: fő fizetős eredmény → tokenes atomikus commit; ingyenes, kevés adatos eredmény → **`free` generáció**; legacy-cache backfill → **legacy-cache import** (lásd az F2 szakaszt). A megőrzés **eldöntött** (P-1, P-2; P-3 = (b)); egy út elvesztése csak **új, kifejezett termékdöntéssel** lehetséges | statikus leltár: nincs legacy `savePaidResult(` a `viral-score` útjában; `free` generáció-, import- és felülírás-tesztek (lásd lent); route-teszt: legacy-cache találatnál nincs legacy írási kísérlet |
| `similar_videos`, `opportunity_engine` | **F4 (eldöntött, kötelező kapu)** | ugyanaz az ingyenes út, mint a `viral_score`-nál: `similar_videos` ingyenes napi keret (`creditCost: 0`, `:831`), `opportunity_engine` ingyenes heti keret (`creditsCharged: 0`, `:1090`) — a `free` generáció nélkül ezek a mentések az átvezetés után elvesznének. **A (eszköz, ok) pár önmagában nem védi a keretet:** a jogosultság-ellenőrzés és a keret felhasználása **ugyanabban az atomikus DB-döntésben** történik (lásd az F4 szakaszt) | `free` generáció tesztek ezekre az eszközökre is; az F4 szakasz versenytesztjei |
| minden más | csak B1–B4 | a forrásból ellenőrzött extra író-minta (egy route-ban egynél több valódi `savePaidResult(`) csak a `viral-score`-on van; a `title-studio` második találata megjegyzés | statikus leltár-teszt: a valódi `savePaidResult(` hívások száma route-onként |

Az `enableCutover` terv szerint eszközönként is elvárja a kapu bizonyítékát (nem csak a globálisat); a modellben ez még **nincs** bekötve (kód nem módosult).

#### F2 — a `viral_score` útjai generáció-tudó formában (megőrzési terv)

A legacy írók puszta kikapcsolása **elvesztené a mentett előzményt**, ezért nem megoldás. Forrásból (`viral-score/route.ts`) a négy út és a megőrzés módja:

| Út | Ma (forrás) | Generáció-tudó forma (a megőrzés eldöntött) | Mit jelentene az elvesztés (nem választott irány) |
|---|---|---|---|
| **Fő fizetős eredmény** | `chargeFeature` (`:525`), majd `savePaidResult` `creditCost: 1` (`:573`) | tokenes atomikus commit: `charged` generáció, egy `gop:` levonás, a mentés ugyanabban a tranzakcióban | nem opcionális (az eszköz lényege) |
| **Ingyenes, kevés adatos eredmény** | a levonás **előtt** tér vissza (`videoCount < 3`), `savePaidResult` `creditCost: 0`, `summary.low_data: true` (`:386`), és legacy gyorsítótár-írás (`:406`) | **`free` generáció**: ugyanaz az atomikus commit (tokennel, CAS-sal, zárakkal, kerítéssel) **levonás nélkül**: nincs `gop:` spend, `credit_cost` 0, `charge_link = free`, `free_reason = low_data`; csak a regiszterben engedélyezett (eszköz, ok) pár | **P-1:** az ingyenes kevés adatos eredmény nem mentődik: nincs dashboard-előzmény, azonosítóval nem nyitható újra, a felhasználó a választ megkapja, de újrafuttatáskor új (ingyenes) szolgáltatói költség keletkezik |
| **Legacy-cache találat backfillje** | `savePaidResult` `creditCost: 1` (`:314`) — **keményen kódolt**, ezért egy ingyenes, kevés adatos legacy sort is „fizetősként” ment el (már ma hamis pénzügyi metaadat) | **legacy-cache import** (lásd az F1 szakaszt): egyetlen tranzakcióban 1. generáció `unlinked_legacy` **és** a `paid_results` vetület, eredetjelöléssel; a legacy sor `credit_cost`-ja **leíró, nem bizonyító** metaadat; a route legacy módon nem ír | **P-2:** a csak a legacy gyorsítótárban élő régi vásárlások nem kerülnek a dashboard-előzménybe és azonosítóval nem nyithatók újra |
| **Legacy gyorsítótár írása** | `saveViralScoreResult` (`:406`, `:601`) minden eredmény után | átvezetett eszközön megszűnik (az igazság forrása a generáció); a tábla csak az import forrása marad | **D-m (javítva):** az írás az átvezetett eszközön megszűnik. **Automatikus futásidejű import nincs, kiadási ablaknyi sem.** Alapút: a teljes előzetes import, a régi írók kizárása és a nulla maradékot igazoló végső census (lásd az F1 szakaszt); kimaradt sor → fail-closed megállás és kézi egyeztetés; futásidejű import csak **új, külön döntéssel** |

**A felülírás (P-3), forrásból igazolt jelenlegi hiba.** A kevés adatos ág **nincs `force_refresh`-hez kötve**, és a `savePaidResult` feltétel nélküli upsert ugyanarra a
(felhasználó, eszköz, hash) kulcsra: egy már **kifizetett** `viral_score` eredményt egy későbbi, kevés adatos futás **felülírhat** 0 pontos eredménnyel és `credit_cost: 0`-val.

**Döntés (P-3 = (b)): a `low_data` ingyenes generáció csak 1. generáció lehet.** (Rögzítve a felhasználó utasításából, amely tranziens választ ír elő — az csak a (b)
változatban létezik; ha ezt félreértettem, a rögzítés javítandó.) Ha már van commitolt generáció, az új kevés adatos eredmény **nem mentődik**, és a korábbi mentett vetület
változatlan marad. A szabály **DB-ben, a zár alatt** érvényesül: a `free` + `low_data` commit a regiszter szabálya szerint csak `expected_generation = 0`-ra engedett; ha időközben
(akár a route előzetes olvasása és a commit közti versenyben) commitolt generáció keletkezett, az RPC `free_low_data_requires_first_generation` kóddal elutasít, és a route a
tranziens választ adja. (A valódi, nem kevés adatos ingyenes frissítés — pl. ingyenes keret — felválthatja az előző generációt; ez eszközönként külön szabály.)

**A P-3 tranziens válaszának szerződése.** A felhasználó **megkapja** az új, kevés adatos tartalmat (a válasz nem hiba, nincs levonás, nincs írás), de a válasz **kimondja, hogy
nincs mentve**, és a korábbi eredmény elérhetőségét **csak bizonyítékkal** állítja:
- mezők: `persisted: false`, `reason: 'low_data_not_saved'`, `from_paid_result: false`; az új tartalomhoz **nincs** `paid_result_id`;
- magyar szöveg: „Az új, kevés adatos eredmény nincs mentve.” (soha nem állít mentést);
- az ellenőrzött megnyitás (a kapu) háromféle kimenete dönt a korábbi eredményről, és a válasz **kizárólag megfigyelést állít, ígéretet nem:** `found` →
  `previous_result_observed: true`, `previous_result_checked_at` (az ellenőrzés időpontja), a megfigyelt `paid_result_id` és `paid_result_generation`; a szöveg: „Az ellenőrzés
  pillanatában elérhető volt egy korábbi, mentett eredmény.” **Nem ígéri, hogy az eredmény „változatlanul elérhető”** (sem „továbbra is elérhető”, „megmarad”, „elérhető marad”),
  mert egy párhuzamos frissítés a válasz megérkezéséig felválthatja: a megfigyelt azonosító utóbb már a **frissebb** generációt nyitja meg. `unverified` →
  `previous_result_observed: false`, `previous_result_state: 'unverified'`, a szöveg **nem** állít elérhetőséget; `read_error` → `previous_result_state: 'unknown'`, a szöveg **nem**
  állít elérhetőséget, a napló azonosító nélküli;
- **a „kifizetett” szó kizárólag igazolt ledger-kapcsolat alapján szerepelhet:** a `found` verdikt a korábbi generáció `payment_evidence` értékét is hordozza (`ledger_linked` /
  `free` / `unknown`; a generáció nélküli `legacy_only` sor és az `unlinked_legacy` generáció `unknown`). Csak `ledger_linked` mellett módosulhat a szöveg: „Az ellenőrzés pillanatában
  elérhető volt egy korábbi, kifizetett és mentett eredmény.”; `free` esetén „… korábbi, ingyenes és mentett eredmény.”; `unknown` esetén semmilyen fizetési állítás nincs. A `payment_evidence` a DB-művelet tényleges ágából származik (lásd
  „A `credit_cost_evidence` eredete”), soha nem a `credit_cost` értékéből;
- a vetület, a generációk és a ledger **érintetlenek**; a kliens (Codex) `persisted: false` esetén nem jelenít meg „mentve” állapotot, nem írja felül a tárolt `paidResultId`-t,
  és a korábbi azonosítót ajánlja fel újranyitásra.

**A tranziens, nem mentett válasz egyetlen elutasítási kódra korlátozott.** Csak a `free_low_data_requires_first_generation` **bizonyított, strukturált elutasítás** válhat
tranziens, „nincs mentve” válasszá. A kód az RPC saját, strukturált válaszából jön (tartományi elutasítás, nem kivétel, nem üzenet-szöveg illesztése), és csak pozitív bizonyítékkal
ismerhető fel (felismerhető alakú válasz, a kód az engedélyezett listán). **Minden más RPC-hiba nem válhat tranziens válasszá:** egy másik elutasító kód (`generation_conflict`,
`intent_expired`, `binding_mismatch`, `operation_sealed`, `tool_not_cutover`, `insufficient_credits`, …) a saját, megszokott hibaválaszát kapja; egy infrastruktúra-hiba (hálózat,
5xx, időtúllépés, üres vagy olvashatatlan törzs, ismeretlen kód) **bizonytalan kimenet**, és a válasz **sem a mentést, sem a nem-mentést nem állítja** (a státusz-egyeztetés
dönt, mint a tokenes úton). Ez azért kell, mert egy bizonytalan `free` commit lehet, hogy mentett — a „nincs mentve” állítás ilyenkor hamis lenne.

**Modell-követelmények (terv, kód nem módosult):** `ChargeLink` bővül `free`-vel (szándékosan levonás nélkül), az eredet `legacy_cache_import`-tal; a `free` művelet nem
hordozhat `gop:` levonást; üzleti jóváírás rá elutasított (nincs mit jóváírni); a (eszköz, ok) pár a regiszterben engedélyezett; az invariáns-ellenőrző a `free` sorra
„nincs levonás” invariánst vizsgál. **A D-l-lel összefüggés:** a fizetős / ingyenes / ismeretlen címke forrása a `charge_link` lehet (`linked` → fizetős, `free` →
ingyenes, `unlinked_legacy` → ismeretlen), nem a `credit_cost` mező.

#### F1 — a `found` legacy-cache találat sorsa átvezetett eszközön

A legacy gyorsítótár (`similar_video_searches`, `viral_score_searches`) soraihoz **nincs generáció, és nincs manipuláció-bizonyíték**. A bizonyíték-létra átvezetett eszközön:

| Szint | Forrás | Bizonyíték | Kiszolgálható? |
|---|---|---|---|
| **E0** | generáció | minden hordozott mező egyezik a legnagyobb generációval | igen, `verified_generation` |
| **E1** | legacy `paid_results` sor, generáció nélkül | `completed`, tulajdonos, hash; korai rekord, nincs manipuláció-bizonyíték | igen, `legacy_only` (a mai viselkedés megmarad) |
| **E2** | **legacy gyorsítótár sor**, `paid_results` sor és generáció nélkül | tulajdonos + kulcs-egyezés + `completed`, ugyanabban a DB-nézetben nincs sor és generáció | **futásidőben NEM szolgálható ki és nem is importálható.** Az átvezetés **előtti, teljes importtal** kell generációvá válnia (az import egyetlen tranzakcióban hozza létre az 1. generációt `unlinked_legacy`, `origin = legacy_cache_import`, **és** a `paid_results` vetületet, azonos hatókörrel és zárral — lásd „Az E2 import atomicitása”); utána ez a sor már E0 (`verified_generation`, a vetület sorából kiszolgálva). Az átvezetés **után** egy kimaradt E2 sor verdiktje `unverified` (ok: `legacy_unreconciled`): **fail-closed megállás, kézi egyeztetés**; sem kiszolgálás, sem import, sem levonás |
| **E3** | legacy gyorsítótár sor **és** sor / generáció is van | — | a generáció / sor nyer; a gyorsítótár figyelmen kívül marad (egy elavult gyorsítótár nem írhatja felül a frissebbet) |

**Miért nem szolgálható ki közvetlenül (generáció nélkül):** (1) a kiszolgálás után az aktuális generáció 0 maradna, egy frissítés (`expected 0`) **első generációként levonna egy már
kifizetett eredményre — dupla levonás**; (2) nincs verziózás és nincs eltérés-felismerés; (3) a G-REOPEN szerződés szerint minden kiszolgált sor vagy generációval
ellenőrzött, vagy `legacy_only`. **Az ellenkező hiba is tilos:** ha a route az átvezetés után **nem** olvassa a legacy gyorsítótárat, a csak ott élő vásárló `not_found`-ot kap, és a
POST **újra levon**. Ezért az import az átvezetés **előfeltétele**, nem opcionális, és a **kimaradt sor fail-closed észlelése** is kötelező (lásd lent).

**A verdikt-tábla bővítése (átvezetett eszköz, nincs generáció, nincs `paid_results` sor):** legacy-cache sor `completed` és a kulcs egyezik → **`unverified`** (ok:
`legacy_unreconciled`; **nem** `found`, **nem** `not_found`, nincs kiszolgálás, nincs import, nincs levonás; a napló azonosító nélküli, a kézi egyeztetés jele); legacy-cache **olvasási
hiba** → `read_error` (503, nem hiány); legacy-cache sor nem `completed` vagy nincs → `not_found`; ha generáció vagy sor is van → E3 (a gyorsítótár nem számít). **A kimaradt sor észlelése
a nyitó DB-függvényben történik** (ugyanabban a pillanatképben, a route által átadott legacy kulccsal; csak olvas, nem szolgál ki, nem importál): így a megállás nem egy külön, hibát
hiányra képező route-olvasáson múlik.

**Végrehajtás (terv):** (i) csak olvasó **census**: a `completed` legacy-cache sorok, amelyekhez a route saját hash-ével nincs `paid_results` sor; (ii) átvezetés előtti **import**
(alkalmazás-oldali szkript, mert a gyorsítótár kulcsa alkalmazás-oldali hash, de **soronként ugyanazt az atomikus import RPC-t hívja**, nem ír táblát közvetlenül; idempotens, a
művelet-azonosító a legacy sor azonosítójából, saját névtérben; a legacy `credit_cost` leíró metaadatként marad meg, soha nem állandó és soha nem bizonyíték); (iii) **ellenőrző census**: nulla maradék, és minden importált sorra a route hash-ével a megnyitás `found` (árva-import kizárása);
(iv) a **régi írók kizárása**: az átvezetett route nem ír legacy gyorsítótárat és nem ír legacy `paid_results`-t, a regiszter-kerítés a legacy `paid_results`-írást elutasítja, és a
telepítés lecsengése után (a legrégebbi még futó példány függvény-időkorlátját kivárva) nincs legacy író; (v) **végső census**: a (i) lekérdezés újra, **nulla maradékot** kell adnia, és
minden importált sorra a route hash-ével a megnyitás `found`; ez az **import-ablak lezárásának és az átvezetés engedélyezésének feltétele** (a census eredménye bizonyítékként
rögzítve); (vi) **kimaradt sor:** az átvezetés után a nyitó függvény `legacy_unreconciled` megállást ad (fail-closed), és a sort **kézi egyeztetéssel** kell rendezni (lásd lent).
**Futásidejű import nincs**: sem automatikus, sem kiadási ablaknyi; csak **új, külön döntéssel** vezethető be (D-m javítva). A tartalom-leképezés (gyorsítótár sor → `result_json`)
**golden teszttel** reprodukálja a mai kiszolgált alakot.

**Az import-ablak.** A tömeges import RPC csak a regiszterben **nyitott import-ablak** mellett fut (`paid_tool_import_state`: `open` / `closed`, a lezárás ideje és a végső census bizonyítéka);
az átvezetéskor az ablak **zárul**, és zárt ablak mellett az RPC elutasít (`import_closed`), így egy route akkor sem tud futásidőben importálni, ha a kód próbálná. **Egy már átvezetett (engedélyezett) eszközön az
ablakot kézi egyeztetésnél sem nyitjuk újra.** (Egyetlen kivétel: az `M2`-ből, `linked` / `free` generáció nélkül végrehajtott naplózott `rollbackCutover` az eszközt **átvezetetlenné** teszi, és az ablakot újranyitja — lásd *A visszaengedés az előzetes import után*.)

**Célzott operátori E2-helyreállítás (nem általános ablak-újranyitás).** A kimaradt sort egy **külön, szűk operátori függvény** javítja (`reconcile_legacy_cache_generation`):
- **pontos hatókör, egyszer használatos jegy:** csak egy előre létrehozott, naplózott **jegyre** fut (`paid_reconciliation_ticket`: eszköz, felhasználó, `input_hash`, a legacy sor azonosítója,
  létrehozó operátor, indok, lejárat, `used_at`), pontosan erre a (felhasználó, eszköz, `input_hash`, legacy sor) négyesre; eltérő hatókör, lejárt vagy már felhasznált jegy → elutasítás; a jegyet
  ugyanabban a tranzakcióban jelöli felhasználtnak (opcionális: a jóváhagyó ≠ a létrehozó);
- **audit — három külön eset, három külön út** (nem igaz, hogy „minden kísérlet ugyanabban a tranzakcióban kap auditot”): (1) a **sikeres** kísérlet auditja (`paid_reconciliation_audit`: ki, mikor, jegy,
  hatókör, a legacy sor digestje, kimenet) **ugyanabban a tranzakcióban** commitol az írással (nincs audit nélküli írás és írás nélküli „siker”); (2) a **strukturált (tartományi) elutasítás** (pl.
  `scope_not_empty`, érvénytelen jegy): a függvény normálisan tér vissza, a tranzakció commitol, így az audit-sor megmarad; (3) a **visszagörgetett kísérlet** (kivétel: 23505 háttérvédelem, trigger-kivétel,
  zár- vagy utasítás-időtúllépés, szerializációs hiba, összeomlás): a tranzakcióba írt audit **maga is eltűnne**, ezért ehhez **külön, megbízható naplózási út** kell:
  - **kísérlet-sor (begin / finish):** az operátor eszköze **előbb, külön tranzakcióban** commitolja a `paid_reconciliation_attempt` sort (`started`: ki, mikor, jegy, hatókör, `attempt_id`); a javító függvény
    **csak érvényes, `started` állapotú, azonos jegyű és hatókörű `attempt_id`-vel fut** (kísérlet-sor nélkül nem fut); siker esetén ugyanabban a tranzakcióban `succeeded`-re áll, tartományi elutasításnál
    `rejected:<kód>`-ra (a tranzakció commitol); kivételnél minden visszagörgetődik, de a **korábban commitolt kísérlet-sor `started` marad** (nem tűnik el);
  - **a kimenet ismerete szerint külön állapot — a bizonytalan kimenet NEM `failed`:** ha a híváskor az eszköz **nem kap bizonyított DB-hibaválaszt** (időtúllépés, kapcsolat-megszakadás, elveszett válasz, 5xx,
    olvashatatlan törzs, az eszköz összeomlása), akkor a **sikeres javítás már commitolhatott**. Ilyenkor az eszköz **nem** jelölheti automatikusan `failed`-nek vagy `abandoned`-nek, és **nem indíthat
    második javítást**; a kísérlet **`outcome_unknown`** állapotba kerül (vagy, ha az eszköz összeomlott a rögzítés előtt, a `started` sor marad, és az elavult `started` **ugyanúgy bizonytalannak
    számít**). A `failed:<SQLSTATE>` **csak bizonyított visszagörgetésre** adható: a DB strukturált hibaválasza, engedélyezett (kód, státusz) párral (mint a mentési és a refund besorolásnál); minden más hiba
    `outcome_unknown`;
  - **állapotátmenetek (a javítás egy kísérlet-soron át halad):**
    | Innen | Esemény | Ide | Ki / hogyan |
    |---|---|---|---|
    | — | `attempt_begin` commitol | `started` | operátori eszköz; jegyenként csak akkor, ha nincs `started` / `outcome_unknown` / nem lezárt kísérlet |
    | `started` | a függvény sikerrel tér vissza (ugyanabban a tranzakcióban) | `succeeded` | a függvény (írással együtt) |
    | `started` | tartományi elutasítás (normál visszatérés, commit) | `rejected:<kód>` | a függvény |
    | `started` | **bizonyított** DB-hibaválasz (visszagörgetés) | `failed:<SQLSTATE>` | operátori eszköz, külön tranzakció, idempotens |
    | `started` | **bizonytalan** kimenet / összeomlás / elavulás | `outcome_unknown` | operátori eszköz vagy az elavult-kísérlet riport; **soha nem `failed`** |
    | `outcome_unknown` | csak olvasó egyeztetés (`reconcile_attempt_evidence`, `STABLE`, egy pillanatkép): sikeres audit + generáció + vetület + `used_at` mind megvan | `evidence_succeeded` | írás nélkül; bizonyíték-pillanatkép rögzül |
    | `outcome_unknown` | csak olvasó egyeztetés: **pozitív** bizonyíték nincs (nincs sikeres audit, generáció, vetület, `used_at`, sem `rejected` audit) | **`outcome_unknown` marad** (`no_positive_evidence`) | írás nélkül; **a hiány pillanatnyi állapot, nem bizonyíték**: az eredeti tranzakció még commitolhat |
    | `outcome_unknown` | `fence_attempt` (írás, `VOLATILE`, `READ COMMITTED`-őrrel; ugyanazok a zárak: eszköz megosztott → op → scope, **önálló zár-utasításban**; `lock_timeout`-tal — lásd *Tranzakcióizoláció és zár utáni friss olvasás*): a zár **után**, **új utasításban** újraolvasva a jegy `used_at`-ja kitöltött, vagy generáció / vetület / sikeres audit van | `evidence_succeeded` | operátori eszköz; a függvény; a kerítés **nem** íródik |
    | `outcome_unknown` | `fence_attempt`: a zár után **nincs** sikeres hatás | **`fenced`** | a kerítés a kísérlet-soron **tartós, terminális** (`fenced_at`), a tranzakció commitol |
    | `outcome_unknown` | `fence_attempt`: `lock_timeout`, hiba, vagy a válasz elveszik | `outcome_unknown` marad | az eszköz nem következtet; a kerítés **idempotens**, újrafuttatható |
    | `fenced` | csak olvasó egyeztetés a kerítés **után**: nincs sikeres audit, generáció, vetület, `used_at` | `evidence_not_applied` | írás nélkül; **csak `fenced` állapotból érhető el** |
    | `outcome_unknown` | `rejected:<kód>` audit-sor van, írás nincs | `evidence_rejected` | írás nélkül |
    | `outcome_unknown` | részleges / ellentmondó (pl. generáció van, audit nincs) | `evidence_inconsistent` | írás nélkül; **eszkaláció**, semmi automatikus |
    | `evidence_succeeded` | **emberi döntés** rögzítve (döntő, indok, bizonyíték-pillanatkép) | `succeeded_confirmed` | operátor, külön naplózott lépés; a jegy véglegesen felhasznált |
    | `evidence_not_applied` | **emberi döntés** rögzítve | `not_applied_confirmed` | operátor; **csak ezután** indulhat új kísérlet ugyanarra a jegyre |
    | `evidence_rejected` | **emberi döntés** rögzítve | `rejected_confirmed` | operátor |
    | `failed:*` vagy `not_applied_confirmed` | explicit, naplózott emberi `abandon` | `abandoned` | operátor; **csak** innen, soha `started` / `outcome_unknown` / `succeeded*` állapotból |
    A döntés **nem mondhat ellent a bizonyítéknak** (pl. `not_applied_confirmed` `evidence_succeeded` mellett elutasított), és emberi azonosítót, indokot és a bizonyíték-pillanatképet hordoz;
  - **a késői commit kizárása: tartós kerítés (`fence_attempt`) — a „hiány” soha nem bizonyíték.** Az `evidence_not_applied` **nem** következhet abból, hogy a generáció és a vetület pillanatnyilag hiányzik: az
    eredeti tranzakció (lassú vagy késleltetett hívás) még commitolhat. Végállapot-bizonyíték csak egy **tartós, terminális kerítés** után van: (1) a javító függvény és a kerítés **ugyanazokat a zárakat** veszi
    (eszköz megosztott → op → scope), tehát **sorosodnak** — ha az eredeti tranzakció már tartja a zárat, a kerítés **megvárja**, hogy az véget érjen, majd a zár **után** újraolvas; (2) a javító függvény a
    kísérlet-sor állapotát és a jegyet a zár **után** olvassa újra, és csak `started` állapotban ír, **`fenced` esetén `attempt_fenced`-del elutasít** (írás nélkül) — így egy **commitolt kerítés után a
    késői commit kizárt**; (3) ha a kerítés a zár után **sikeres hatást** talál, az `evidence_succeeded`, és kerítést nem ír; (4) a `fenced` állapotot a kísérlet-sor változtathatatlansági triggere védi
    (kilépés csak a fenti, emberi döntéses úton); (5) a kerítés **nem** támaszkodik pillanatnyi hiányra, `pg_stat_activity`-re vagy kliens-oldali időtúllépésre; a szerepkör `statement_timeout` /
    `idle_in_transaction_session_timeout` beállítása legfeljebb kiegészítő, **nem bizonyíték**. **Ha ilyen bizonyíték nincs** (a kerítést nem sikerült commitolni: `lock_timeout`, hiba, elveszett válasz,
    nem elérhető), a kísérlet **`outcome_unknown` marad**; **nem lehet** `not_applied_confirmed`, `abandoned`, és **nem indulhat újabb javítás**. A `failed` ettől független: egy **bizonyított DB-hibaválasz**
    azt jelenti, hogy az adott tranzakció véget ért, így késői commitja nincs;
  - **védőrétegek a téves második javítás ellen:** (a) az eszköz a `started` / `outcome_unknown` / bizonyítékra váró állapotban **nem indít** új kísérletet (`UNIQUE (ticket_id) WHERE state IN ('started',
    'outcome_unknown','fenced','evidence_succeeded','evidence_not_applied','evidence_rejected','evidence_inconsistent')`); (b) egy már sikeres javítás után a jegy `used_at` mezője kitöltött → `ticket_used`;
    (c) a zár utáni E3-ellenőrzés `scope_not_empty`-t ad, ha a generáció vagy a vetület már létezik — így egy mégis elindított második javítást a DB megfogja; (d) a `fenced` állapotú kísérlet késői commitját az
    `attempt_fenced` zár utáni ellenőrzés kizárja (lásd a kerítést);
  - **hibaszabály:** (a) ha a kísérlet-sor commitja sikertelen, **a javítás nem fut** (fail-closed, nincs naplózatlan kísérlet); (b) ha a lezáró írás sikertelen, a sor `started` marad, és egy **elavult `started`
    kísérletek riport** jelzi (időkorlát után), amely **`outcome_unknown`-ra** (nem `failed`-re) emel; (c) egy elakadt kísérletet **csak** a fenti emberi, bizonyíték-alapú út zár le; (d) soha nem lehet
    „siker” audit nélkül, és nem futhat javítás kísérlet-sor nélkül;
  - a PostgreSQL naplóba írás (`RAISE LOG`) **nem audit** (nem tartós, nem lekérdezhető); a sima PostgreSQL-ben nincs beépített autonóm tranzakció, egy `dblink`-szerű megoldás extra függőség, nem a terv;
- **ugyanazok a zárak, zár utáni E3-ellenőrzés:** eszköz (megosztott) → op → scope, mint a commitnál; a regiszter, a `paid_results` sor, a generációk és a legacy gyorsítótár sor a zár **után**
  olvasódik újra; ha a hatókörben **bármilyen** generáció vagy `paid_results` sor van → `scope_not_empty` elutasítás (E3: a meglévő nyer);
- **semmilyen route-hozzáférés:** a függvény **nem exponált sémában** él (nincs a PostgREST sémái között), EXECUTE csak a dedikált operátor szerepkörnek (REVOKE PUBLIC / anon / authenticated /
  `service_role` alól); az operátor közvetlen DB-kapcsolaton, interaktív jelszóval fér hozzá (a production-szigor szerint). Katalógus-szabály (a `checkSpendFenceCatalog` mintájára): a függvényt egyetlen
  kérés-szerepkör sem hívhatja, a `service_role` nem tagja az operátor szerepkörnek, tagsági láncon át sem; statikus teszt: egyetlen route / lib fájl sem hivatkozik rá;
- **nem írhat felül létező generációt vagy vetületet (négy réteg):** (1) a zár utáni E3-ellenőrzés `scope_not_empty`-t ad, ha bármi létezik; (2) az írások **sima INSERT-ek** (nincs `ON CONFLICT`,
  UPDATE vagy DELETE a törzsben — forrás-teszt), így egy ütközés az egész tranzakciót megszakítja (23505): `UNIQUE (user_id, tool_type, input_hash, generation)` a generációs táblán és a `paid_results`
  `(user_id, tool_type, input_hash)` egyedi indexe; (3) a `paid_results` invariáns-trigger átvezetett eszközön csak a legnagyobb generációval azonos tartalmú írást engedi, és a generáció beszúrása
  előbb történik ugyanabban a tranzakcióban; (4) a generációs táblák változtathatatlansági triggere tiltja az UPDATE-et és a DELETE-et. Az (1) réteg kiiktatása esetén a (2) még megfogja — ezt külön
  teszt bizonyítja;
- **tesztek — válaszvesztés és összeomlás (állapotgép):**
  1. *a válasz elveszik a commit **után*** (a függvény sikeresen commitolt, a kliens időtúllépést lát): az eszköz `outcome_unknown`-t rögzít, **nem** `failed`-et, **nem** `abandoned`-et és **nem** indít
     második javítást; a csak olvasó egyeztetés `evidence_succeeded` (sikeres audit + generáció + vetület + `used_at`); emberi döntés → `succeeded_confirmed`; ezután minden új kísérlet `ticket_used` / `scope_not_empty`;
  2. *a válasz elveszik, és a hatás hiányzik* (a tranzakció nem commitolt, vagy még nem): **kerítés nélkül** a csak olvasó egyeztetés `no_positive_evidence`, az állapot `outcome_unknown` marad, a
     `not_applied_confirmed`, az `abandon` és az új kísérlet **elutasított**; a `fence_attempt` után `fenced` → `evidence_not_applied` → emberi döntés → `not_applied_confirmed` → **csak ezután** indulhat új kísérlet;
  3. *az eszköz összeomlik a hívás és a lezárás között*: a `started` sor elavul, az elavult-kísérlet riport `outcome_unknown`-ra emeli, a begin-őr blokkol, az egyeztetés ugyanígy halad;
  4. *összeomlás a javító függvény minden lépésénél* (jegy-ellenőrzés után, generáció után, vetület után, a jegy-felhasználás után, az audit után): a tranzakció egésze vagy érvényesül, vagy nem; **soha**
     nincs generáció siker-audit nélkül, siker-audit generáció nélkül, vetület generáció nélkül vagy `used_at` a többi nélkül; a kísérlet-sor mindig `started` / `succeeded`;
  5. *az elutasítás válasza veszik el* (tartományi elutasítás commitolt, a kliens nem látja): `outcome_unknown` → `evidence_rejected` → emberi döntés; nem `failed`;
  6. *verseny:* két `attempt_begin` ugyanarra a jegyre → a második elutasított (részleges egyedi index); eszköz-újrapróbálás elveszett válasz után → nem indul (az eszköz unit-tesztje: bizonytalan hibára
     nincs második hívás); két operátor egyszerre dönt ugyanarra az `outcome_unknown` kísérletre → az egyik elutasított (az átmenet a feltételes frissítés, egy nyertes);
  7. *hibabesorolás:* a bizonyított DB-hibaválasz (engedélyezett kód + státusz) → `failed`; időtúllépés, kapcsolat-megszakadás, 5xx, üres / olvashatatlan törzs, ismeretlen kód → `outcome_unknown`;
     mutáció: egy bizonytalan hiba `failed`-re képezése → a teszt elbukik;
  8. *emberi döntés szabályai:* döntés bizonyíték nélkül, a bizonyítéknak ellentmondó döntés (`not_applied_confirmed` `evidence_succeeded` mellett), döntő nélküli döntés → elutasított;
     `abandon` `started` / `outcome_unknown` / `succeeded*` állapotból → elutasított; `evidence_inconsistent` → semmilyen automatikus átmenet;
  9. *az egyeztetés csak olvas:* `reconcile_attempt_evidence` katalógus-tesztje (`provolatile = 's'`), nincs írási joga, egy pillanatképben olvas (a generáció és a vetület nem szakadhat szét);
  10. *a téves második javítás:* egy mégis elindított második javítás `ticket_used` / `scope_not_empty` miatt elutasított, a generáció és a vetület bájtra azonos;
  11. *késői commit a kerítés után:* az eredeti javítás a zár előtt késik (a „már elindult, de még nem zárolt” hook), a kerítés közben commitol → az eredeti a zár után `attempt_fenced`-et lát, és **semmit** nem ír
      (generáció, vetület, jegy, siker-audit érintetlen); a kerítés és a javítás **minden sorrendben**, a késés a zár előtt és a zár után is;
  12. *az eredeti tranzakció tartja a zárat* (lassú): a kerítés vár; az eredeti commitja után a kerítés `evidence_succeeded`-et ad és **nem** ír `fenced`-et; az eredeti visszagörgetése után `fenced`
      (valódi DB-n a fenti **kétkapcsolatos teszt** 1–5. forgatókönyve, negatív kontrollal és izoláció-őr teszttel; DB-mentesen a `stale_before_lock` mutációval);
  13. *a kerítés maga bizonytalan:* `lock_timeout` → `outcome_unknown` marad, **nincs következtetés**, nincs `not_applied_confirmed`, nincs `abandoned`, nincs új kísérlet; a kerítés válaszvesztése → újrafuttatható,
      a második hívás ugyanazt adja (idempotens); összeomlás a kerítés lépésein → nincs fél kerítés (a `fenced` jel és a kísérlet-sor együtt);
  14. *mutációk:* a javító függvény a kerítést a zár **előtt** olvassa → a késői commit sikerül, a teszt elbukik; az `evidence_not_applied` `fenced` nélkül megengedett → elbukik; a kerítés a „hiányt” elég
      bizonyítéknak veszi → elbukik; a bizonytalan hiba `failed`-re képezése → elbukik;
  15. *jogosultság:* a `fence_attempt` és az egyeztető függvény **nem exponált sémában**, csak az operátor szerepkör hívhatja (a katalógus-szabály negatív esetei), a route-ok nem hivatkoznak rájuk (statikus);
  — továbbá: **kivétel-ág:** az E3-ellenőrzés kiiktatva → 23505 → a tranzakció visszagörgetődik, de a kísérlet-sor `started` marad, a generáció / vetület / jegy érintetlen (ez bizonyítja, hogy a
  visszagörgetett kísérlet nyoma nem tűnik el); a kísérlet-sor commitjának hibája → a javítás nem fut; a lezáró írás hibája → `started` marad, és az elavult-kísérlet riport `outcome_unknown`-ra emel;
  jegy nélkül / eltérő hatókör / lejárt / felhasznált → strukturált elutasítás, az audit-sor megmarad; **kísérlet-sor nélkül a függvény nem fut**; sikeres út: `succeeded` + generáció + vetület + jegy-felhasználás **egy** tranzakcióban (összeomlás → egyik sem, a kísérlet `started` marad); létező generáció → `scope_not_empty` (a generáció és a vetület bájtra azonos); csak `paid_results` sor (E1) →
  `scope_not_empty`; kimaradt E2 sor → egy tranzakcióban generáció + vetület + audit, `unlinked_legacy`; **az E3-ellenőrzés kiiktatva** (mutáció) → az egyedi kulcs megszakítja a tranzakciót, semmi nem íródik
  felül; verseny: reconcile és commit / import / reconcile **minden sorrendben**, pontosan egy ír; egy commit, amely a jegy-ellenőrzés után, a zár előtt landol → `scope_not_empty`; összeomlás minden
  lépésnél → nincs fél írás, nincs „siker” audit írás nélkül és nincs írás siker-audit nélkül; zárt import-ablak mellett az általános import `import_closed`, a célzott javítás ettől függetlenül jegyhez kötött; route nem hívja (statikus); a
  jogosultsági katalógus-szabály negatív esetei.

**Tranzakcióizoláció és zár utáni friss olvasás — a `fence_attempt` és minden VOLATILE írófüggvény szabálya (specifikáció, 2026-10-06).**
*PostgreSQL-dokumentáció (ellenőrizve):* `READ COMMITTED` alatt egy lekérdezés az **indulása előtt** commitolt adatot látja, az egymást követő parancsok **új pillanatképet** kaphatnak, és egy sorzárra váró
utasítás a másik tranzakció commitja után újraértékeli a feltételét; `REPEATABLE READ` / `SERIALIZABLE` alatt **egy** pillanatkép van a tranzakció első, nem tranzakcióvezérlő utasításától. A `STABLE` / `IMMUTABLE`
függvény a **hívó lekérdezés** pillanatképét használja (és nem módosíthat), a `VOLATILE` függvény belső lekérdezései **külön, friss** pillanatképet kapnak. *Amit ebből a terv levon:*
- **Az írófüggvény `VOLATILE`** (soha `STABLE`): különben a zárra várás alatt commitolt javítás nem látszana. A **csak olvasó egyeztetés** (`reconcile_attempt_evidence`) viszont `STABLE`, egyetlen pillanatképpel, és a kerítés
  commitja **után**, **külön hívásként** fut (ugyanabban a hívásban a kerítéssel nem).
- **Izoláció-őr a belépéskor:** a `fence_attempt` (és a javító, a commit, a seal, az import, a `resync`, az `enableCutover` / `rollbackCutover`) az első utasítása `current_setting('transaction_isolation')`; ha az **nem
  `read committed`**, strukturált `isolation_level_not_supported` elutasítás, **írás nélkül** (a kerítés nem futott, az állapot `outcome_unknown` marad). A szerepkör `default_transaction_isolation = 'read committed'`
  beállítása csak kiegészítő, **nem bizonyíték**; az őr a *jelenlegi* tranzakciót nézi, ezért a híváshelyi `SET TRANSACTION ISOLATION LEVEL` is elkapott.
- **A zár és az olvasás külön utasítás:** a zárat önálló `PERFORM pg_advisory_xact_lock…` / `…_shared` utasítás szerzi meg (rend: eszköz megosztott → op → hatókör), és a döntéshez szükséges adatot **csak ezután, újabb,
  önálló utasítások** olvassák (a kísérlet-sor állapota, a jegy `used_at`-ja, a generációk, a vetület, a sikeres audit). **Tilos** egy utasításban zárat szerezni és ugyanott olvasni (`SELECT pg_advisory_xact_lock(k), (SELECT …)`):
  annak a pillanatképe a **várakozás előtt** készül, így a várakozás alatt commitolt javítást nem látná. A zár **előtti** olvasás döntésre nem használható.
- **`lock_timeout` a függvényen:** a kerítés a függvény `SET lock_timeout = …` attribútumával fut (a függvény kilépésekor visszaáll); hogy ez a **zárra várást** valóban megszakítja-e a függvény belsejében, **valódi DB-n
  igazolandó** (a teszt: a zárat tartó kapcsolat hosszabban tart). Lejáratkor `55P03` / strukturált `lock_timeout` → a kerítés **nem** írt, a kísérlet `outcome_unknown` marad, nincs következtetés az eredeti tranzakcióról.
- **A javító függvény ugyanígy** a zár **után** olvassa a kísérlet-sort, és csak `started` **vagy** `outcome_unknown` állapotból ír (`started → outcome_unknown` az eszköz feltételes frissítése; a késői commit
  ettől még `succeeded`-re áll), `fenced` / terminális állapotból `attempt_fenced`-del elutasít.
- **A kerítés döntési sora (a zár után, friss olvasással):** (1) a kísérlet-sor már `succeeded`, vagy a jegy `used_at` kitöltött, vagy generáció / vetület / sikeres audit van → **sikerbizonyíték** (`evidence_succeeded`),
  kerítés **nem** íródik; (2) `rejected:<kód>` audit-sor van → `evidence_rejected`; (3) részleges / ellentmondó → `evidence_inconsistent`; (4) **egyik sem** → `fenced` (`fenced_at`), commit. A „nem alkalmazott” állapot
  **kizárólag** a (4) ágból, a zár utáni olvasás után keletkezik, soha pillanatnyi hiányból.
- **Általános szabály** minden VOLATILE írófüggvényre: izoláció-őr → zárak önálló utasításokban → friss döntési olvasás → írás. Forrás-teszt a migrációs SQL szövegén: a függvény nem `STABLE`; az első utasítás az őr;
  a `pg_advisory_xact_lock` önálló `PERFORM`; a döntési táblák olvasása a zár-utasítás **után** áll; nincs kombinált zár+olvasás utasítás. (Ez **szövegszintű** védelem; a viselkedést a kétkapcsolatos teszt bizonyítja.)

**Kétkapcsolatos teszt (valódi DB, *csak külön jóváhagyás után, előbb izolált, eldobható teszt-DB-n*; hook nélkül, a pg_stat_activity csak a teszt szinkronizálására szolgál, a kerítés nem támaszkodik rá).**
Közös előkészület: egy `started` kísérlet egy érvényes jeggyel és egy `S0` hatókörrel; az A kapcsolat az „eredeti javító”, a B a kerítés; mindkettő `READ COMMITTED`.
1. **Az eredeti javítás a kerítés várakozása alatt commitol → a kerítés sikert lát.** A: `BEGIN`, a három zár kézi megszerzése (megosztott eszköz, op, hatókör); B: `fence_attempt` hívása → **blokkol** (a teszt
   `pg_stat_activity`-ben `wait_event_type = 'Lock'`-ot lát); A: a **valódi** javító függvény hívása (ugyanazok a zárak, a saját munkamenetében újrabelépő), majd `COMMIT`; B visszatér: **sikerbizonyíték**
   (`evidence_succeeded` / a kísérlet-sor `succeeded`), **nincs `fenced_at`**, a generáció, a vetület, az audit és a `used_at` egy-egy példány, a kísérlet-sor állapota `succeeded`.
2. **Negatív kontroll (a teszt foga):** egy **csak a tesztséma**ban élő, szándékosan hibás kerítés-változat (a zárat és az olvasást **egy utasításban** végzi, vagy a pillanatképet a várakozás előtt rögzíti) ugyanebben a
   forgatókönyvben **`fenced`-et ír egy már commitolt javítás mellé** — a teszt ezt a változatot **elbuktatja**; a változat sosem kerül app-migrációba. Ugyanez `REPEATABLE READ` kapcsolattal: az **igazi** kerítés
   `isolation_level_not_supported`-ot ad és nem ír (B: `BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1;` után hívja).
3. **Az eredeti visszagörgetődik → `fenced`.** Mint az 1., de A `ROLLBACK`-kel zár: B `fenced`-et ír és commitol; ezután egy **harmadik** kapcsolaton a késői javító hívás `attempt_fenced`-et kap, és **semmit** nem ír;
   az újra futó csak olvasó egyeztetés `evidence_not_applied`-ot ad (csak `fenced` állapotból).
4. **A kerítés megy előre, a javító késik (a másik irány).** B: `BEGIN`, `fence_attempt` (a `fenced` állapot kiírva, **még nem commitolt**, a zárak nála); A: a javító hívása → **blokkol**; B `COMMIT`; A visszatér
   `attempt_fenced`-del, **nem ír** (generáció, vetület, jegy, audit érintetlen). A negatív kontroll (a kísérlet-sort a zár előtt olvasó javító) itt **ír**, és a teszt elbukik.
5. **`lock_timeout`:** A a zárat a beállított időnél tovább tartja; B `lock_timeout`-ot kap, **nem** ír `fenced`-et, a kísérlet `outcome_unknown` marad; A commit után B újrafuttatása idempotensen sikert / `fenced`-et ad a valós állapot szerint.
6. **A trigger ↔ `enableCutover` párja** a *visszaengedés előzetes import után* szakaszban (ugyanaz a minta: zár önálló utasításban, friss olvasás a zár után).

**DB-mentes modell-megfelelők (a következő, külön jóváhagyandó kódlépésben):** a modell lépés-ütemezővel (a két függvény lépései: zár → olvasás → írás) minden lépés-átlapolást bejár, `snapshotMode: 'fresh_after_lock' | 'stale_before_lock'`
paraméterrel; a `stale_before_lock` mutáció a fenti 1. és 4. forgatókönyvben hibát ad (a teszt elbukik); az izoláció-őr (`read_committed` / `repeatable_read`) modell-paramétere elutasítást ad. **Ez a modell a
PostgreSQL-szemantikát nem bizonyítja**, csak a terv logikáját teszteli: az 1–5. forgatókönyv valódi bizonyítéka a kétkapcsolatos teszt, amely addig **nincs elvégezve**.

**Az E2 import atomicitása (döntés).** Az import **egyetlen DB-tranzakció** (VOLATILE import RPC), amely **együtt** hozza létre: (1) az 1. generációt (`unlinked_legacy`,
`origin = legacy_cache_import`), (2) a hozzá tartozó **`paid_results` vetületet** (a hordozott mezők a generáció pillanatképével azonosak, `completed`), (3) a művelet-sort
(a legacy sor azonosítójából származó, saját névterű azonosító). **Azonos hatókör és azonos zár:** a generáció, a vetület és a zár hatóköre ugyanaz a (felhasználó, eszköz,
`input_hash`); a zársorrend tool → op → scope, mint a commitnál; a regiszter, a sor, a generáció és a gyorsítótár sor (E3) a zár **után** olvasódik újra. Következmények:
- **önmagában egy generációs sor nem teszi megnyithatóvá a cache-eredményt:** a kapu a vetület **sorából** szolgál ki, a generációval ellenőrizve; a vetület nélküli generáció
  (pl. out-of-band) `unverified` (a határ-tábla szerint), a gyorsítótár sorból és a generáció pillanatképéből **soha** nem szolgál ki;
- bármely lépés hibája az egész importot visszagörgeti (nincs fél import, nincs árva generáció és árva vetület); a második hívás ugyanazt a `generationId`-t és `paidResultId`-t
  adja (duplikátum), nem hoz létre újat;
- ha időközben sor vagy generáció keletkezett (E3), az import nem ír, a meglévőt adja vissza.

**A legacy `credit_cost` nem bizonyít levonást (döntés).** Egy `unlinked_legacy` (és `legacy_cache_import`) generáció `credit_cost` értéke **leíró, nem bizonyító**
metaadat: belőle sem levonás, sem fizetős állapot, sem jóváírhatóság, sem visszatéríthetőség nem következtethető. Megvalósítási követelmények (terv): (1) a generáció
`credit_cost_evidence` jelölést kap (`ledger_linked` a levonáshoz kötöttnek, `free` a szándékosan ingyenesnek, `legacy_unverified` az importáltnak) — **a jelölés eredetét
lásd a következő bekezdésben, nem a hívó állítja**; (2) a D-l címke
`unlinked_legacy`-nél **mindig „ismeretlen”**, bármi is a `credit_cost` — a mai `credit_cost > 0 → fizetős` logika ezekre a sorokra nem alkalmazható, a D-l **bármelyik** változatában
(az (A) változat sem tartalmazhatja); (3) üzleti jóváírás és árva-rendezés rá nem alkalmazható (nincs kötött levonás); (4) pénzügyi összesítés nem összegezheti az ilyen sorok
`credit_cost`-ját levonásként; (5) az import a legacy értéket **megőrzi** (információvesztés nélkül), a bizonyíték-jelöléssel együtt; a `viral-score` backfill keményen
kódolt `1`-ese a **mai** hamis jelzés, az import ezt nem ismétli, és egy 0 értékű legacy sort sem tekint „ingyenesnek” (az is csak „ismeretlen”).

**A `credit_cost_evidence` eredete (döntés): a DB-művelet tényleges ágából származik, nem a hívó állítása.** A jelölés **pénzügyi állítás**, ezért a hívó nem adhat meg és
nem írhat felül ilyen értéket (sem paraméterként, sem a `credit_cost`-on át):
- **három külön DB-művelet, három ág:** a **levonó** commit (`paid_operation_commit`) mindig levon, és a jelölést `ledger_linked`-re, az árat a DB saját költségtáblájából, a
  `credit_transaction_id`-t a **tényleges** `spend_credits_core` nyugtából állítja; az **ingyenes** commit (`paid_operation_commit_free`) soha nem von le, `free`-t és `credit_cost = 0`-t
  állít (a hívó által küldött nem-nulla ár figyelmen kívül marad vagy elutasított), és csak a regiszterben engedélyezett (eszköz, ok) párra fut; az **import**
  (`import_legacy_cache_generation`) `legacy_unverified`-et állít, és a legacy `credit_cost`-ot **maga a DB-függvény olvassa a legacy sorból** (a hívó csak a sor azonosítóját és a
  kulcsokat adja), így a hívó nem állíthat levonást;
- **egyik függvény aláírásában sincs** `credit_cost_evidence` (vagy azzal egyenértékű) paraméter (katalógus- és forrás-teszt), és a generációs táblára a `service_role`-nak nincs
  INSERT / UPDATE joga (csak ezek a definer-függvények írnak), a tábla pedig a megszokott módon változtathatatlan;
- **a kapcsolat kikényszerítése** (`ledger_linked` ⇔ `charge_link = linked` ⇔ kitöltött `credit_transaction_id`, amelynek ledger-sora `credit_spend`, `gop:<művelet>` hivatkozású, azonos felhasználójú és
  `−delta = credit_cost`; `free` ⇔ nincs `gop:` ledger-sor és `credit_cost = 0`; `legacy_unverified` ⇔ `unlinked_legacy`) **több táblán ível át**, ezért nem egyetlen CHECK; a konkrét
  PostgreSQL-mechanizmusok — egysoros CHECK, FK, UNIQUE, halasztott constraint trigger, jogosultságok — a következő szakaszban vannak, **tervként, nem igazolt garanciaként**;
- a cél: a „fizetett” állítás **ellenőrizhető legyen a ledger-kapcsolatból**, és a `payment_evidence` (a P-3 válaszban és a címkében) ugyanebből a jelölésből jöjjön — ez addig terv, amíg a
  mechanizmusok valódi DB-n le nem futottak.

**Teszt-kiegészítések a három döntésre (terv, a tesztek még nem készültek):**
- *E2 atomicitás:* összeomlás az import minden lépésénél (generáció után, vetület után, művelet-sor után) → az állapot bájtra azonos, nincs árva generáció és nincs árva vetület;
  invariáns: minden generációnak van vetülete **azonos hatókörben**, és a vetület egyezik a legnagyobb generációval; vetület nélküli generáció (out-of-band) → `unverified`, és a
  gyorsítótár sorból / pillanatképből nem szolgál ki; import és commit és import **minden sorrendben** (tool → op → scope; pontosan egy nyer, a másik a meglévőt kapja);
  az import utáni `paidResultId` a vetület sorának azonosítója, és a meglévő újranyitás megnyitja; a tömeges import ugyanazt az RPC-t hívja (statikus teszt: nincs közvetlen
  táblaírás az import szkriptben).
- *`credit_cost` ≠ bizonyíték:* `unlinked_legacy` sor `credit_cost = 3` mellett is: a címke „ismeretlen”; `businessCredit` → `charge_not_linkable`; nincs ledger-sor és nincs `gop:`
  hivatkozás; invariáns: az ilyen generáció soha nem kötött levonáshoz; `credit_cost = 0` mellett sem „ingyenes”; statikus teszt: nincs `credit_cost > 0`-ból levezetett fizetős állapot
  `charge_link = linked` nélkül (a dashboard `:341` a D-l szerint cserélendő); a viral-score backfill állandó `1`-ese nem kerül az importba.
- *P-3 tranziens válasz:* `low_data` + van commitolt generáció → nincs commit, nincs írás, a válasz `persisted: false`, `reason: 'low_data_not_saved'`, új tartalomhoz kötött
  `paid_result_id` nélkül; a vetület, a generációk és a ledger bájtra azonosak; a `previous_result_observed: true` **csak** `found` mellett — három külön teszt (`found`, `unverified`,
  `read_error`), az utóbbi kettőben a szöveg nem állít elérhetőséget; verseny: a route előzetes olvasása után landol egy fizetett commit → az RPC
  `free_low_data_requires_first_generation` → ugyanaz a tranziens válasz; `low_data` + nincs generáció → `free` 1. generáció, `persisted: true`; `force_refresh` + `low_data` + van fizetett
  → tranziens; forrás-teszt a válasz szövegére (nem állít mentést).
- *P-3 megfigyelés, nem ígéret:* forrás-teszt: a válaszszövegek sehol nem tartalmazzák a „változatlanul”, „továbbra is elérhető”, „megmarad”, „elérhető marad” kifejezést; verseny-teszt: az
  ellenőrzés után, a válasz előtt egy párhuzamos frissítés landol → a válasz szövege és mezői ettől még igazak maradnak (csak az ellenőrzés pillanatát állítják, a
  `previous_result_checked_at` az ellenőrzés ideje), és a megfigyelt azonosító megnyitása a frissebb generációt adja.
- *P-3 szöveg és fizetési állítás:* a `found` ág szövege **soha nem tartalmazza a „kifizetett” szót**, ha a korábbi generáció `payment_evidence` értéke nem `ledger_linked`; három külön
  teszt (`ledger_linked` → kiegészíthető, `free` → „ingyenes”, `unknown` / `legacy_only` / `unlinked_legacy` → nincs fizetési állítás), `credit_cost = 3` mellett is az `unknown`
  sorra; forrás-teszt: a „kifizetett” szó csak a `ledger_linked` ágban szerepel.
- *Egyetlen tranziens elutasítás:* a `free_low_data_requires_first_generation` → tranziens, „nincs mentve” válasz; **minden más** kód külön, soronként tesztelve (`generation_conflict`,
  `intent_expired`, `binding_mismatch`, `operation_sealed`, `tool_not_cutover`, `insufficient_credits`, ismeretlen kód) → a saját hibaválasza, **soha nem tranziens**; infrastruktúra-hibák
  (hálózat, 5xx, időtúllépés, üres törzs, olvashatatlan törzs) → a válasz sem a mentést, sem a nem-mentést nem állítja; a kód felismerése strukturált válaszból, nem szövegből
  (egy üzenetben szereplő kódnév nem elég); mutációk: bármely hiba tranzienssé képezése, az uncertain „nincs mentve”-nek olvasása.
- *D-m (nincs futásidejű import):* statikus teszt: egyetlen route sem hívja az import klienst, és nincs olyan kódág, amely a `legacy_unreconciled` helyzetben importál vagy kiszolgál; zárt import-ablak
  mellett az import RPC `import_closed`-dal elutasít (valódi DB-n); `enableCutover` a nulla maradékot igazoló végső census bizonyítéka nélkül elutasít; kimaradt sor (legacy-cache sor, nincs sor és
  generáció) → `unverified` / `legacy_unreconciled`, a `POST` megáll a hozzáférés-ellenőrzés, az AI-hívás és a levonás **előtt**, nincs kiszolgálás és nincs import; a legacy gyorsítótár olvasási
  hibája `read_error`, nem hiány; kézi egyeztetés: **jegyhez kötött, célzott operátori függvény, nem ablak-újranyitás** (lásd „Célzott operátori E2-helyreállítás”); mutáció: futásidejű import a megállás helyett.
- *`credit_cost_evidence` eredete:* egyik RPC aláírásában nincs bizonyíték-paraméter (katalógus- és forrás-teszt); levonó commit → `ledger_linked` + egyező ledger-sor (`gop:<művelet>`);
  ingyenes commit → `free`, nincs ledger-sor, `credit_cost = 0` akkor is, ha a hívó nem-nullát küld; import → `legacy_unverified` a legacy `credit_cost` bármely értéke mellett (0, 1, 3); a
  hívó által küldött, kitalált levonás-azonosító nem hoz létre `ledger_linked` jelölést; ellentmondó hármasok beszúrása elutasított (modellben invariáns, valódi DB-n megszorítás);
  mutáció: a jelölés a hívó paraméteréből vagy a `credit_cost` értékéből származik.

**Teszt-kiegészítések (F1/F2, terv):** import idempotens (kétszer = egy generáció, azonos azonosító), saját névtér, nincs import ha sor vagy generáció van (E3), a legacy sor saját
`credit_cost`-ja és eredete megmarad, import és commit **minden sorrendben** (zársorrend tool → op → scope; pontosan egy nyer), import után az `expected 0` commit
`generation_conflict` (a dupla levonás bizonyítottan kizárt), import előtt ugyanaz **KNOWN HAZARD**-ként rögzítve; `free` generáció: nincs levonás, üzleti jóváírás elutasított, token-idempotencia,
(eszköz, ok) a regiszterben, a P-3 szabály a választott változat szerint; census nulla és route-hash megnyitás `found`; legacy-cache olvasási hiba → `read_error`; golden alak.

#### F4 — az ingyenes napi / heti keret és a `free` generáció: egy atomikus DB-döntés

**Forrásból:** ma a keretet a `FREE_LIMITS` adja (`similar_videos`: napi 3, `hardLimitDaily` 50; `opportunity_engine`: heti 1, `hardLimitDaily` 20), és a `youtube_search_logs` sorok
**megszámolásával** dől el (UTC nap; ISO hét, hétfő 00:00 UTC). A **felhasználást** a munka **után**, a mentéstől külön írja a `logYouTubeSearch`, a hibát nyelve (`.catch(() => {})`). Egy
engedélyezett (eszköz, ok) pár ezért **önmagában nem védi a keretet**: két párhuzamos kérés ugyanazt a maradék keretet láthatja, és a naplózás elveszhet.

**Terv:** a jogosultság ellenőrzése és a keret felhasználása a `free` commit **ugyanabban az atomikus DB-tranzakciójában** történik (a (eszköz, ok) pár csak az első feltétel).
1. **Regiszter és a `quota_limit` eredete:** `paid_tool_free_quota` — `PRIMARY KEY (tool_type, reason, window_kind)`, `window_kind IN ('day','week')`, `quota_limit integer NOT NULL CHECK (quota_limit > 0)`.
   A mai `FREE_LIMITS`-ből **a migráció seedeli** (`similar_videos` / free / `day` / 3; `opportunity_engine` / free / `week` / 1); csak migrációval vagy a naplózott operátori függvénnyel módosítható (a
   `service_role`-nak nincs írási joga). **A `quota_limit` forrása kizárólag ez a regiszter-sor:** a függvény a beszúrt slot-sorba **másolja** (pillanatkép), a hívó **soha nem adja meg**, és az aláírásban
   nincs ilyen paraméter. `viral_score` / `low_data`: nincs keret (csak a P-3 első-generáció szabály).
2. **Zárak és hatókörük** (az `assertLockOrder` rangsora bővül: eszköz < quota < op < scope): az **eszköz-zár megosztott** (nem sorosít felhasználókat); a **quota-zár kizárólagos, de csak az
   (`user_id`, `tool_type`, `window_kind`, `window_start`) kulcsra** (`pg_advisory_xact_lock(hashtextextended('quota:' ‖ …, 0))`, saját `quota:` kulcstér-előtaggal) — tehát két **különböző felhasználó**
   ingyenes kérése, illetve ugyanazon felhasználó két **különböző eszköze vagy ablaka** soha nem várakozik egymásra; csak ugyanazon felhasználó ugyanazon eszközének ugyanazon ablakán belüli kérések
   sorosodnak, és ez szándékos. (Egy hash-ütközés csak többletsorosítást okozhat, helytelenséget nem.)
3. **A zárak után**, ugyanabban a tranzakcióban: az ablak kezdete a **DB `now()`-jából, UTC-ben** (nap; hét: hétfő 00:00 UTC, mint a mai `getStartOfWeekUtc`); a `paid_free_quota_use`
   sorainak megszámolása az ablakban; ha `darab < korlát`, a következő **slot** beszúrása (`slot = darab + 1`), különben strukturált elutasítás `free_quota_exhausted` (nincs írás).
4. **Slot-séma és háttér-megszorítások** (a zártól függetlenül): `paid_free_quota_use(user_id uuid, tool_type text, window_kind text, window_start timestamptz, slot integer, quota_limit integer,
   operation_id uuid NOT NULL, created_at timestamptz DEFAULT now())`. **Pontos egyedi kulcs: `PRIMARY KEY (user_id, tool_type, window_kind, window_start, slot)`**; `CHECK (slot BETWEEN 1 AND quota_limit)`
   (a sor saját, másolt korlátja); `UNIQUE (operation_id)` és `operation_id` FK a `paid_generation_ops`-ra (egy művelet legfeljebb egy slot). A zár megkerülése esetén is 23505 (két író ugyanarra a slotra) és
   23514 (korláton túli slot) védi a keretet.
5. **Idempotencia és atomicitás:** ugyanaz a token → duplikátum a keret érintése **előtt**; összeomlás → a slot és a generáció együtt visszagörgetődik; invariáns: kvótás `free` generáció
   ⇔ pontosan egy slot.
6. **Ágak:** a szerver-kiadott token az előzetes ellenőrzés szerinti ágat köti (`free` / `charged`); a DB újraellenőriz: `free` szándék kimerült keretnél `free_quota_exhausted`; `charged` szándék
   maradék keret mellett `free_quota_available` (**levonás nincs**; a felhasználó ingyen futtathatja újra, explicit kattintással, automatikus újrapróbálás nélkül).
7. **Elutasításkor** a legenerált tartalmat eldobjuk, és a mai `usage_blocked` / megerősítés választ adjuk — nem tranziens ingyenes tartalom, mert az a keretet kijátszhatóvá tenné.
8. **Marad:** az előzetes `checkUsagePermission` tanácsadó szerepben (UX, költségvédelem); a `hardLimitDaily` tanácsadó jellegű marad (nem pénz). **Kompromisszum:** két párhuzamos kérés is elvégezheti a
   drága munkát, az egyik elutasul (költség, nem keretsértés); előzetes foglalás (reservation) opcionális, későbbi tétel.
9. **Átállás: közös számlálás — SZŰKÍTETT állítás.** A mai keret a `youtube_search_logs` sorok száma, az új keret a slotok; a kettő **időben szétválasztva** adódik össze:
   `használt(ablak) = LEGACY + SLOTOK`, ahol `LEGACY` = a legacy használat **rögzített és egyeztetett** darabszáma az ablakban és a `cutover_at` előtt (a `cutover_at` az eszköz átvezetési regiszter-sorának,
   a DB órájával rögzített ideje), `SLOTOK` = a `paid_free_quota_use` sorai az ablakban. Egy `youtube_search_logs` sor akkor számít, ha `user_id` és `feature_name` egyezik, `created_at >= window_start` **és
   `created_at < cutover_at`**; a cutover **után** írt napló-sorok (a `logYouTubeSearch` analitikára megmarad) **nem számítanak**, így egy új futást a napló és a slot **nem számol kétszer**. A régi szabály szerint a
   **minden** futást számoló napló és az új, csak az ingyenes futásokat számoló slot egyenértékű, mert fizetős futás csak a keret elfogyása után van (az első `quota_limit` futás ingyenes).
   **Amit ez állít, és amit NEM:** az átvezetés **nem ad extra ingyenes keretet a rögzített és egyeztetett használathoz képest.** Azt viszont, hogy egyetlen korábbi ingyenes futás sem hiányzik, a naplók
   alapján **nem lehet bizonyítani**, mert a régi út a naplóírás hibáját elnyelheti (`logYouTubeSearch` és `logFreeProductUse` is `.catch(() => {})` mögött fut, a munka **után**).
   - **Az egyeztetett `LEGACY` csak BECSLÉS, amíg a forrás-leképezés nincs igazolva.** Egy `max(...)` szám **nem bizonyíték**: addig nem állítható, hogy az egyes források **pontosan melyik felhasználóhoz,
     eszközhöz és kvótaablakhoz tartozó, egyedi ingyenes futást** jelentenek. A forrásokban **nincs futás-azonosító** (`run_id` / korrelációs azonosító), így a források között nem lehet futásonként párosítani,
     csak összeszámolni. Forrásonként igazolandó: (1) a **felhasználó** (`user_id` mindegyikben megvan); (2) az **eszköz** (`feature_name` ↔ `tool_type` névleképezés — `similar_videos`, `opportunity_engine`;
     a `paid_results` és a legacy gyorsítótár eszköz-oszlopa); (3) az **ablak** (az idő forrása: a `youtube_search_logs.created_at` az **alkalmazás órája**, az `ai_usage_logs.created_at` forrása és a
     `paid_results` időbélyegei igazolandók; az UTC nap és az ISO hét határ egyezése); (4) az **egyediség** (hány sort hagy egy futás: a `logYouTubeSearch` csak valódi, nem gyorsítótárazott keresésnél ír,
     a `logFreeProductUse` csak ingyenes futásnál, a `paid_results` és a legacy gyorsítótár **inputonként** egy sor, tehát input-szintű, nem futás-szintű; kettős írás vagy újrapróbált kérés kettős sort adhat).
     Amíg egy **csak olvasó leképezés-ellenőrzés** (forrásonként, teljes körűen, keresztösszevetéssel) ezt nem igazolta és nem rögzítette, a `LEGACY` **egyeztetési becslés**, és az `enableCutover`
     **nem engedélyezhető** rá támaszkodva.
   - **A hiányzó napló lehetősége.** A régi út a naplóírás hibáját elnyeli, ezért a becslés **nem zárja ki**, hogy egy korábbi ingyenes futás hiányzik, és a források közti `max` sem bizonyítottan alsó
     korlát (egy forrás túlszámolhat, egy másik alulszámolhat). Kezelés: a **határ-igazított cutover** (lent) kiiktatja a függést a régi ablak naplóitól — az első új ablakban nincs legacy használat —, ahol ez
     nem megoldható, a `LEGACY` becslés marad, és a hiányzó futás kockázata **számmal nem korlátozható** (lásd a következő pontot).
   - **Nincs bizonyított felső korlát az extra ingyenes futásra (a korábbi „legfeljebb `quota_limit` extra futás” állítás visszavonva).** A régi út a keretet **ellenőrzés-majd-írás** sorrendben kezelte (a
     `checkUsagePermission` az elején számol, a naplót a végén írja), ezért **párhuzamos régi kérések magát a kvótát is túlléphették**: egy ablakban a **tényleges** korábbi ingyenes használat meghaladhatta a
     `quota_limit`-et, és a hiányzó naplók száma sem korlátozható a limittel. A terv állíthat: a **mért** eltérést (egyeztetési riport) és azt, hogy a határ-igazított cutover az új ablakban kizárja a legacy
     használat átvitelét; **felső korlátot nem**.
   - **Az eltérő forrású felhasználó keretének zárolása TERMÉKDÖNTÉS (D-o), nem automatikus szabály.** A számlálási képlet **nem tartalmaz** hallgatólagos „eltérésnél `használt = quota_limit`” ágat. A
     riport (felhasználók, eszközök, ablakok, az eltérés mértéke) a **termékfelelős elé kerül**, és a döntés külön rögzített: (a) nincs zárolás, a becsült `LEGACY` számít; (b) célzott zárolás a riportban
     megnevezett felhasználókra és ablakra; (c) kézi felülvizsgálat. Zárolás esetén az **explicit, naplózott** `paid_free_quota_override` sorokkal történik (felhasználó, eszköz, ablak, `used_floor`, indok, döntő,
     időpont), nem a képletbe építve; a felhasználónak szóló szöveg kimondja a termékhatást (korábban kap fizetős / megerősítős ágat). **Döntés hiányában nincs zárolás és nincs cutover.**
   - **A határ-igazított átvezetés pontos időzítése.** `B` = az ablakhatár (UTC): a napi keret (`similar_videos`) → minden nap **00:00 UTC** (nyári időben 02:00, téli időben 01:00 magyar idő); a heti keret
     (`opportunity_engine`) → **hétfő 00:00 UTC** (ISO hét, a mai `getStartOfWeekUtc`). Időrend: **`F = B − 15 perc`** a karbantartási rés kezdete (route-váltás és alias; az atomikus-kész route a keretes
     eszközre `tool_not_cutover` / karbantartási választ ad: **nincs fizetős és nincs ingyenes futás**); a váltás előtt indult legacy kérések befejeződési határa `F + 300 s + 120 s = F + 7 perc = B − 8 perc` (a
     platform függvény-időkorlátja és a zár-margó; a 300 s egy **beállítás-pillanatkép**, nem mért futásidő), így az ő naplóik **az előző ablakba** esnek; **`E ≥ B`** az `enableCutover` időpontja, **csak** a
     kapu minden feltételének teljesülése után. Az első slot-használat így az **új** ablakban történik, `LEGACY = 0`. **A kapu bukásának kezelése külön termékdöntés (D-p, lásd lent): a terv nem tekinti hallgatólagosan elfogadottnak a
     karbantartási rés meghosszabbodását, még kevésbé egy akár egyhetes kiesést.** Alapértelmezés: a határidőig a régi forgalom visszaengedése, a következő határra halasztással.
   - **A cutover előtt indult, később befejeződő kérések — és a kvótanapló életciklusa.** A legacy kérés a keretet az **elején** ellenőrzi, a kvótanaplót a **késői szakaszban** írja: a `similar-videos`-ban a
     szolgáltatói keresés és a pontozás **után**, a mentések és a válasz **előtt** (`:790`–`:792`), az `opportunity`-ben a generálás és a követés után (`:974`, `:1014`); mindkét írás `.catch(() => {})` mögött.
     Ezért egy kérés kvótanaplója **a kérés végéig, a függvény indulásától legfeljebb a platform-időkorlátig** (300 s beállítás-pillanatkép, + kill-késés) bármikor keletkezhet. Egy a váltás előtt elindult, utána
     befejeződő kérés naplója a `cutover_at` után kelne, tehát nem számítana — ezért a **`cutover_at` csak a kapu teljesülése után rögzíthető**, és a határ-igazított időzítés a régi kérések naplóit az előző
     ablakba teszi. Ha a kapu közben legacy írót mér, a megfigyelés újraindul. Ha mégis egy legacy kérés a `cutover_at` után fejeződne be (kapu-hiba): a legacy `paid_results`-írást a regiszter-kerítés elutasítja
     (nincs mentett eredmény, a mai mentési hiba ág), a kimaradt napló miatt extra ingyenes futás lehetséges — ezt a kapu **megelőzni** hivatott, a cutover utáni census **detektálja**, de **számmal nem korlátozza**.
   - **A lecsengés mérhető kapu, és alapértelmezetten BLOKKOLT.** Az `enableCutover` (és a `cutover_at` rögzítése) **blokkolt, amíg a kapu minden sora külön bizonyítékkal teljesül**; ha egy sor **nem
     igazolható mérhetően**, a kapu **blokkolt marad**. A kapu sorait és a régi írók / futó telepítések teljes lefedését a következő, „lefedési mátrix” szakasz sorolja fel. A nulla `in_flight_requests` sor és a nulla
     író-jel **önmagában nem bizonyíték** (lásd ott).

#### F4 átállási kapu — a régi írók és a futó telepítések lefedési mátrixa (a kapu alapértelmezetten BLOKKOLT)

**Miért nem elég a nulla `in_flight_requests` sor és a nulla író-jel** (forrásból, `lib/request-lock.ts` és a route-ok): (1) a legacy zár kulcsa **felhasználó-szintű** (`__user_paid_operation__` / `active`), **nincs benne
eszköz-azonosító**, ezért eszközre nem szűrhető, csak globálisan mérhető; (2) a legacy `acquireRequestLock` **fail-open** hiányzó táblára (42P01 / PGRST205: „lock kihagyva”); (3) a `similar-videos`-ban a
zár a **kvóta-ellenőrzés után** jön, tehát az addigi szakasz nem látszik; (4) a következő kérés a lejárt (TTL 420 s) sort törli **még élő kérés alatt is** — a kód megjegyzése szerint ez elfogadott maradék
kockázat; egy összeomlott példány sora a TTL-ig marad; (5) az író-jel **csak a ténylegesen lefedett írókat** méri. Egy hiányzó sor tehát **nem bizonyítja**, hogy nincs régi kérés.

| Író / futó példány | Mit ír (kvótaforrás) | Meddig írhat (életciklus) | Kizárás vagy mérés | Ma igazolható? |
|---|---|---|---|---|
| `similar-videos` route, **régi kiadás** | `logFreeProductUse` (`ai_usage_logs`, csak ingyenes futás), `logYouTubeSearch` (`youtube_search_logs`), `saveSearchResult`, `savePaidResult` | a szolgáltatói keresés és pontozás **után**, a mentések és a válasz **előtt** (`:790`–`:792`), a kérés **végéig**; a függvény indulásától legfeljebb a platform-időkorlátig (300 s beállítás-pillanatkép, + kill-késés); a két napló-írás `.catch(() => {})` mögött | az új kiadás nem tartalmazza (forrás-teszt); a régi kiadást a kódból **nem** lehet kizárni | az új kiadás igen; a régi kiadás futó példányai **nem** |
| `opportunity` route, **régi kiadás** | `logFreeProductUse` (`:974`, ingyenes ág), `logYouTubeSearch` (`:1014`), `paid_results`, snapshot-ok | a generálás és a követés után, a kérés végéig (≤ időkorlát); `.catch(() => {})` | ugyanígy | ugyanígy |
| **Korábbi production telepítések** | ugyanazok a régi route-ok, a production környezeti változókkal | az alias átállítása után is **új kérést indíthatnak**, amíg a telepítés elérhető (saját egyedi URL, skew-védelem rögzített munkamenetek) — a platform viselkedése **igazolandó** | a telepítések **csak olvasó felsorolása**; letiltás / törlés (külön jóváhagyás); **telepítésenkénti kérésszám-napló** (nulla kérés a keretes route-okra a váltás óta) | **nem igazolt**: a platform telepítésenkénti kérés-naplója és a letiltás lehetősége ellenőrizendő |
| Preview telepítések | a Preview környezet DB-je | — | csak olvasó env-hatókör ellenőrzés: a Preview kulcsai nem a production DB-re mutatnak | igazolandó |
| Cron route-ok (`refresh-trends`, `collect-signals`) | a forrásban **nem** írnak kvótaforrást | — | forrás-teszt a hívásokra | igen (forrásból) |
| Operátori szkriptek (`scripts/`), közvetlen service-kulcsos hozzáférés | a forrásban egy szkript sem ír kvótaforrást; a kulcs más kliensekben is lehet | bármikor | a kulcs hatóköre csak olvasó ellenőrzéssel **teljes körűen nem bizonyítható** | **nem teljesen igazolható** |
| Stripe webhook | ledger-írás, **nem** kvótaforrás | — | — | nem releváns |
| Egyéb service-kulcsos kliensek (helyi gép, más eszköz) | bármi | bármikor | a **kulcs-forgatás** az egyetlen kikényszerített kizárás (a régi példányok a régi kulccsal nem írhatnak); súlyos, külön jóváhagyás | opció, nem terv |

**A kapu sorai (mind kell; bármelyik nem igazolható sor → a kapu blokkolt marad):**
1. a mátrix **minden** sorára a **kizárás vagy a mérés** igazolva — a „nem igazolt” sor addig blokkol;
2. a régi kiadás **nem kap forgalmat** — **platform-bizonyítékkal** (telepítésenkénti kérésszám = 0 a keretes route-okra a váltás óta); ez az **elsődleges** bizonyíték;
3. a **globális** aktív legacy zár-sorok száma nulla — **kiegészítő jel**, nem elég;
4. nulla legacy író-jel a váltás óta a megfigyelési idő alatt (az új route nem ír a legacy gyorsítótárba, és nincs generáció nélküli új / módosított `paid_results` sor az eszközre) — **kiegészítő jel**;
5. a végső census nulla maradékot ad (E2);
6. a forrás-leképezés igazolt (lásd fent), és a **D-o** döntés rögzítve;
7. a megfigyelési idő ≥ `300 s + 120 s` — csak **szükséges alsó határ**, nem bizonyíték.
**A kapu bizonyítékai rögzülnek** (időpont, számok, forrás); az `enableCutover` az **órát nem fogadja el bizonyítéknak**, és minden mért jel újraindítja a megfigyelést.

#### D-p — a határ-igazított karbantartás hibaszabálya (KÜLÖN TERMÉKDÖNTÉS, a felhasználóé; nincs döntve)

A kapu bukása **nem** jelenthet hallgatólagosan szolgáltatáskiesést. Ez a szakasz az **előre meghatározott szabályokat** rögzíti, amelyeket a termékfelelősnek jóvá kell hagynia a karbantartási rés előtt; a döntésig a
határ-igazított cutover **nem indítható**. A számszerű paraméterek (`T_gate`, `T_stop_max`) **a termékfelelős döntései**; az alábbi értékek csak **javasolt kiindulások**, nem döntések.

**Fázisok.** `M0` normál (régi út fut; **az előzetes import ebben a fázisban fut**, ezért már lehetnek *ideiglenes* importált generációk) → `M1` rés (`F ≤ t < E`: az atomikus-kész route, a keretes eszköz le van állítva, nincs írás) → `M2` engedélyezve
(`enableCutover` megtörtént, még **nincs** commitolt `linked` vagy `free` generáció; **importált `unlinked_legacy` generáció lehet**, mert az nem levonáshoz kötött és nem akadályozza a visszalépést) → `M3` **csak előre**
(az első commitolt `linked` vagy `free` generáció után). **Pontosítás (2026-10-06):** az `M2` korábbi megfogalmazása („nincs generáció”) az előzetes import mellett önellentmondó volt; a feltétel a **`linked` / `free`**
generáció hiánya, nem bármilyen generációé. A visszaengedés előzetes import után megengedett, de **csak a lenti állapottábla és a szinkronizációs szabályok mellett** (lásd *A visszaengedés az előzetes import után*).

**Paraméterek (a termékfelelős állítja be).** `T_gate` = az ablakhatár (`B`) után eddig az időpontig kell a kapunak teljesülnie (javasolt kiindulás: napi eszköznél `B + 60 perc`, heti eszköznél `B + 4 óra`);
`T_stop_max` = ennél tovább az eszköz **explicit, rögzített döntés nélkül nem maradhat leállítva** (javasolt kiindulás: napi `2 óra`, heti `12 óra`).

**Előre meghatározott szabályok:**
1. **Alapértelmezés a `T_gate`-ig el nem ért kapunál: a régi forgalom visszaengedése** (az előző production telepítés aliasa), és a cutover a **következő ablakhatáron** újraindul — nem kiesés, nem „marad a rés”.
2. **A régi forgalom biztonságosan visszaengedhető, ha MIND teljesül:** (a) `M1` vagy `M2` (a regiszter nincs engedélyezve, vagy engedélyezve van, de **nincs commitolt `linked` / `free` generáció** — csak olvasó
   ellenőrzés; az előzetes importból származó `unlinked_legacy` generáció **nem** akadály, de a visszaengedés után az alábbi állapottábla szerinti követelmények élnek); (b) az előző production telepítés **létezik és ellenőrzötten visszaállítható**; (c) a kapu bukása nem egy olyan **integritás-hibára** utal, amelyet a régi út folytatna; (d) a réskor semmilyen új
   típusú adat nem keletkezett (a rés alatt az atomikus-kész route nem ír). **Következmények a visszaengedés után:** a **bizonyítékok visszaállnak** (a kapu a nulláról indul, a végső census újra kell); az
   **előzetes importtal létrehozott** generáció / vetület párokra a régi író felülírhatott vetületet; ez **nem csendes elavulás**, hanem az állapottábla `S2` állapota: a következő kísérlet előtt a **teljes
   állapot-census** fut (nem csak eltérés-census: `S0`–`S4` darabszámok), az `S2` hatóköröket a `resync`, az `S3` hatóköröket **csak** a bizonyítékos operátori helyreállítás rendezi (az `S3u` blokkolja az eszköz cutover-jét), és az `enableCutover` a zár alatt ellenőrzi (lásd a következő szakaszt); ha a visszaengedés `B` **után** történt, az új ablak már tartalmaz legacy használatot, így a következő kísérlet erre az ablakra **nem építhet
   `LEGACY = 0`-ra** — a következő ablakhatárig vár.
3. **Az eszköz leállítva marad (a régi forgalom NEM engedhető vissza), ha BÁRMELYIK igaz:** a régi úton **ismert vagy gyanított integritás- / pénzügyi hiba** van (pl. dupla levonás kitettség, magyarázat nélkül
   növekvő eltérés); az előző telepítés nem visszaállítható; az `M3` fázisban vagyunk. Ez **incidens**: emberi döntés kell, és a leállítás ideje legfeljebb `T_stop_max`.
4. **`T_stop_max` lejártakor** egy **explicit, rögzített döntés** szükséges (meghosszabbítás indokkal / visszaengedés / más); **hallgatólagos folytatás nincs**.
5. **Az első atomikus generáció után a régi író visszakapcsolása továbbra is tilos** (`M3`): csak előre javítás, vagy az eszköz leállítva tartása — a rollback-tilalom az első commitolt `linked` **vagy `free`** generáció után él.
6. **Naplózás és közlés:** minden fázisváltás, a döntő és az indok naplózott; a felhasználónak szóló karbantartási üzenet kimondja a várható időt, és a visszaengedés / halasztás utáni állapotot.

**Tesztek (DB-mentes, tiszta függvények, beinjektált órával):** a visszaengedés-jogosultság függvény minden feltételre (`M1` / `M2` generáció nélkül → engedett; commitolt `linked` generáció után → tiltott; commitolt
`free` generáció után → tiltott; hiányzó előző telepítés → tiltott; integritás-hiba jel → tiltott); `T_gate` lejártakor az **alapértelmezett akció a visszaengedés** (soha nem „marad a rés”), kivéve a leállítva-tartás
feltételeit; `T_stop_max` lejártakor `decision_required` (a hallgatólagos folytatás elutasított); visszaengedés után a bizonyítékok visszaállnak, és az eltérés-census kötelező; `B` utáni visszaengedés után a
következő kísérlet erre az ablakra nem épít `LEGACY = 0`-ra; `M3`-ban a régi író visszakapcsolása elutasított; a rollback-tilalom a `free` generációra is él (a modell kódlépésében).

**Átállási és zár-hatókör tesztek (terv):** `LEGACY = 2` régi napló-sor + 1 slot, `quota_limit = 3` → pontosan 0 ingyenes futás marad (a harmadik is elfogyott), `LEGACY = 2` + 0 slot → 1 marad;
a `cutover_at` **utáni** napló-sorok nem számítanak (egy új futás napló-sora + slotja nem kétszeres felhasználás); a határon (`created_at = cutover_at`) a sor **nem** számít (szigorú `<`); az ablak
elé eső napló-sor nem számít; a cutoveren átnyúló hét: a cutover előtti, a hétbe eső sorok számítanak; a korlát módosítása az ablak közben (csökkentve: a meglévő slotok érvényesek, új nem jön; növelve: új
slot jön a korlátig); ugyanaz a token újrajátszva nem fogyaszt; **zár-hatókör:** két különböző felhasználó `free` commitja **nem várakozik egymásra** (a quota-zár kulcsa különbözik, az eszköz-zár
megosztott — a holtpont-szimulátor és a zár-napló bizonyítja), ugyanazon felhasználó két eszköze / két ablaka sem, ugyanazon (felhasználó, eszköz, ablak) kérései sorosodnak; az `enableCutover` /
`rollbackCutover` (kizárólagos eszköz-zár) megvárja a futó megosztott zárakat és fordítva.

**Átállási kapu tesztek (terv):** a kapu **mindegyik** sorára külön teszt: a mátrix egy „nem igazolt” sora → **blokkolt** (a kapu alapértelmezése blokkolt, és a mutáció, amely „igazolt”-ra állítja a
bizonyíték nélküli sort, elbukik); régi telepítés kap kérést → elutasít; aktív legacy zár ≥ 1 → elutasít; **nulla zár és nulla író-jel, de nincs platform-bizonyíték (2. sor) → elutasít** (a kiegészítő jelek
önmagukban nem engednek); egy legacy író-jel a megfigyelési idő közben → a megfigyelés újraindul; csak az idő letelte → elutasít; a leképezés-ellenőrzés vagy a D-o hiánya → elutasít; minden sor teljesül →
engedélyez; az `enableCutover` az **órát nem fogadja el bizonyítéknak**. *Számlálás:* a források eltérése → **nincs** automatikus zárolás (a képletben nincs ilyen ág, forrás-teszt), a riport a D-o döntésre vár;
zárolás csak explicit `paid_free_quota_override` sorral, amely naplózott és a felhasználónak szóló szöveg a termékhatást kimondja; **nincs bizonyított felső korlát** állítás a tervben és a jelentésekben (forrás-teszt a
tiltott megfogalmazásra: „legfeljebb `quota_limit` extra”, „így nincs extra keret” bizonyítás nélkül); a régi, párhuzamos kérésekkel túllépett kvóta: egy ablak `használt > quota_limit` esetén `free_quota_exhausted`
(nem negatív maradék). *Időzítés:* az `F`, `E` és `B` időpontok kiszámítása nap- és hétre, nyári / téli időszámítás-váltás napján is (UTC-ben, a magyar idő csak megjelenítés); `E < B` esetén az `enableCutover`
elutasít; a rés alatt az atomikus-kész route a keretes eszközre `tool_not_cutover` / karbantartási választ ad, és sem ingyenes, sem fizetős futást nem indít. *Régi kérés:* a váltás előtt indult, utána befejeződő
legacy kérés: a naplója az előző ablakba esik; kapu nélkül (mutáció) a naplója kimarad és extra ingyenes futás jön létre, a kapuval a megjelenő kérés beszámít. A felhasználónak szóló szövegek és a jelentések a
keretről **csak** a „rögzített és egyeztetett használathoz képest” szűkített állítást használhatják.

**Versenytesztek (terv):** *modell* — `L + 2` párhuzamos `free` commit **minden sorrendben**: pontosan `L` sikeres, a többi `free_quota_exhausted`; ugyanaz a token kétszer → egy slot; összeomlás minden
lépésnél → nincs slot generáció nélkül és fordítva; ablakhatár (23:59:59.9 / 00:00:00.1, vasárnap / hétfő) **egyetlen DB-órával**; a korlát nem a hívótól jön; felhasználók és eszközök függetlenek;
`charged` szándék maradék keret mellett → `free_quota_available`; tombstone nem fogyaszt; átmeneti beszámítás. *Valódi DB (külön jóváhagyás)* — ≥ 2 kapcsolat korlátozó zárral ugyanarra az
ablakra; közvetlen slot-beszúrás a zár megkerülésével → 23505 és 23514; az ablak-számítás időzónától független (UTC kikényszerítve); teljesítmény.

#### A visszaengedés az előzetes import után (M2, állapottábla, újra-cutover) — TERV, 2026-10-06

**Válasz a kérdésre: igen, a legacy író visszaengedhető, ha még nincs `linked` / `free` generáció — de a feltétel nem „generáció nélkül”, és a visszaengedés után a megszorítások élnek.**
Az előzetes import (P-2) `unlinked_legacy` generációt és vetületet hozhat létre `M0`-ban, még az `enableCutover` előtt. Ez a generáció nem levonáshoz kötött, nincs üzleti jóváírása, a rollback-tilalom
(`linked` / `free`) nem vonatkozik rá; a visszaengedés ezért nem tiltott. **A legacy író írását viszont nem lehet megakadályozni**, amíg az eszköz nincs átvezetve (a `paid_results` invariáns-trigger csak átvezetett
eszközön véd). Ha a régi író az importált hatókörben ment (`savePaidResult` upsert), az importált generáció **felülírt, történeti pillanatkép** lesz. Ez **nem csendes elavulás**, mert (1) átvezetetlen eszközön a legacy út
a `paid_results` sorból szolgál, a generációt **nem** olvassa — a felhasználó a friss eredményt kapja; (2) az eltérés **DB-ből, pontosan** kimutatható (a vetület hordozott mezői vs. a legnagyobb generáció pillanatképe); (3) az
`enableCutover` az eltérést a zár alatt újraellenőrzi, és eltérő hatókör mellett **elutasít**; (4) átvezetés után a trigger az eltérés keletkezését kizárja.

**Hatókör-állapotok** (egy (felhasználó, eszköz, `input_hash`) hatókörre; a „vetület” a `paid_results` sor):

| Állapot | Meghatározás | Kiszolgálás átvezetés előtt | Átvezetés után (ha így marad) |
|---|---|---|---|
| `S0` `cache_only` | `completed` legacy-cache sor, nincs generáció, nincs `paid_results` sor | legacy út | `unverified` (`legacy_unreconciled`), fail-closed, nincs levonás |
| `S1` `imported_unchanged` | van generáció (legnagyobb: `legacy_cache_import` vagy `legacy_resync`), a vetület `completed`, és a hordozott mezői **egyeznek** a pillanatképpel | legacy út (a vetületből) | `found` |
| `S2` `imported_diverged` | van generáció, a vetület `completed`, de **eltér** a legnagyobb generáció pillanatképétől (legacy upsert az import után) | legacy út (a friss vetületből) | `unverified` (`projection_diverged`), fail-closed |
| `S3u` `projection_missing_unknown` | van generáció, a vetület **két eltérő fizikai állapot egyikében van — `S3u-m`: a sor hiányzik; `S3u-n`: a sor létezik, de a `status` nem `completed`** (a két eset helyreállítása **különbözik**, lásd *Az `S3` két fizikai állapota*) —, és **nincs** érvényes, bizonyított szándékos eltávolítás-bizonyíték (ismeretlen eredetű hiány — **ez az alapértelmezett**, mert ma egyetlen bizonyíték-forrás sincs) | legacy út (nincs találat; a legacy kód ilyenkor új generálásként kezeli, és **nem tudja**, volt-e korábbi levonás — `LR-1`, a terv ezt **nem** akadályozhatja meg, csak jelzi) | `unverified` (`projection_missing_unknown`), fail-closed: **nincs kiszolgálás, nincs levonás, nincs automatikus `reproject`**; az eszköz cutover-je **blokkolt** az egyeztetésig |
| `S3i` `projection_removed_proven` | mint `S3u` (ugyanaz a két fizikai állapot: `S3i-m`, `S3i-n`), de **bizonyított szándékos** eltávolítás-bizonyíték áll fenn (lásd *Az `S3` szétválasztása*) | legacy út (nincs találat) | `unverified` (`projection_removed_proven`), fail-closed: nincs kiszolgálás, nincs levonás, nincs automatikus `reproject`; **a cutovert is blokkolja** (`removal_behavior_undecided`), amíg a **D-q2** nincs eldöntve és a teljes GET / POST / `force_refresh` / dashboard út ismert és tesztelt (lásd *Az `S3i` cutover-késszége*) |
| `S4` `legacy_only` | van `paid_results` sor, **nincs** generáció (implicit 1. generáció) | legacy út | `found` (a copy-on-first-refresh szabállyal) |

**Események és átmenetek (átvezetés előtt, `M0` / `M1` / visszaengedés után):**

| Innen | Esemény | Ide | Megjegyzés |
|---|---|---|---|
| `S0` | import RPC (jegy nélkül, nyitott import-ablakkal) | `S1` | egy tranzakció: generáció + vetület + művelet-sor |
| `S0` | legacy upsert a `paid_results`-ba | `S4` | az E1 sor nyer; a cache-sor mellékes, a későbbi import `scope_not_empty` |
| `S1` | legacy upsert (más tartalom) | `S2` | a visszaengedett régi író tipikus hatása |
| `S1` | legacy upsert (bájtra azonos hordozott mezők) | `S1` | no-op a digest szerint |
| `S1` / `S2` | legacy törlés / archiválás | `S3u` (vagy `S3i`, ha az eltávolítás-bizonyíték érvényes) | alapértelmezés: **ismeretlen eredetű**; az osztályt csak a bizonyíték-sor emeli `S3i`-re, utólag semmilyen állítás nem |
| `S2` | `resync` (lent) | `S1` | **új** generáció (N+1, `unlinked_legacy`, `origin = legacy_resync`) a **jelenlegi** vetületből; a régi generáció változatlan |
| `S3u` / `S3i` | legacy upsert | `S1` vagy `S2` | a digest dönt; az eltávolítás-bizonyíték megmarad (történet) |
| `S3u` | **bizonyítékkal és audittal** végrehajtott operátori helyreállítás (lásd *Az `S3` szétválasztása*): `classify_removal` (osztályozás), `S3u-m` esetén `reproject_missing`, `S3u-n` esetén `restore_status` | `S3i` / `S1` | **soha automatikus**; jegy + bizonyíték + audit nélkül nincs átmenet; a két helyreállítás **fizikai állapot szerint külön** függvény / ág |
| `S3i-m` / `S3i-n` | `reproject_missing` / `restore_status` — **D-q2 döntéséig fail-closed (`recovery_policy_undecided`, nincs INSERT / UPDATE)**; döntés után **csak** az érintett felhasználó **azonosítható, új** visszaállítási kérésével (`user_request_required` nélküle) | `S1` | **soha automatikus**; **operátori jegy és audit önmagában nem jogosít fel** a tartalom visszaállítására; igazolt operátori tévedés sem |
| bármely | import RPC, ha generáció vagy vetület létezik | változatlan | `scope_not_empty` (E3: a meglévő nyer) |
| bármely | visszaengedés / `rollbackCutover` | változatlan | a rollback nem ír generációt és vetületet |
| bármely | `enableCutover` | — | csak ha az eszközre **nincs** `S2`, **nincs** `S3u` és **nincs** `S3i` (DB-ből, a zár alatt; az `S3i` is blokkol, amíg a D-q2 nincs eldöntve és az út nincs tesztelve); az `S0` DB-ből **nem** ellenőrizhető (a cache-kulcs alkalmazás-oldali hash), ezért a végső census + a lefedési mátrix kapu bizonyítja; a kimaradt `S0` átvezetés után fail-closed |

**`resync` — célzott operátori függvény (nem import, nem általános újranyitás).** Ugyanaz a gépezet, mint a `reconcile_legacy_cache_generation`: egyszer használatos jegy pontos hatókörre, kísérlet-sor
(`started` / `outcome_unknown` / `fenced` állapotgép), három külön audit-út, nem exponált séma, operátor szerepkör, zárak **eszköz (megosztott) → hatókör**, a döntés a zár **után** újraolvasott adatból.
(1) Csak **`S2`** hatókörre fut (más állapotban strukturált elutasítás: `not_diverged`, `projection_missing_unknown`, `projection_removed_proven` — az `S3` hatókört a `resync` **soha** nem javítja); (2) csak akkor, ha a regiszterben az eszköz **nincs engedélyezve**; (3) **csak INSERT**: egyetlen új generációs
sor (`generation = max + 1`, a `UNIQUE (user_id, tool_type, input_hash, generation)` a háttérvédelem), a vetületet **nem** írja (már egyezik az új pillanatképpel), `ON CONFLICT` / UPDATE / DELETE nincs (forrás-teszt);
(4) **a `resync` generáció sosem levonáshoz kötött és sosem állít fizetést:** `charge_link = 'unlinked_legacy'`, `credit_cost_evidence = 'legacy_unverified'`, `origin = 'legacy_resync'`, `credit_transaction_id IS NULL`, `payment_evidence` **nem** `ledger_linked`;
a jelölést a függvény **ága** állítja (nem a hívó, nem a vetület `credit_cost` értéke), és a DB-megszorítások (1–3. mechanizmus) védik; a pillanatképben a legacy `credit_cost` **leíró metaadat**, soha nem bizonyíték
(a címke „ismeretlen”, a válasz és a dashboard nem mond „fizetős”-t); semmilyen üzleti jóváírás, semmilyen `gop:` ledger-sor; a legacy upsert mögötti `spend:` levonás **legacy árva levonás** marad
(`operator_credit_uncertain`, kézi döntés), a `resync` **nem** köti hozzá.

**Az `S3` szétválasztása: bizonyítottan szándékos eltávolítás ≠ ismeretlen eredetű hiány (D-q javasolt iránya, 2026-10-06; a felhasználó döntési iránya, megvalósítás nincs).**
*Forrásból igazolt tények:* az `app/` és `lib/` alatt **egyetlen** kód sem töröl vagy archivál `paid_results` sort (a `savePaidResult` mindig `completed`-et ír, az `openPaidResult` csak `last_opened_at`-et); a `service_role`-nak a 044 szerint
van `DELETE` joga a táblán; a `user_id` `ON DELETE CASCADE` (019:9). Tehát egy `S3` ma **csak** közvetlen DB-/service-kulcsos beavatkozásból vagy fiók-kaszkádból keletkezhet, és **ma nincs semmilyen bizonyíték-forrás**, amely a szándékot igazolná.
Ebből következik: **minden mai `S3` `S3u` (ismeretlen eredetű)**; az `S3i` csak a lent tervezett bizonyíték-sorral jöhet létre. (Fiók-kaszkád: a generációs tábla `user_id`-je ugyanígy kaszkádol — a kaszkád mindkét oldalt törli, ezért **nem** `S3`; ez a tervezett táblákra követelmény, valódi DB-n igazolandó.)
- **Szabály (alap):** `S3` esetén **nincs automatikus `reproject`**, **nincs kiszolgálás** (sem a generációból, sem a gyorsítótárból), **nincs levonás** (a nyitó függvény `unverified`-et ad, a commit a hatókörre nem fut), és **nincs automatikus osztályozás**: az osztályt a bizonyíték dönti, nem a hiány puszta ténye.
- **Eltávolítás-bizonyíték (terv):** a regiszterben szereplő (akár még nem engedélyezett) eszköz `paid_results` soraira egy `BEFORE DELETE` és `BEFORE UPDATE` (státusz `completed`-ről másra váltás) trigger **egy tranzakcióban** rögzíti a tényrögzítő sort
  (`paid_removal_evidence`: hatókör, az OLD sor digestje, `session_user` / `current_user`, tranzakcióazonosító, időpont, `intent_basis`). A `intent_basis` **alapértelmezése NULL (ismeretlen)**; értéke csak akkor `operator_ticket`, ha a trigger a **törlés előtt** létrehozott, lejáratlan, fel nem használt
  `paid_removal_intent` jegyet talál pontosan erre a hatókörre és az OLD digestre (a jegy létrehozása: operátor szerepkör, ticket + indok + jóváhagyó ≠ létrehozó; a trigger a jegyet ugyanabban a tranzakcióban felhasználtnak jelöli). Egy **jövőbeli, hitelesített felhasználói törlési út** `user_request_ref`-et adhatna; ilyen út ma nincs, a terv nem
  feltételezi. A trigger a tényt rögzíti, a **szándékot nem találja ki**: jegy nélküli törlés (SQL-konzol, service-kulcs) bizonyított *eltávolítás*, de **ismeretlen szándék** → `S3u`. A bizonyíték-sor változtathatatlan, jogosultsággal védett; a megkerülő szerepkörök (`session_replication_role`, owner, superuser) **dokumentált maradék**, és a trigger **előtt** keletkezett hiányra nincs bizonyíték.
- **`S3i` érvényessége (a zár alatt, friss olvasással):** van `paid_removal_evidence` sor, `intent_basis ∈ {operator_ticket, user_request_ref}`, a felhasznált jegy audit-sora sikeres, **és** az OLD digest egyezik a legnagyobb generáció pillanatképének digestjével (a bizonyíték arra a tartalomra vonatkozik, amelyet a generáció hordoz). Bármelyik hiány → `S3u`.
- **Cutover-hatás:** `S3u` **blokkolja az adott eszköz** cutover-jét (`enableCutover` → `unreconciled_removal`, írás nélkül; más eszközt nem érint) az egyeztetésig. **Az `S3i` sem cutover-kész** (`removal_behavior_undecided`), amíg a D-q2 nincs eldöntve és a lent leírt teljes út nincs tesztelve (*Az `S3i` cutover-késszége*) — a korábbi „az `S3i` nem blokkol” megfogalmazás **visszavonva**. Az egyeztetés **csak** a lenti operátori helyreállítással történhet, és eredménye vagy `S3i` (osztályozás: még mindig blokkol), vagy (visszaállítás után) `S1`.
- **Operátori helyreállítás — csak bizonyítékkal és audittal (a `reconcile_legacy_cache_generation` / `resync` gépezete: egyszer használatos jegy pontos hatókörre, kísérlet-sor `started` / `outcome_unknown` / `fenced` állapotgéppel, három külön audit-út, nem exponált séma, operátor szerepkör, zárak eszköz (megosztott) → hatókör, zár utáni friss olvasás, jóváhagyó ≠ létrehozó **kötelező**):**
  (a) `classify_removal` — **csak bizonyíték-kiegészítés**, írás a vetületre nincs: a jegy hordozza az **ismert szándék forrását** (pl. dokumentált felhasználói kérés azonosítója, vagy az incidens-azonosító, amely a törlést elrendelte), a függvény a bizonyíték-sort **kiegészítő sorral** (nem módosítással) `intent_basis = operator_ticket`-re emeli, ha az OLD digest egyezik a generációéval; egyezés híján elutasít (`digest_mismatch`);
  (b) **a vetület helyreállítása a fizikai állapot szerint két külön ág** (az „egy INSERT” **csak** a hiányzó sorra igaz; lásd *Az `S3` két fizikai állapota*): `reproject_missing` az `-m`, `restore_status` az `-n` állapotra; **csak** ha a jegy az indokot rögzíti: `S3u`-nál `user_restore_request` vagy `operator_error_confirmed`; **`S3i`-nél a feltételek szigorúbbak és kétrétegűek** (lásd *Az `S3i` helyreállítása*): (1) **D-q2 döntéséig fail-closed** (`recovery_policy_undecided`), (2) döntés után **kizárólag** az érintett felhasználó azonosítható, új kérésével (`user_restore_request`); az operátori jegy és az audit **önmagában nem jogosít fel** — egy bizonyítottan szándékos törlést **az operátor egyedül sem** állít vissza;
  (c) mindkettő **elutasít**, ha bármilyen automatikus indok (időzítő, cron, a hiány puszta ténye) az egyetlen forrás; **kísérlet-sor nélkül nem fut**; a kimenet-bizonytalan kísérlet `outcome_unknown` marad, a kerítés a fenti izolációs szabállyal; sikeres audit a vetületi írással **ugyanabban** a tranzakcióban.

**Az `S3` két fizikai állapota — külön, fail-closed helyreállítási szabály (2026-10-06).** A helyreállítás **minden fázisban** futhat (az eszköz engedélyezettsége nem feltétel: a művelet a vetületet a legnagyobb generációhoz igazítja), a zárak eszköz (megosztott) → hatókör, a döntés a zár **után**, friss olvasással; az `isolation_level_not_supported`-őr itt is él.
- **`reproject_missing` (`S3-m`: a `paid_results` sor hiányzik) — egy INSERT, **az eredeti `id`-val**.** *Az eredeti `paidResultId` megőrzése (a korábbi linkek nem változnak):* (1) a generációs tábla a hatókör vetület-sorának azonosítóját **a létrehozáskor rögzíti** (`projection_row_id uuid NOT NULL`, változtathatatlan; az import és a commit ugyanabban a tranzakcióban írja a sorral, amelyiknek az `id`-ját rögzíti; a generációs tábla **új**, így nincs id nélküli generáció — a megszorítás és a migráció valódi DB-n igazolandó); egy hatókör minden generációjában **ugyanaz** az érték (`CHECK` / trigger: egyezik az előző generációéval), a `resync` és a commit az **új** generációban ugyanezt az azonosítót másolja; (2) az eltávolítás-bizonyíték sor az **OLD `id`-t** is rögzíti; (3) a helyreállítás az INSERT-et **explicit `id = projection_row_id`**-val végzi, és **csak akkor**, ha a bizonyíték OLD `id`-ja (ha van) **egyezik** a generációéval — eltérés → `row_id_mismatch`, írás nélkül; (4) ütközés (ugyanez az `id` már létezik, akár másik hatókörben, akár ugyanabban) → 23505, a tranzakció visszagörgetődik, **fail-closed** (új `id`-t **soha** nem generálunk helyette: az megváltoztatná a korábbi linkeket); (5) az INSERT a hordozott mezőket a legnagyobb generáció pillanatképéből veszi (bájtra azonos), `status = completed`; az **identitás-mezők** (`id`, `user_id`, `tool_type`, `input_hash`) a generációból / hatókörből jönnek, a **szándékosan módosítható** mezők (pl. `last_opened_at`, megnyitás-számláló) **nem rekonstruálhatók**, alapértékre állnak, és ez a naplóban rögzített, dokumentált veszteség; (6) az 019-es migráció szerint **nincs** adatbázis-szintű idegen kulcs a `paid_results.id`-ra (a hivatkozások kliens-oldali linkek / `paid_result_id` paraméterek), ezért az `id` megőrzése elég a linkek épségéhez; ezt a valódi DB-n a `pg_constraint` katalógussal **újra igazolni kell** (ha lenne ilyen hivatkozó tábla, amely a törléskor kaszkádolt vagy nullázódott, a helyreállítás azt **nem** állítja vissza, és a dokumentáció ezt kimondja).
- **`restore_status` (`S3-n`: a sor létezik, de nem `completed`) — nem INSERT, hanem feltételes UPDATE; az INSERT itt ütköznék a meglévő sorral (PK és `(user_id, tool_type, input_hash)` egyedi index).** Az `id` ilyenkor **eleve változatlan**, így a linkek épek. A meglévő sor tartalma **ismeretlen eredetű** lehet (ma a kód csak `completed`-et ír, tehát egy `failed` / `refreshed` / `archived` sor is out-of-band), ezért: (1) **előkép-rögzítés:** a sor teljes előképének digestje és pillanatképe a kísérlet audit-sorába kerül **ugyanabban a tranzakcióban**, a módosítás **előtt**; (2) **identitás-ellenőrzés:** a sor `id`, `user_id`, `tool_type`, `input_hash` mezői egyeznek a generációban rögzítettel (`projection_row_id` stb.), különben `row_identity_mismatch`; (3) **tartalom-ellenőrzés:** a sor **hordozott mezői bájtra egyeznek** a legnagyobb generáció pillanatképével — **csak a `status` tér el**; ha **bármely hordozott mező is eltér**, a helyreállítás **elutasít** (`row_content_diverged`), a hatókör `S3u` marad (blokkol), és **semmi nem íródik felül** (egy eltérő tartalmú, nem `completed` sor lehet szándékos archívum vagy más eredmény — felülírása adatvesztés; kézi, külön emberi döntés és külön, ma nem tervezett függvény kellene); (4) **feltételes (CAS) írás:** `UPDATE … SET status = 'completed' WHERE id = <rögzített> AND status = <megfigyelt> AND <előkép-digest egyezik>` — 0 érintett sor → `concurrent_change`, a tranzakció commitol, **írás nélkül**; (5) **csak a `status` íródik** (a hordozott mezők már egyeznek, a módosítható mezők megmaradnak); (6) az `UPDATE` az eltávolítás-bizonyíték trigger `BEFORE UPDATE` ágát **nem** váltja ki hamisan (`completed`-re váltás nem eltávolítás), az invariáns-trigger átengedi (a tartalom a legnagyobb generációval azonos).
- **Közös fail-closed szabály:** bármely előfeltétel sérülése (hiányzó vagy ellentmondó bizonyíték, id-eltérés, tartalom-eltérés, időtúllépés, ismeretlen hiba) → a hatókör **`S3u` / `S3i` marad**, a cutover blokkolt, nincs írás, nincs levonás, nincs kiszolgálás; bizonytalan kimenet → `outcome_unknown` és kerítés (a fenti állapotgép). A helyreállítás a `legacy_resync` generációt **nem** érinti, és **új generációt nem ír**.

**Az `S3i` helyreállítása — kétrétegű fail-closed szabály (2026-10-06, harmadik kör).** A `reproject_missing` és a `restore_status` **`S3i` hatókörön** (`-m` és `-n` egyaránt) csak akkor ír (INSERT / UPDATE), ha **mindkét** réteg teljesül; bármelyik hiánya → strukturált elutasítás, **nincs INSERT, nincs UPDATE**, a hatókör `S3i` marad:
1. **Politika-réteg (D-q2 előtt zárt).** A függvény a zár **után**, friss olvasással keresi a rögzített D-q2 döntést (`paid_removal_policy`: döntés-azonosító, döntő, időpont, érték: (α) vagy (β), és hogy engedélyezett-e a felhasználói kérésre történő visszaállítás). **Döntés hiányában** `recovery_policy_undecided`. A zárt kapu **nem függ** a jegytől, az auditról vagy a felhasználói kéréstől: azok **nem** nyitják meg. (A modellben a D-q2 nincs kódolva: konstans „nincs döntve”.)
2. **Kérés-réteg (D-q2 után).** **Operátori jegy és audit önmagában nem jogosít fel a tartalom visszaállítására.** Az `S3i` hatókör visszaállításához az **érintett felhasználó azonosítható, új kérése** szükséges (`paid_user_restore_request`), amelyet a függvény a zár **után**, friss olvasással ellenőriz: (a) a kérés `user_id`-ja **egyezik** a hatókör `user_id`-jával, és pontosan erre a (felhasználó, eszköz, `input_hash`) hatókörre szól; (b) a kérés **új**: `requested_at` **későbbi**, mint az eltávolítás-bizonyíték ideje (egy korábbi, a törlést megelőző vagy azt kiváltó kérés nem érvényes); (c) a kérés **azonosítható**: a kérelmező személyazonosságát a megvalósításnál meghatározott, **az operátortól független** csatorna igazolja (hitelesített felhasználói kérés a jövőbeli app-úton, vagy támogatási jegy ellenőrzött azonosítással) — az `identity_verified_by` mező kitöltött, és **≠** a jegy létrehozója és ≠ a végrehajtó operátor; (d) egyszer használatos és lejáratlan (`used_at IS NULL`); a felhasználását a függvény ugyanabban a tranzakcióban jelöli; (e) a jegy a kérés azonosítójára hivatkozik. Bármelyik hiány → `user_request_required` (hiányzik) vagy `user_request_invalid:<ok>` (eltérő felhasználó / hatókör, nem új, nem azonosított, felhasznált, lejárt).
3. **A két réteg mellett a fizikai ág szabályai is élnek** (id-megőrzés, előkép-audit, tartalom-eltérés elutasítása). `S3u`-ra ez a kétrétegű szabály **nem** vonatkozik (ott az `operator_error_confirmed` indok megengedett), de ha az osztályozás (`classify_removal`) később `S3i`-re emeli, onnantól ez érvényes.

**Az `S3i` cutover-késszége (2026-10-06; a D-q2 még nincs eldöntve → az `S3i` NEM cutover-kész).** Az `S3i` csak akkor válhat nem blokkoló állapottá, ha **mind** teljesül: (1) a **D-q2** döntés rögzítve (az `S3i` hatókör átvezetés utáni viselkedése: **(α)** marad `unverified`, új futás nincs, vagy **(β)** jegyes `retire_scope` a felhasználó explicit kérésére új futást enged); (2) az **alábbi útmátrix minden sora** ismert és **három szinten tesztelt**; (3) a valódi-DB igazolás (izolált teszt-DB, külön jóváhagyás). Amíg ez nincs, az `enableCutover` az `S3i`-re is `removal_behavior_undecided`-del elutasít. *A követelmény (mindkét D-q2 ágra):* **egy régi azonosító vagy egy új fizetős kérés sem kerülheti meg a szándékos eltávolítást, és semmilyen út nem indíthat hallgatólagos levonást**.

| Út | Mai kapcsolódás (forrásból) | `S3i` (és `S3u`) hatókörön elvárt viselkedés (D-q2 előtt: a fail-closed alap) | Nem történhet |
|---|---|---|---|
| **GET újranyitás régi `paidResultId`-val** | `getPaidResultById`, 21 route-hely (A / B / C osztály) | a nyitó függvény `unverified` (`projection_removed_proven` / `projection_missing_unknown`); a route 4xx / 5xx-megállás, **nem** `not_found`-ra képezett cache-miss | kiszolgálás a generációból vagy a gyorsítótárból; a hibának hiányra képezése; a C osztály (hiba / fallback ág) levonásig jutása |
| **GET hash szerint** | `getPaidResultByHash`, 16 hely (D-h) | ugyanaz a verdikt, ugyanabban a pillanatképben | a hash-út kerülő út a nyitó kapu körül |
| **POST új fizetős kérés** (szándék-token kérés / commit) | token kiadás, commit; a státusz soha nem ad tokent | a token-kiadás **és** a commit a hatókörre `scope_removed` / `scope_removed_unreconciled` strukturált elutasítást ad **a zárak után, a levonás előtt**; **(β)** ágban csak a `retire_scope` utáni, az **explicit felhasználói kérést** hordozó út enged futást | token kiadás; `gop:` levonás; új generáció; vetület-írás (a copy-on-first-refresh **nem** hozhat létre sort `S3` hatókörben) |
| **`force_refresh`** | a route-paraméter a gyorsítótárat megkerüli és a fizetős ágra visz | **ugyanaz, mint a POST**: a paraméter nem kerüli meg a hatókör-állapotot; `S3` hatókörben nem enged tokent és levonást | a gyorsítótár-megkerülés levonáshoz vezet a nyitó kapu nélkül |
| **PATCH / egyéb módosító utak** (`last_opened_at`, megnyitás-számláló) | `openPaidResult` csak `last_opened_at` | hiányzó sorra nincs hatás, nem hoz létre sort; nem `completed` sorra nem ír | sor létrehozása vagy `status` módosítása |
| **Dashboard-lista és összegzés** | `app/api/dashboard/summary/route.ts` (közvetlen olvasás, D-l = (B) + (C)) | az `S3` hatókör **nem jelenik meg** kiszolgálható előzményként (sem a generációból, sem a gyorsítótárból), és címkét sem kap fizetősként; hiba esetén hiba, nem üres lista | előzmény-elem a törölt eredményből; „fizetős” / „ingyenes” címke a `credit_cost`-ból |
| **Státusz-hívás** | csak olvasó, nem ad tokent | a verdikt `scope_removed*` / `unverified`; a `not_visible` nem bizonyítja a levonás hiányát | token; bármilyen írás |
| **Legacy út átvezetés előtt** | a legacy kód hiányzó sorra új generálásként reagál, és nem tudja, volt-e korábbi levonás (`LR-1`) | **nem kezelhető ezzel a tervvel** (a legacy kód nem módosul); ez az `S3` további oka, hogy az eszköz **nem** vezethető át az egyeztetés előtt | — |

**Tesztek az útmátrixra (terv; a modell nem bizonyítja a route- és PostgreSQL-viselkedést):** *(1) modell (DB-mentes):* minden sor × `{S3u-m, S3u-n, S3i-m, S3i-n}` négyes: nincs kiszolgálás, a ledger-sorok száma változatlan, nincs új generáció, nincs vetület-írás / -létrehozás, a strukturált kód az elvárt; mutációk: a commit a hatókör-állapotot a zár **előtt** olvassa → elbukik; a `force_refresh` megkerüli az állapotot → elbukik; a copy-on-first-refresh sort hoz létre `S3`-ban → elbukik; a nyitó függvény a hiányt `not_found`-ra képezi → elbukik. *(2) route (DB-mentes, mockolt szolgáltatási réteg, a meglévő minta szerint):* a 21 + 16 olvasó-hely, a token / commit utak és a `force_refresh` utak az `S3` verdiktre: a státuszkód és a törzs `unverified` / `scope_removed*`, **egyetlen** levonás-, szolgáltatói- vagy zárhívás sem fut; a **forrás-teszt** a teljes belépési pont-leltárra (minden `getPaidResultById` / `getPaidResultByHash` / token / commit / `force_refresh` hely **szerepelnie kell a mátrixban**; egy új vagy elmaradt hely elbuktatja a tesztet). *(3) dashboard (DB-mentes):* a lista és az összegzés `S3` hatókörre: nincs elem, nincs címke, hiba esetén hiba. *(4) valódi DB (külön jóváhagyás, előbb izolált teszt-DB):* a nyitó függvény és a commit verdiktje valódi pillanatképpel, a trigger, az `-m` / `-n` fizikai állapotok. Amíg a (1)–(3) nem zöld **és** a D-q2 nincs eldöntve, az `S3i` blokkol.
- **Nyitott (D-q2):** az `S3i` hatókör **átvezetés utáni** viselkedése — (α) marad `unverified` / (β) jegyes `retire_scope` — **alapértelmezés: fail-closed `unverified`, és a kapu az `S3i`-t is blokkolja**; a kapu csak a döntés és az útmátrix-tesztek után enged.

**Szinkronizáció: a legacy upsert nem fut el az import / resync / enable mellett.** A `paid_results` invariáns-trigger (B2) a regiszter olvasása **előtt** megszerzi az eszköz-zárat **megosztott** módban, majd a hatókör-zárat
(rend: eszköz → hatókör, a commit rendjének részhalmaza), és csak ezután, **külön utasításokban** olvassa a regisztert és a generációkat (lásd *Tranzakcióizoláció és zár utáni friss olvasás*). Következmény:
- legacy upsert és import ugyanarra a hatókörre: vagy az upsert előz (az import `scope_not_empty`, `S4`), vagy az import (az upsert utána `S2` / `S1` — kimutatható, nem csendes);
- legacy upsert és `resync`: a `resync` a hatókör-zár **után** olvassa a vetületet, így vagy a friss vetületet pillanatképezi, vagy az upsert utána jön (`S2` újra — a következő census látja);
- legacy upsert és `enableCutover` (kizárólagos eszköz-zár): az `enableCutover` megvárja a futó upsertet, és a zár után ellenőriz; egy utána induló upsert a zárat megvárja, látja az engedélyezett regisztert,
  és az invariáns elutasítja — **nem keletkezhet `S2` az ellenőrzés után**;
- a trigger `lock_timeout`-tal fut: a karbantartási résben (a kizárólagos zár alatt) a legacy mentés időtúllépéssel elbukhat; ez `M1`-ben (nincs forgalom) elfogadott, `M0`-ban a kizárólagos zár rövid.

**Az `enableCutover` a zár alatt ellenőriz** (nem csak operátori census): a kizárólagos eszköz-zár megszerzése **után**, külön utasításban számolja az `S2`, az `S3u` és az `S3i` hatóköröket az eszközre; ha **egy is** van → `scope_not_empty_diverged` (`S2`), `unreconciled_removal` (`S3u`) vagy `removal_behavior_undecided` (`S3i`, amíg a D-q2 és az útmátrix-tesztek nincsenek meg) elutasítás
(írás nélkül). A census-bizonyíték (S0 darabszám, import-lezárás) az `enableCutover` bemenete, de az `S2` / `S3` kapu DB-ből jön.

**Újra-cutover a visszaengedés után.** (a) A visszaengedés (`rollbackCutover`, `M2`-ből) az **egyetlen** engedett út, ami az **import-ablakot újranyitja**, és az előző kapu / végső census bizonyítékait **érvényteleníti**
(exkluzív zár alatt, naplózva, csak ha nincs `linked` / `free` generáció); egy **engedélyezett** eszközön az ablakot továbbra sem nyitjuk újra, kézi egyeztetésnél sem. (b) A következő kísérlet előtt: teljes állapot-census;
az `S2` hatóköröket a `resync`, az újonnan keletkezett `S0` sorokat az import, az `S3`-at **csak** a bizonyítékos operátori helyreállítás (`classify_removal` / `reproject_missing` / `restore_status`) rendezi — automatikusan soha; az `S1` / `S4` változatlan. (c) Az E3 `scope_not_empty` ezzel **nem** akadály: a már importált hatókört nem
importáljuk újra, hanem az `S1`-et megtartjuk, az `S2`-t `resync`-eljük. (d) A kapu a nulláról indul (D-p 2. szabály), és `B` utáni visszaengedés esetén nem építhet `LEGACY = 0`-ra.

**Tesztek.** *Modell (DB-mentes, a következő kódlépésben):* az **állapottábla minden sora és átmenete** táblavezérelt teszttel (kimeneti állapot + a generáció és a vetület bájtra azonossága a nem érintett oldalon); a visszaengedés-jogosultság
függvény: `M2` + importált `unlinked_legacy` generáció → **engedett**; `M2` + `linked` / `free` → tiltott; *versenyek minden sorrendben (a zár-szimulátorral):* legacy upsert ↔ import (mindkét sorrend: `S4` vs. `S1`→`S2`),
legacy upsert ↔ `resync` (mindkét sorrend), legacy upsert ↔ `enableCutover` (az upsert az ellenőrzés előtt → elutasított engedélyezés; utána → elutasított upsert; **soha** nem `S2` engedélyezett eszközön),
`resync` ↔ `resync` (egy nyertes, UNIQUE), import ↔ `resync` (`scope_not_empty` / `not_diverged`); *végig:* import → visszaengedés → legacy upsert (`S2`) → `enableCutover` elutasítva → `resync` → `enableCutover` engedett → a nyitó függvény `found` az
új generációból, **nincs** második levonás; import → visszaengedés → új `S0` → import → engedett; a kapu bizonyítékai a visszaengedés után érvénytelenek; mutációk: az `enableCutover` az `S2` ellenőrzést a zár **előtt** végzi → elbukik; a trigger
a regisztert a zár előtt olvassa → elbukik; a `resync` ír vetületet → elbukik; a rollback nem nyitja újra az import-ablakot → az újra-cutover elbukik. *Valódi DB (külön jóváhagyás, előbb izolált teszt-DB):* a trigger ↔ `enableCutover` kétkapcsolatos
teszt (A: legacy upsert nyitva, B: `enableCutover` vár; A commit → B `scope_not_empty_diverged`; A rollback → B engedett; B nyitva, A upsert vár → B commit után A elutasított), az `S2` / `S3u` / `S3i` DB-lekérdezés pontossága, az eltávolítás-trigger (jegy nélküli törlés → `intent_basis` NULL; jegyes törlés → `operator_ticket`, a jegy felhasználva) és a fiók-kaszkád (nem `S3`).

**Az `S3` szétválasztás és a `resync` tesztterve (DB-mentes modell, a következő, külön jóváhagyandó kódlépésben; a modell nem bizonyítja a PostgreSQL-viselkedést):**
1. *Osztályozás:* táblavezérelt teszt — törlés / archiválás bizonyíték-sor nélkül → `S3u`; jegy nélküli törlés (bizonyíték-sor `intent_basis` NULL) → `S3u`; jegyes törlés érvényes bizonyítékkal → `S3i`; jegyes törlés, de az OLD digest eltér a generációétól → `S3u`; sikertelen jegy-audit → `S3u`; a bizonyíték **utólagos állítása** (a hiány puszta ténye, időzítő) soha nem emel `S3i`-re (mutáció: az automatikus emelés → elbukik).
2. *Nincs automatikus írás:* `S3u` és `S3i` mellett a nyitó függvény `unverified`; kiszolgálás nincs (a generációból és a gyorsítótárból sem), levonás nincs, a commit a hatókörre nem fut, a `paid_results` és a generációs tábla bájtra azonos (mutáció: automatikus `reproject` → elbukik).
3. *Kapu:* `enableCutover` `S3u` mellett → `unreconciled_removal`, **csak az adott eszközre** (egy másik eszköz engedélyezhető); `S3i` érvényes bizonyítékkal **is** → elutasított (`removal_behavior_undecided`) mindaddig, amíg a D-q2 nincs rögzítve és az útmátrix-tesztek nem zöldek (mutáció: az `S3i` nem blokkol → elbukik); az `S3u` `classify_removal` után (egyező digest) `S3i` → **még mindig elutasított**; helyreállítás után (`S1`) → engedett; a modellben a D-q2 döntés **nincs** kódolva, ezért semmilyen bemenet nem engedi az `S3i`-t; a zár **előtti** `S3`-számlálás → elbukik (mutáció).
4. *Operátori helyreállítás (a két fizikai állapot külön, négyes: `{S3u-m, S3u-n, S3i-m, S3i-n}`):* jegy / kísérlet-sor / jóváhagyó ≠ létrehozó hiánya → elutasított; bizonyíték nélkül nincs írás; bizonyítottan szándékos törlést (`S3i`) az operátor egyedül nem állít vissza (`user_restore_request` azonosítható kérés nélkül elutasított).
   *`reproject_missing` (`-m`):* sikeres ág → `S1`, a visszaállított sor **`id`-ja bájtra azonos az eredetivel** (a `projection_row_id`-val), a hordozott mezők a generációval bájtra azonosak, a módosítható mezők alapértéken (naplózva), **a generáció változatlan**, nincs új generáció, nincs `gop:` sor; egy **régi azonosítóval** (a törlés előtt kiadott `paidResultId`) a helyreállítás után a nyitó függvény `found`-ot ad ugyanarra a hatókörre (a linkek változatlanok); `row_id_mismatch` (a bizonyíték OLD `id`-ja ≠ a generációé) → írás nélkül; `id`-ütközés (23505) → a tranzakció visszagörgetődik, **új `id` nem generálódik** (mutáció: friss `gen_random_uuid()` az eredeti helyett → elbukik); a generációs tábla `projection_row_id` változtathatatlansága és hatókörön belüli állandósága (az előző generációval egyező); `resync` és commit másolja az azonosítót (mutáció: új azonosítót ír → elbukik).
   *`restore_status` (`-n`):* **nem INSERT** (forrás-teszt: nincs INSERT a törzsben; a negatív kontroll — INSERT a meglévő sorra — 23505-tel elbukik, és ez bizonyítja, hogy az INSERT itt nem alkalmas); az előkép (digest + pillanatkép) az audit-sorba kerül **ugyanabban** a tranzakcióban; csak a `status` változik; hordozott mező eltérése → `row_content_diverged`, a hatókör `S3u` marad, **semmi nem íródik felül** (mutáció: felülírás eltérő tartalom mellett → elbukik); identitás-eltérés → `row_identity_mismatch`; CAS-vesztés (közben megváltozott a sor) → `concurrent_change`, írás nélkül; az `id` változatlan, a régi azonosítóval a nyitó függvény `found`.
   *Közös:* verseny: helyreállítás ↔ legacy upsert ↔ `enableCutover` ↔ commit minden sorrendben (egy nyertes, `S2` nem keletkezik engedélyezett eszközön, `S3` hatókörön a commit a helyreállításig elutasít); válaszvesztés / összeomlás: `outcome_unknown`, kerítés, a fenti állapotgép; bármely előfeltétel sérülése → a hatókör `S3u` / `S3i` marad, a kapu blokkol.5. *`legacy_resync` generáció:* egy `credit_cost = 1` vetületből a `resync` generáció `unlinked_legacy` / `legacy_unverified` / `legacy_resync`, `credit_transaction_id` NULL, nincs `gop:` ledger-sor, nincs üzleti jóváírás, a címke „ismeretlen”, a válasz nem állít fizetést; a hívó által átadott `charge_link` / `credit_cost_evidence` figyelmen kívül marad (mutációk: `ledger_linked` jelölés → elbukik; `free` jelölés → elbukik; a `credit_cost` beemelése fizetési állításba → elbukik); `resync` `S3` / `S0` / `S1` / `S4` hatókörre → strukturált elutasítás, írás nélkül; az engedélyezett eszközre elutasított; a törzs forrás-tesztje: nincs `UPDATE`, `DELETE`, `ON CONFLICT`, nincs `paid_results` írás.
6. *Forrás-tesztek a tényekre:* az `app/` és `lib/` alatt nincs `paid_results` törlés / archiválás (ha később jön, a teszt elbukik, és a tervet felül kell vizsgálni); a route-ok nem hivatkoznak a helyreállító függvényekre.
7. *Az `S3i` kapu és az útmátrix:* lásd *Az `S3i` cutover-késszége* — az útmátrix minden sora × `{S3u-m, S3u-n, S3i-m, S3i-n}`, három szinten (modell, route, dashboard); az `S3i` addig blokkol, amíg a D-q2 nincs rögzítve **és** ezek nem zöldek.
8. *Az `S3i` helyreállítás — nincs INSERT / UPDATE felhasználói kérés nélkül (a hiányzó **és** a nem `completed` sorra külön; táblavezérelt, mindkét fizikai ág × minden sor):* minden esetben az elvárás: strukturált elutasítás, a `paid_results` **sorainak száma és bájtjai változatlanok** (nincs INSERT, nincs UPDATE), a generációs tábla változatlan, nincs `gop:` ledger-sor, az audit-sor és a kísérlet-sor `rejected:<kód>` (a tranzakció commitol, a nyom megmarad). **A bizonyíték a sorok és az audit előtte–utána összevetése, egy konkrét kísérletre:**
   - *előtte* (a hívás előtt, a hívótól **független, külön kapcsolaton**, commitolt állapotról, a hatókörre szűkítve): a `paid_results` hatókör-sorainak teljes tartalma és sor-digestje (a sor megléte is), a generációs tábla hatókör-sorai, a `credit_ledger` felhasználói sorainak darabszáma és tartalom-digestje, az audit- és kísérlet-táblák hatókör-sorai (azonosító + állapot);
   - *utána* (a hívás **befejezése és commitja után**, ugyanígy külön kapcsolaton): ugyanaz a pillanatkép; **elvárás: a védett táblák pillanatképe bájtra azonos** (`paid_results`, generáció, `credit_ledger`), az audit / kísérlet táblák különbsége **pontosan** az elvárt egy `rejected:<kód>` audit-sor és a kísérlet-sor állapotváltása, **semmi más**; a teszt az összevetést egy **csendes, izolált teszt-DB-n** végzi (a hatókörre szűkített pillanatkép nem függ más írótól);
   - a modellben ugyanez: a teljes állapot mély másolata előtte / utána, strukturális egyenlőség a védett részekre; az írás-számláló csak **kiegészítő** (nem a bizonyíték).
   - **A `pg_stat_user_tables` összesített számlálói (`n_tup_ins`, `n_tup_upd`, `n_tup_del`) legfeljebb kiegészítő diagnosztikák**, **nem** egy konkrét elutasított kísérlet nulla írásának bizonyítékai: kumulatívak, a tábla minden írójára összegzők (más kapcsolat, háttérfolyamat is), a frissítésük a tranzakció végéhez és a statisztika-gyűjtés késleltetéséhez kötött, és nem hatókörre vagy kísérletre szűrtek. Ha a különbségük nem nulla, **vizsgálat** indul; ha nulla, az **nem bizonyít** semmit. A teszt **soha nem** ezen megy át vagy bukik el.
   - **D-q2 nincs rögzítve** (a modell alapja): *érvényes operátori jegy + érvényes audit + érvényes felhasználói kérés* → `recovery_policy_undecided`; *érvényes jegy, **felhasználói kérés nélkül*** → `recovery_policy_undecided` (a politika-réteg dönt elsőként); a két ág × `{S3i-m, S3i-n}`;
   - **D-q2 rögzítve (a tesztbe injektált döntés, nem a modell alapja):** *operátori jegy, audit, jóváhagyó ≠ létrehozó, **de nincs felhasználói kérés*** → `user_request_required`, **nincs INSERT / UPDATE** (`-m` és `-n`); *kérés más felhasználótól* → `user_request_invalid:user_mismatch`; *kérés más hatókörre* → `…:scope_mismatch`; *kérés a törlés **előtti** időponttal* → `…:not_new`; *kérés `identity_verified_by` nélkül, vagy ellenőrző = jegy-létrehozó / végrehajtó* → `…:not_identified`; *felhasznált kérés* → `…:used`; *lejárt* → `…:expired`; **csak** az érvényes kérés + érvényes jegy + érvényes audit **együtt** ír: `-m` → egy INSERT az eredeti `id`-val, `-n` → egy feltételes UPDATE a `status`-ra, a kérés felhasználtnak jelölve **ugyanabban** a tranzakcióban;
   - *mutációk (mind elbukik):* az operátori jegy elég a felhasználói kérés helyett; a felhasználói kérés ellenőrzése a zár **előtt** olvas; a politika-réteg kihagyása; a kérés felhasználtként jelölésének elhagyása (újrajátszás); az `S3u` kivétel (`operator_error_confirmed`) kiterjesztése `S3i`-re; a `-n` ág elfogad `S3i`-n jegy nélküli UPDATE-et.
   - *forrás-teszt:* a két helyreállító függvény törzsében az `S3i` ág **nem** tartalmaz írást a politika- és kérés-ellenőrzés előtt; a `paid_user_restore_request` és a `paid_removal_policy` táblát a route-ok és a `lib/` nem írja (statikus).

#### LR-1 — ÉLŐ kockázat, névvel jelölve: hiányzó eredmény mellett korábbi levonás is történhetett, amit a mai adatok nem kötnek megbízhatóan az eredményhez (2026-10-06, pontosítva 2026-10-07)

**Név:** `LR-1 legacy_unattributable_prior_charge` (korábbi, **pontatlan** munkacím: `legacy_regenerate_on_missing` — visszavonva, mert azt sugallta, hogy minden hiányzó eredmény kettős levonás). **Státusz: ma élő, a production forgalom a legacy úton fut; a terv nem szünteti meg, és a cutover blokkolása sem védi ki.**
**A kockázat pontos megfogalmazása.** Az `LR-1` **nem** azt jelenti, hogy minden hiányzó eredmény kettős levonás. **A kockázat:** egy hiányzó (vagy nem `completed`) eredmény mellett **korábbi levonás is történhetett** — a felhasználó az adott inputért már fizethetett, és az eredményt aztán törölték / archiválták / out-of-band módosították, vagy a mentés elmaradt —, és ezt a **mai adatok nem tudják megbízhatóan az eredményhez kötni**: a `credit_ledger` `spend:<uuid>` hivatkozása véletlen, nincs közös kulcs a `paid_results` sorral (a D1/D2 eredeti oka), a `credit_cost` nem bizonyít levonást. A legacy route a hiányzó eredményre új generálásként reagál (új szolgáltatói költség, `chargeFeature` → `spend_credits`), és **nem tudja**, hogy volt-e korábbi levonás. Három, a mai adatokból **nem eldönthető** eset: (a) **nem volt** korábbi levonás (soha nem mentett / ingyenes / sikertelen futás) → az új levonás első és jogos; (b) **volt** korábbi levonás ugyanerre az inputra → az új levonás **kettős lehet**; (c) volt levonás, de más inputra / ismeretlen → nem eldönthető. A terv **nem állítja**, hogy kettős levonás történt, és **azt sem**, hogy nem. Az `S3` hatókör (generáció mellett hiányzó vagy nem `completed` vetület) a (b) eset **kimutatható** részhalmaza, de az `LR-1` **szélesebb**: generáció nélkül is él (ma nincs generációs tábla, tehát az `S3` definíciója ma **nem alkalmazható**; a mai kitettséget csak a lent leírt közelítések mérik).
**Felhasználónak és operátornak szóló szöveg (TERVEZET, NEM KÉSZ felhasználói szöveg; a megfogalmazás kötött, de az éles használatot a `G-SUP` kapu és a `B5` korlátozza; a magyar szöveg az egyetlen forrás, a route / riport / üzenet ezt idézi).** *`V0` — támogatási ígéret nélkül (tervezet):* „Ehhez a tartalomhoz most nem találjuk a mentett eredményt. Előfordulhat, hogy korábban már fizettél érte, de a rendszer ezt ma nem tudja megbízhatóan az eredményhez kötni. Ezért nem indítunk új fizetős futást magától.” *`V1` — támogatási ígérettel (**csak a `G-SUP` kapu teljesülése után**):* a `V0` + „A támogatás ellenőrzi a kreditmozgásokat.” *(Csak az átvezetett, fail-closed úton használható; a legacy úton a szöveg nem jelenik meg, mert a legacy route nem módosul. A `V0` önmagában zsákutca, ezért az `S3` útvonal élesítése is a `G-SUP`-ra vár. Lásd *Támogatási ígéret — külön indulási kapu*.)* *Operátori / riport-szöveg:* „A hiányzó eredmény mellett korábbi levonás történhetett, amelyet a rendelkezésre álló adatok nem kötnek megbízhatóan az eredményhez; a kitettség mértéke nem ismert.” **Tilos** (forrás-teszttel védve a dokumentumra, a riport- és üzenet-sablonokra): „minden hiányzó eredmény kettős levonás”, „kettős levonás történt”, „nincs levonás” / „nem vontunk le” bizonyíték nélkül, „nem fizettél érte” és minden olyan szöveg, amely a hiányból levonás-hiányt vagy levonás-megtörténtet következtet.
**Miért nem véd a cutover-blokkolás.** Az `enableCutover` blokkolása (`S3u` / `S3i` / `B1`–`B5`) a **jövőbeli** átvezetést tartja vissza; a **várakozás alatt** (amíg a cutover nem megy) minden kérés a legacy úton fut, és az `LR-1` **végig él**. A blokkolás ráadásul azt jelenti, hogy az eszköz **tovább marad** a legacy úton. A terv ezért **nem** állíthatja, hogy az `S3` blokkja a felhasználót védi.
**Amit a terv NEM tehet:** legacy route-ot **engedély nélkül nem módosít** (sem őrt, sem előzetes ellenőrzést, sem naplózást); DB-t nem ír; élő kérést nem indít. A legacy route-módosítás **külön engedélyt** igényel, és ma **nincs megtervezve** (a legacy kód nem rendelkezik a „törölt” megkülönböztetéséhez szükséges bizonyítékkal).

**Csak olvasó S3-census (terv; NINCS lefuttatva, a futtatás külön, fázisonkénti jóváhagyást igényel a production-szigor szerint: csak olvasó szerepkör, interaktív jelszó, kimenet csak darabszám / aggregátum, azonosító nem).** Két szakasz, mert ma nincs generációs tábla:
- **0. szakasz — ma, generációs tábla nélkül (közelítések; mindegyik mellett: mit NEM bizonyít):**
  - `C-1` nem `completed` sorok darabszáma eszközönként (`SELECT tool_type, status, count(*) … WHERE status <> 'completed'`): a kód csak `completed`-et ír, ezért **bármely** nem `completed` sor out-of-band (`S3-n` előfutár). *Nem bizonyítja:* hogy a törölt sorok száma nulla.
  - `C-2` a `pg_stat_user_tables` `n_tup_del` és `n_tup_upd` számlálója a `paid_results`-ra (v2: csak vödrözve, élő-sor becslés nélkül): kumulatív a statisztika utolsó nullázása óta, **nem soronkénti, nem ad okot** (a fiók-kaszkád törlést is számolja). *Nem bizonyítja:* hogy a törlés nulla, ha a számláló nulla (nullázás / felügyelt platform viselkedése ellenőrizendő); *legfeljebb kiegészítő diagnosztika:* ha nem nulla, magyarázatot kell találni (fiók-kaszkád, ismert műveletek); **nem** bizonyítéka sem a törlések hiányának, sem egy konkrét kísérlet nulla írásának.
  - `C-3` a `credit_ledger` `spend:` sorai (fizetős `reason`-ök) és a `paid_results` sorai közötti **közelítő** egyeztetés (felhasználó, eszköz, időablak) — **csak ha** a ledger-metaadat mezői (read-only séma-ellenőrzéssel kiderítendők) ezt lehetővé teszik. *Nem bizonyít:* sor szintű összetartozást (nincs közös kulcs; ez a D1/D2 eredeti oka).
  - `C-4` a legacy-cache `completed` sorok, amelyekhez a route saját hash-ével nincs `paid_results` sor (az E2 (i) census; alkalmazás-oldali hash → szkript, **csak olvas**). *Nem bizonyít:* törlést.
- **1. szakasz — a generációs tábla megléte után (pontos, egy pillanatképben):** `STABLE` census függvény / lekérdezés, `S0`–`S4` darabszámok és az `S3u-m`, `S3u-n`, `S3i-m`, `S3i-n` bontás eszközönként; kimenet darabszám, **nincs azonosító**. Ez a közelítések helyett a pontos kitettséget adja.
- **Közös szabályok:** `BEGIN READ ONLY` (és egyetlen pillanatkép a 1. szakaszban); a lekérdezések szövege forrás-teszttel védett: **nincs** `INSERT` / `UPDATE` / `DELETE` / DDL / `SELECT … FOR UPDATE` / függvényhívás írási hatással; a kimenet nem tartalmaz `user_id`-t, `input_hash`-t vagy tartalmat; az eredmény **bizonyítékként rögzül** (időpont, számok, forrás, a közelítés korlátai); a futtatás **stagingen előbb**, a production futtatás külön jóváhagyással.

**A 0. szakasz pontos SQL-je — ELŐKÉSZÍTVE, NEM FUTTATVA (2026-10-07).** A szöveg egyetlen forrása a [`paid-operations-lr1-census-phase0.sql`](paid-operations-lr1-census-phase0.sql) (**v3**, 360 sor, ASCII, LF, `sha256 = 7bd25b3c84cb71d4803e156e616880039ba17eb4159cbb7f4b549e4809edde4d`, a fájl bájtjaira; **bármely módosítás új hash-t és új jóváhagyást jelent** — a jóváhagyás erre a pontos hash-re **és a jóváhagyott célra** szól). *Elavult, nem jóváhagyható hash-ek: v1 `365a14e16170e246d507309fd98ff859a675803a6c7050310d44fb8b33ac16b7` (pontos darabszámokat adott); v2 `63c822aa3bf7e7fb2ec857927982171e3406207cc6962c69a8afba367f7ce09f` (a Q0 / Q0b csak „Expected” megjegyzés volt, és a `tool_type` / `status` nyers adatoszlopból került a kimenetbe).* **Nem futott semmilyen adatbázison**; a futtatás külön, fázisonkénti jóváhagyást igényel (előbb staging szintaxis- és jogosultság-próba, a production külön).
*Közös védelem a mind a nyolc lekérdezésre (Q0, Q0b, Q1, Q2, Q3, Q3b, Q4, Q5):* `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` (egy pillanatkép, írás a tranzakció szintjén tiltott), `statement_timeout 15 s`, `lock_timeout 2 s`, `idle_in_transaction_session_timeout 120 s`, a végén `ROLLBACK` (nincs mit commitolni); `application_name = lr1_census_phase0`. A végrehajtás módja (egyszeri felügyelt admin-olvasás vagy aggregált DB-felület szűk szerepkörrel) **külön döntés** (lásd *Végrehajtási lehetőségek*; a `READ ONLY` tranzakció az írást védi, az olvasható adatot nem szűkíti); a futtatás előtt `EXPLAIN` (**`ANALYZE` nélkül**, az nem hajt végre) a terhelés felmérésére; csendes időszakban fut.
*Azonosítók és titkok elkerülése (rétegek):* (1) **soha nem kerül a kimenetbe**, még közvetve sem: `paid_results.id / user_id / input_hash / normalized_input / original_input / result_json / summary_json / source_run_id`; `credit_ledger.id / user_id / external_ref / metadata / related_transaction_id` — a `metadata` nyers felhasználói szöveget hordoz (`topic`, `keyword`, `niche`, `channel_id`, `seed_keyword`), ezért **csak** `metadata->>'feature'` olvasódik, és az értéket egy **rögzített szótárra** képezi (minden más → `(unmapped)`), a szabad szöveg nem juthat ki; az `id` / `user_id` / `related_transaction_id` csak `JOIN`-ban, `NOT EXISTS`-ben és `DISTINCT`-ben szerepel, a kimenet **csak aggregátum**; (2) minden lekérdezés **deklarálja a kimeneti oszlopait** (`OUTPUT:` sor), és egy teszt összeveti egy engedélylistával; nincs `SELECT *`; (3) a kimenet **csak nagyságrend-vödör címke, eszköznév, státusz, UTC-negyedév, időbélyeg** (a Q0 verziószáma az egyetlen szám) — nincs felhasználó-dimenzió, pontos darabszám sincs, a legfinomabb időbontás a negyedév; (4) **futásidejű szűrő** a mentés előtt: a kimenetet a futtató eszköz végigolvassa, és UUID-, e-mail-, `eyJ…` (JWT-szerű), `sk-…` / `sb_…` kulcs-szerű és hosszú hexadecimális minta esetén **nem menti és nem jeleníti meg**, hanem megáll; (5) a **kapcsolati adatok** (gazdanév, projekt-azonosító, szerepkör, jelszó) interaktívan kerülnek megadásra, **nem** a parancssorba, a környezeti változóba vagy a fájlba; a mentett kimenet **nem tartalmaz** gazdanevet vagy projekt-referenciát (a korábbi szabály szerint redaktált); a psql előzményfájl kikapcsolva; (6) a kapcsolati hiba / jogosultsági hiba szövege sem kerül be a jelentésbe nyersen (átnézés és redaktálás után).

| Lekérdezés | Mit mér | Mit NEM tud bizonyítani | Milyen adatot ad ki |
|---|---|---|---|
| **Q0** `session_guard` — **kapu** | a munkamenet csak olvasó és `repeatable read`: `DO` blokk, amely **kivételt dob**, ha nem; ha átmegy, egy fix `ok` címke és a szerverváltozat száma | semmit az adatokról; a futás érvényességének előfeltétele | `ok` + verziószám (hiba esetén **nincs kimenet**, a script leáll) |
| **Q0b** `schema_guard` — **kapu** | hogy **pontosan** a lekérdezések által használt 10 oszlop (5 `paid_results`, 5 `credit_ledger`) létezik a `public` séma **táblájában** (`BASE TABLE`): `DO` blokk, amely **kivételt dob**, ha a szám nem 10 | adatot nem; **kevesebb vagy több → hiba**, a script `ON_ERROR_STOP` miatt leáll, a tranzakció megszakadt, a további utasítások sem futhatnak le | egy fix `ok` címke (hiba esetén **nincs kimenet**) |
| **Q1** `C-1a` | a `paid_results` sorainak eloszlása (eszköz × státusz) | törölt sorok számát; csak a **jelenlegi** állapotot látja; a `completed` sorok épségét nem; **pontos számot sem** (vödör) | eszköznév és státusz **csak a fix szótárból** (17 eszköz, 4 státusz, `(other)`, `(null)`), **vödör-címke** |
| **Q2** `C-1b` | a nem `completed` sorok (a kód csak `completed`-et ír, tehát minden ilyen sor **out-of-band**) eszköz × státusz × UTC-**negyedév** szerint; az 5 alatti cellák egy `(suppressed)` sorba olvadnak | hogy ki / mikor / miért változtatta; hogy a hiányzó sorok száma nulla; az `updated_at` nem feltétlenül a módosítás ideje; **kis cella pontos értékét** (a Q1-ből való kivonással sem) | eszköz és státusz **csak a fix szótárból**, negyedév vagy `(suppressed)`, vödör-címke |
| **Q3** `C-2` | a `paid_results` és a `credit_ledger` kumulatív számlálói (`n_tup_ins/upd/del`) vödrözve (élő / halott sor becslés **nincs**) | **semmilyen konkrét törlést vagy kísérletet**: összesített, minden íróra, a statisztika-gyűjtés késleltetésével frissül, a fiók-kaszkád törlést is számolja; **legfeljebb kiegészítő diagnosztika** | két sor, három vödör-címke |
| **Q3b** `C-2` | a számlálók utolsó nullázásának ideje | a nullázás okát; nélküle a Q3 számai értelmezhetetlenek | egy időbélyeg (az adatbázis neve **nem** kerül ki) |
| **Q4** `C-3` | eszközönként a vissza nem térített fizetős levonások, a mentett `completed` eredmények költséges és ingyenes csoportja — **három vödör-címke egymás mellett**; **nincs** összeg, visszatérített szám, 90 napos sor, különbség-érték (v2: az `indicative_gap`, `n_spends`, `n_completed` oszlop megszűnt) | **sor szintű összetartozást** (nincs közös kulcs); a vödrök egymás melletti olvasása **jó-indokú eltérést is mutathat** (ugyanarra az inputra többszöri fizetős frissítés egy sorra upsertelődik; egy levonás más inputra); az `LR-1` **kitettségét nem méri**, csak a nagyságrendet; a `feature → tool_type` leképezés (a Q4-ben kézzel felsorolva) **közelítés**, a leképezetlen nevek `(unmapped)`-be mennek; **kapu nem lehet** | eszköznév **csak a fix szótárból** (a levonás-oldalon a `feature` → eszköz leképezés értékei vagy `(unmapped)`, az eredmény-oldalon a 17 értékű szótár vagy `(other)`) és vödör-címkék |
| **Q5** `C-3b` | hány felhasználónak van vissza nem térített, leképezett fizetős levonása, de **egyetlen** `paid_results` sora sincs (bármely státusszal) | törlést vs. soha-nem-mentést (a mentési hiba miatti automatikus visszatérítés kiszűri a saját esetét, de nem minden esetet); **kit** érint (azonosítót nem ad); **pontos számot** sem | **egyetlen vödör-címke** |
| *(kizárva)* `C-4` legacy-cache census | — | **nem SQL**: a gyorsítótár kulcsa alkalmazás-oldali hash, ezért az E2 (i) szkriptje; **ebben a lépésben nem készül el** | — |

*A teljes 0. szakasz korlátja:* a Q1–Q5 közelítések; **egyik sem bizonyítja, hogy nincs `LR-1` kitettség**, és **nulla eredmény sem** bizonyítja a hiányát (nincs generációs tábla, tehát nincs viszonyítási alap a hiányzó sorhoz). Az eredmény a D-r döntés **bemenete**, nem kitettség-mérés.
**Célazonosság-ellenőrzés a futtatás előtt (staging / production), a kimenetbe NEM kerül (TERV, 2026-10-07; nincs megvalósítva, semmi nem fut).** *Miért:* a SQL nem tudja, melyik környezeten fut; a csak olvasó futás sem ártalmatlan, ha rossz célon megy (production aggregátumok kerülnének egy staging-jóváhagyás alá, vagy fordítva), ezért a célt a fájlon **kívül**, az első utasítás elküldése **előtt** ellenőrizzük.
- **Jóváhagyási rekord (fázisonként külön, a felhasználó állítja össze, a repón kívül, nyers azonosító nélkül):** `phase` (`staging_dryrun` | `production`), `target_label` (`staging` | `production`), `target_fingerprint` (SHA-256 hex egy kanonikus szövegen: `v1|<projekt-azonosító>|<gazdanév>|<port>|<adatbázisnév>`, amelyet a **felhasználó helyben számol** a valódi kapcsolati paraméterekből; a nyers értékek **soha** nem kerülnek chatbe, fájlba, naplóba), **`role_fingerprint`** (SHA-256 hex a `v1|role|<szerepkör>` szövegen — a **végrehajtó szerepkör** is a jóváhagyás része, pontos, kis- és nagybetűre érzékeny), `sql_sha256`, jóváhagyó, lejárat, `second_factor`; a `status` mező csak tájékoztató — **az egyszeri használat tényleges állapota a rekord melletti `.claim` fájl** (lásd lent). Egy jóváhagyás **egy fájl**: ugyanarra az útvonalra új jóváhagyás nem készíthető (a claim fájl megmarad), új jóváhagyáshoz új fájlnév kell.
- **A futtató eszköz lépései (a sorrend kötött):** (0) a claim fájl állapota — létezik → `approval_already_used` / `approval_burned`, olvashatatlan → leáll; (1) a jóváhagyási rekord ellenőrzése (fázis, címke, lejárat, alakok); (2) az SQL-fájl bájtjait **egyszer** olvassa be, **privát másolatot** készít, **ezen** számolja a SHA-256-ot, és **ugyanez a másolat** megy a `psql`-nek a **standard bemeneten** (`-f -`) — a fájl útvonalát a `psql` nem kapja meg, ezért a hash-ellenőrzés után megváltozó fájl nem változtat azon, ami fut; (3) a kapcsolati paramétereket **és a végrehajtó szerepkört** **interaktívan** kéri, visszhang nélkül (nem parancssorból, környezeti változóból vagy fájlból), a kanonikus szövegekből **memóriában** ujjlenyomatot számol; (4) összeveti a rekord `target_fingerprint` **és** `role_fingerprint` értékével az adott fázisra: bármelyik eltérés → **a rekord `burned` claim-et kap** (kizárólagos, egyszer létrehozható claim), a képernyőn **csak** `TARGET MISMATCH` vagy `ROLE MISMATCH`, **nincs kapcsolat**; ha a **burn nem menthető** (io hiba), az **külön, hangos hiba** (`burn_failed`, `BURN FAILED … revoke the approval manually`, kilépési kód 3) — ilyenkor a rekord *még felhasználhatatlan állapotban nem biztosított*, ezért a jóváhagyást **kézzel vissza kell vonni** (a „mismatch után nincs újrapróbálás” állítás csak sikeres burn esetén áll); (5) `TARGET OK <címke>` + `ROLE OK`; gate-only módban itt vége; (6) gépelt megerősítés; (7) **kizárólagos claim** (`.claim` fájl `wx` létrehozással) a legelső kapcsolat **előtt** — két párhuzamos futtató közül pontosan egy nyer, a másik `approval_claim_lost`-tal áll le, mielőtt bármit csatlakozna; (8) **második tényező:** a rekord `second_factor` mezője — vagy a DB-oldali, **csak olvasó** `pg_control_system().system_identifier` ujjlenyomata (kliens oldalon összevetve, **nem kiírva**; az olvashatósága **nem igazolt**), vagy a **felhasználó által a szolgáltatói felületen végzett, rögzített emberi megerősítés**; az egytényezős ellenőrzés **kimondott**, nem csendes; (9) a census; (10) az eszköz naplója és a mentett bizonyíték **csak** a címkét, a fázist, a `sql_sha256`-ot, az időket, a kilépési kódot és a vödör-kimenetet tartalmazza — **soha** nem tartalmaz gazdanevet, projekt-azonosítót, szerepkört; a hibaszöveg **redaktálva** kerül be.
- *Tesztek:* lásd az alábbi megvalósítási bekezdést (két tesztfájl, köztük a kétfolyamatos claim-verseny és a „pontosan az ellenőrzött bájtok futnak” bizonyíték).

**A futtató és a célazonosság-kapu — DB-mentes megvalósítás és teszt (2026-10-08, javítva 2026-10-08/2; NEM futott semmilyen adatbázison, a CLI-t kapcsolattal soha nem indítottuk).**
- *Fájlok (mind új, nincs commit):* `lib/lr1-census/runner-core.ts` (tiszta mag: nincs I/O, csak `node:crypto`; kapu-sorrend, rekord-ellenőrzés, kimenet-szűrő, redaktálás), `lib/lr1-census/approval-claim.ts` (kizárólagos, egyszer létrehozható claim — csak `node:fs`), `lib/lr1-census/psql-process.ts` (az **egyetlen** hely, amely folyamatot indít: a census a standard bemeneten, a gyerek privát környezettel), `scripts/lr1-census-runner.ts` (vékony CLI: argumentumok, rejtett promptok), `tests/lr1-census-runner.test.ts` (138 teszt), `tests/lr1-census-process.test.ts` (17 teszt, folyamat-szintű bizonyítékok helyi Node-helyettesítőkkel), `tests/support/lr1-census-model.ts`. Az app / lib / components egyetlen más fájlja sem hivatkozik rájuk (forrás-teszt).
- ***Bizonyíték: pontosan az ellenőrzött bájtok futnak.*** A korábbi változat a magban hash-elt, a CLI pedig az útvonalat újra megnyitotta a `psql -f`-fel — a kettő között a fájl megváltozhatott. Most: a bájtokat a mag **egyszer** olvassa (forrás-teszt: egyetlen hívás), privát másolatra (`Uint8Array.from`), a hash ezen készül, és ugyanez a másolat kerül a `psql` bemenetére (`-f -`); a CLI az útvonalat egyszer olvassa, és sehol nem adja tovább. *Tesztek:* (a) a hamis olvasó második híváskor más bájtot adna — a `psql` az elsőt kapja; (b) a visszaadott tömb a megerősítés alatt átírva — a `psql` az eredetit kapja; (c) **folyamat-szinten**: valódi ideiglenes SQL-fájl a hash-ellenőrzés után, a `psql` indítása előtt **lecserélve**, a helyettesítő `psql` a standard bemenetén kapott bájtok SHA-256-ját rögzíti, ez **egyezik a jóváhagyottal**, az argumentumokban nincs útvonal, a lemezen lévő fájl pedig bizonyíthatóan más; (d) **negatív kontroll**: ha az útvonalat újra olvassuk (a régi viselkedés), a helyettesítő `psql` a lecserélt bájtokat kapja.
- ***Kizárólagos igénylés (az `unused`-olvasás → `used`-írás helyett).*** A jóváhagyási fájlt a futtató **nem írja át**. Az egyszeri használatot a mellette lévő `<jóváhagyás>.claim` fájl **kizárólagos létrehozása** (`openSync(…, 'wx')`: `O_CREAT|O_EXCL`, Windowson `CREATE_NEW`) dönti el; a claim fájlt a futtató **soha nem törli**, ami létezik, az claim (üres vagy hibás tartalommal is). ***Amit a teszt bizonyít, és amit NEM:*** a **folyamatversenyt** (két egyszerre induló folyamat közül pontosan egy nyer) — **nem** bizonyítja, hogy a claim **áramszünet vagy összeomlás után** is megmarad (ez **nem igazolt**): a fájl tartalmát a kód csak best-effort `fsync`-eli, a könyvtár-bejegyzést nem, és összeomlás- / áramszünet-teszt nincs. **Az „áramszünet után is tartós” állítás külön igazolás nélkül nem használható** (forrás-teszt: a kód- és doc-szövegek nem állítják). Következmény: ha a gép a claim létrehozása után azonnal leáll, és a fájl nem éli túl, a jóváhagyás újra felhasználatlannak látszhat — ezt a kód nem fogja fel; az operátori rend (a futás kimenete és a jóváhagyások nyilvántartása) fedezi. *Tesztek:* **két valódi folyamat** egyszerre (indulási sorompó), 12 körben: pontosan **egy** nyer, a másik `exists`; **negatív kontroll**: a régi read → check → write kezelés mellett **mindkét** folyamat elindul; ugyanez egy folyamaton belül a teljes kapu-soron (két `runCensus`, közös claim fájl): az egyik `ok`, a másik `approval_claim_lost`, és csak az egyik ér a `psql`-ig. *Korlát:* a kizárólagos létrehozás **helyi fájlrendszeren** atomi; hálózati megosztáson, amely az `O_EXCL`-t nem tartja be, **nem használható**.
- ***A végrehajtó szerepkör a jóváhagyás része, a claim előtt.*** A szerepkör ujjlenyomata (`role_fingerprint`) a rekordban van; a futtató a szerepkört a célponttal együtt, **még a megerősítés és a claim előtt** kéri be, és összeveti. Eltérés → `ROLE MISMATCH`, a rekord **burned**, nincs kapcsolat (a kapu-only módban is). A szerepkör a redaktált titkok között van (hibaszövegből, kimenetből kiszűrve).
- ***A burn mentési hibája nem nyelődik el.*** Korábban a `burned` állapot írásának hibáját a kód elnyelte, a rekord `unused` maradhatott. Most külön `burn_failed` kimenet (hangos sor, kilépési kód 3, nincs kapcsolat); ha a burn azért hiúsul meg, mert a claim már létezik (más futtató), az sima mismatch. *Tesztek:* io hiba, kivételt dobó claim, már létező claim, és egy valódi, nem írható claim-útvonal (a hiányzó könyvtár) folyamat-szinten is.
- *Kapu-sorrend (a mag kényszeríti, a tesztek a forrásban és futásban is ellenőrzik):* claim-állapot → jóváhagyás → egyszeri SQL-olvasás és hash (az obsolete v1 / v2 hash **az approval szerint is** tiltott) → rejtett cél **és szerepkör**, ujjlenyomatok **kapcsolat nélkül** (eltérés = burn) → `TARGET OK` / `ROLE OK` → gate-only itt véget ér → gépelt megerősítés → **kizárólagos claim** → második tényező (nincs csendes lefokozás) → census.
- *Bármely hiba / nem nulla kilépés / időtúllépés → a kimenet **eldobva**, a hiba osztályozva és redaktálva; a siker-kimenet **fehérlistás*** (fix fejlécek és sorrend, értékek csak szótárból / vödör-címkéből / negyedév-kezdetből / időbélyegből; idézőjel, extra oszlop, ismeretlen érték, UUID, e-mail, JWT-, kulcs-szerű és hosszú hex minta, vagy a bekért cél / szerepkör bármely része → **blokkolva**).
- *Tesztek és mutációk:* 155 teszt a két új fájlban (396 a négy DB-mentes fájlban összesen); **50 mutáció** (a repón kívüli szkript) — a claim nem kizárólagos létrehozása, olvashatatlan / hibás claim nem-claimként kezelése, a szerepkör-ellenőrzés elhagyása, a burn elnyelése / elhagyása, az elveszett claim-verseny figyelmen kívül hagyása, a claim a második tényező után, az SQL második olvasása, a privát másolat elhagyása, a psql-nek útvonal adása, a szülő-környezet vagy `PGPASSWORD` átadása, a `-W` elhagyása, a CLI host-flagje / visszhangos promptja / az exit-3 elhagyása / a jóváhagyás átírása, valamint az előző körök kapu-, kimenet-, redaktálás- és SQL-mutációi — **mind elbukott**; az első futásban két túlélő volt (olvashatatlan claim fájl; a `-W` elhagyása, mert a teszt a modulból származtatta az elvárt argumentumot): a tesztek javítva (könyvtár a claim helyén; **szó szerinti** elvárt argumentumlista), a két mutáció újrafuttatva és elbukott.
- *A kis-cella védelem pontosítása a modell alapján:* az 5 alatti cella **pontos értékét a vödrözés** rejti el (egyetlen vödör sem pontos a `0`-n kívül); az `(suppressed)` **összevonás** azt rejti el, **melyik negyedévben** van az 5 alatti cella. Az exhaustív modell-vizsgálat (3 negyedév, 0–12 sor) szerint minden 5 alatti cellát tartalmazó adathalmaznak van egy, ugyanazt a kimenetet adó másik, eltérő kis-összegű ikre — **az összevonás nélkül is**; az összevonás hatása a helyszín-elrejtés (negatív kontroll ellenőrzi).
- *`psql` (a valódi út, **soha nem futott**):* a célt és a szerepkört a gyerekfolyamat **saját, minimális környezetén** át kapja (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGSSLMODE=require`, `PGPASSFILE` / `PSQLRC` = `os.devNull`; a szülő környezetéből **semmi** — a teszt PGPASSWORD / PGOPTIONS / PGSERVICE / egyéb szülő-változókkal bizonyítja), a jelszót a `psql` saját `-W` promptja kéri (a CLI sosem látja, `PGPASSWORD`-ot soha nem állít); a census `psql -X -q --no-psqlrc -W -v ON_ERROR_STOP=1 --csv -f -` (a szkript a standard bemeneten); a második tényező külön `psql` hívás (`… --csv -t -c <a rögzített próba-konstans>`), ezért **két jelszó-prompt** lesz. *Nem igazolt:* hogy a `-W` prompt a Windows-os konzolról olvas-e akkor is, ha a standard bemenet csővezeték (a libpq a jelszót a terminál-eszközről kéri, de ezt valódi `psql`-lel **nem** próbáltuk); a gyűjtő / kapcsolat-összevonó (pooler) kapcsolat viselkedése; a `pg_control_system()` olvashatósága. Hiba esetén a futás **leáll, nem ír**.
- ***Hash-rögzítés és sorvég (2026-10-09: a szabály elkészült, commit még nincs).*** A fájl hash-e bájtokra szól, és a `core.autocrlf=true` Windows-os checkout a commitolt LF fájlt **CRLF-re írja át** (ugyanez okozza a meglévő 090 source-policy teszt bukását ezen a checkouton). Ezért a repó gyökerében **új `.gitattributes`** van, **egyetlen szabállyal, kizárólag erre a fájlra**: `docs/operations/paid-operations-lr1-census-phase0.sql text eol=lf` (a többi fájl — a migrációk is — **érintetlen**; egy szélesebb szabály külön döntés). *Igazolás (eldobható repókban, a projekt-repó nem módosult; a tesztfájl is futtatja):* `core.autocrlf=true` mellett (1) **szabállyal**, LF bemenetre: a tárolt blob és a friss checkout SHA-256-ja **egyezik** a jóváhagyottal (`7bd25b3c…de4d`), 0 CR bájt; (2) **szabállyal**, ha egy szerkesztő CRLF-fel mentette a munkamásolatot: a tárolt blob és a checkout **ugyanúgy a jóváhagyott bájtok**; (3) **negatív kontroll, szabály nélkül**: a tárolt blob rendben van, de a friss checkout **+360 CR bájtot** kap (15 810 → 16 170 bájt) és a hash **eltér** (`e361c18a…`). A `git check-attr` a projekt-repóban `text: set`, `eol: lf`-et jelent. **A futtató a ténylegesen futtatott bájtokat hash-eli** (a checkout utáni, helyi példányt), ezért a futtatás előtti hash-ellenőrzés a commit után is kötelező marad.
- ***Előfeltétel a valódi `psql` kipróbálására (külön engedély, izolált környezet; NEM igazolt):*** a `psql -W` jelszó-prompt **Windows alatt**, miközben a SQL **csővezetéken** (`-f -`) érkezik, **együtt még nincs kipróbálva**; a két együttes viselkedését (a prompt a konzolról olvas-e, nem a csővezetékről; nem kapja-e meg a SQL egy részét jelszóként; nem akad-e el) **először izolált környezetben** kell megnézni, **külön engedéllyel**, **semmilyen valódi (staging / production) adatbázis nélkül** (pl. egy eldobható, helyi tesztadatbázison, szintetikus jelszóval). Addig a `--execute` út **nem tekinthető működőnek**, csak a kapu-sorrend és a hash-/bájt-bizonyítékok igazoltak. A kimenetet a futtató a hiba esetén úgyis eldobja, de a „csővezeték + prompt” nem igazolt összjátéka a futás **elakadását** vagy félresikerülését okozhatja.
- ***A `--execute` előtti kötelező igazolás (2026-10-09, a felhasználó rögzítette; nincs elvégezve):*** a valódi `psql` **-W** promptja és a **csővezetéken érkező SQL** együttműködését **eldobható, helyi adatbázison** kell igazolni, mielőtt a `--execute` útra bármilyen valódi (staging / production) cél kerülne. *Terv, külön engedéllyel:* (1) eldobható helyi PostgreSQL (nem a projekt tesztadatbázisa, nem felhőbeli), szintetikus sémával és sorokkal (a 019 / 026 / 030 / 037 szerkezet, 1, 3, 4, 5, 12 soros cellákkal); egy eldobható, jelszavas szerepkör; (2) a valódi `psql` (a gépen a `PATH`-on **jelenleg nem található** a bash környezetből — a telepítés / elérési út külön ellenőrzendő) a futtatóval, **élő terminálból**: a prompt megjelenik, a jelszót a felhasználó gépeli, **az SQL nem kerül a jelszó helyére és a jelszó nem kerül az SQL-be**; (3) elfogadási feltételek: a kapuk átmennek, a fehérlistás kimenet feldolgozódik, a vödör-címkék a szintetikus adathoz illenek (`0`, `<5`, `5-9` …), a rossz jelszó tiszta hibával áll le és nem szivárogtat, a Ctrl-C után nem marad futó `psql` folyamat, a hibás (kapu-bukó) séma kimenet nélkül áll le; (4) mindhárom **kapcsolat-típus** (közvetlen, pooler) külön kérdés, és a valódi célokra **külön** igazolandó. Az eredmény rögzítendő; amíg ez nincs meg, a `--execute` út nem működőnek tekintendő.
- ***Gépösszeomlás / áramszünet utáni rend (2026-10-09, a felhasználó rögzítette).*** Ha a futtató gépe a `--execute` futás közben vagy a claim létrehozása körül összeomlik, a jóváhagyást **kézzel vissza kell vonni**, **mielőtt bárki újrafuttatást mérlegel**: a jóváhagyási fájlt és a `.claim` fájlt együtt kell vizsgálni (a claim fájl lehet, hogy elveszett, ezért a jóváhagyás hiába látszik felhasználatlannak), a jóváhagyás nyilvántartásában „vissza vonva” állapotba kell tenni, és a futtatás **csak új jóváhagyási fájllal** (új fájlnév, új rekord, új jóváhagyás) indulhat. A kód ezt **nem** kényszeríti ki; az operátori rend része, ugyanúgy, mint a `burn_failed` utáni kézi visszavonás.
- ***Döntési pont: a commit (a felhasználóé; NINCS meghozva, nem történt commit).*** Javasolt tartalom (10 új, nyomkövetetlen elem): `.gitattributes`; `docs/operations/paid-operations-d1-d2-state-model.md`; `docs/operations/paid-operations-lr1-census-phase0.sql`; `lib/lr1-census/{runner-core,approval-claim,psql-process}.ts`; `scripts/lr1-census-runner.ts`; `tests/lr1-census-runner.test.ts`, `tests/lr1-census-process.test.ts`, `tests/support/lr1-census-model.ts`; a D1/D2 modell és tesztjei (`tests/support/paid-operations-state-model.ts`, `tests/paid-operations-state-model.test.ts`, `tests/paid-operations-projection-legacy-cutover.test.ts`). A commit előtti ellenőrzőlista: (a) a SQL-fájl hash-e a doc rögzítettjével egyezik (`7bd25b3c…de4d`); (b) a `.gitattributes` a commit **előtt** is jelen van, és a commit utáni friss checkout hash-e ugyanaz; (c) a négy DB-mentes tesztfájl zöld, `tsc` tiszta; (d) a meglévő, független 090 source-policy teszt bukása (CRLF-es checkout) nem tartozik ide; (e) a commit-üzenet kimondja: nincs DB-hozzáférés, nincs futtatás, a `--execute` út nem igazolt; (f) az első commit után a SQL-fájl hash-ét **a commitolt bájtokon** újra ellenőrizzük. A commit **nem** engedélyezi a census futtatását, a staging- / production-lekérdezést, a `--execute` kipróbálását valódi célon, vagy a D-q2 / D-r / G-SUP / B1–B5 kapuk bármelyikének teljesítettnek tekintését.

**Q4–Q5: kifejezetten TÁJÉKOZTATÓ, nem kapu (2026-10-07).** A Q4 (három egymás melletti vödör-címke; a v1 `indicative_gap` oszlopa megszűnt) és a Q5 eredménye **nem** `LR-1`-mentességi bizonyíték, **nincs** hozzájuk küszöb, „megfelelt / nem felelt meg” kritérium, és **semmilyen kapu bemenete** nem lehet: sem a `B5`-é, sem a `D-r`-é, sem az `enableCutover`-é. A D-r döntéshozója **kontextusként** olvassa őket (nagyságrend, eszközök közti eloszlás). Tiltott megfogalmazás (forrás-teszt a dokumentumra és a jelentés-sablonra): „a census igazolta, hogy nincs `LR-1` kitettség”, „nincs kitettség”, „nulla eltérés → rendben”. Teszt (DB-mentes): nincs olyan kapu- / döntési függvény, amely a Q4 / Q5 kimenetét paraméterként fogadja (statikus); mutáció: egy `lr1_clear` jelző a census kimenetéből → elbukik.

**Q1–Q2 és az 5 alatti csoportok: a védelem a lekérdezés kimenetében (v2, 2026-10-07).** *A kockázat:* a kód **sosem** ír nem `completed` sort, tehát a nem `completed` csoportok várhatóan kicsik (akár egyetlen sor); egy `(eszköz, státusz, időszak) → 1` sor **közvetve felismertethet** valakit annak, aki a hátteret ismeri (az az operátor, aki egy adott időszakban egy felhasználó eredményét kézzel archiválta / törölte; a támogatás, amely egy konkrét esetet ismer). A korábbi, **kimenet-feldolgozó** megoldás (a futtató eszköz maszkol) helyett a **SQL maga** nem ad ki pontos számot (v2; új hash, lásd fent):
1. **Egyetlen pontos darabszám sem hagyja el az adatbázist:** minden szám egy **nagyságrend-vödör** címkéje (`0`, `<5`, `5-9`, `10-49`, `50-99`, `100-499`, `500-999`, `1000-9999`, `10000-99999`, `100000+`); minden lekérdezés **ugyanazt** a vödör-táblát használja, így egy vödör **nem árul el többet, mint a `<5` osztály**.
2. **Kivonás elleni védelem (Q1 ↔ Q2, és a többi között):** (a) a Q1 (státusz-darabszámok) és a Q2 (ugyanezek **UTC-negyedév** szerint) **egymástól függetlenül** vödrözött; a Q2-ben minden `(eszköz, státusz, negyedév)` cella, amely **5 alatti**, **egyetlen `(suppressed)` időszak-sorba olvad** (az összevont cellák összege lehet 5 vagy több, ekkor a vödör ezt tükrözi), így egy Q1 és Q2 közötti kivonás vagy a cellák egymásból való kivonása **nem állítja vissza az 5 alatti cellát** (a pontos érték elrejtését a **vödrözés** adja, az **összevonás** azt rejti el, melyik negyedévben van a cella — lásd a modell-alapú pontosítást lent); (b) **egyik lekérdezés sem ír ki összeget a részei mellett:** a Q4 nem ír ki összes levonást, visszatérített darabszámot, 90 napos sort vagy különbség-értéket (a `indicative_gap` és az `n_spends`, `n_completed` oszlop **megszűnt**), a Q3 **nem** ír ki becsült élő / halott sort (a beszúrások mínusz törlések az élő sorok számát adnák, ezért a számlálók is vödrözöttek), a Q5 egyetlen vödör-címke; (c) a Q4 és a Q1 `completed` oszlopai közötti kivonás legfeljebb vödör-szintű különbséget ad, ami **nem fed fel 5 alatti cellát**; (d) az időfelbontás **negyedév**, soha finomabb.
3. **A maradék (kimondva):** a `<5` vödör azt még elmondja, hogy **1–4 sor létezik** (a `0` azt, hogy nincs) — ez maga a keresett jel (van-e magyarázat nélküli nem `completed` sor); az operátor, aki a saját beavatkozását ismeri, **semmi újat nem tanul**, és a kimenet a **pontos számot nem erősíti meg**. A **külső tudással** (pl. nyilvános felhasználószámok) végzett kivonás **nincs** lefedve.
4. **A futtató eszköz szűrője (UUID, e-mail, JWT-szerű, kulcs-szerű, hosszú hex) marad** mint második, független védelem; a korábbi „futtató-oldali `<5` maszkolás” **feleslegessé vált**.
*Tesztek (terv, DB-mentes):* (a) **forrás-teszt:** a SQL minden végső `SELECT`-je csak a vödör-címkét és a deklarált, nem-szám oszlopokat adja (nincs `count(` / `sum(` kimeneti oszlop; a Q0 `server_version_num` az egyetlen szám); (b) **vödör-tábla modell:** a `VALUES` lista szövegéből kiolvasott határok folytonosak, átfedésmentesek, a `[0, max]` tartományt lefedik, és a `0` külön osztály; (c) **kivonás-támadás szimuláció a modellben:** generált kis-cellás adathalmazokra (1, 3, 4, 5 soros csoportok, egyetlen és több cella) a **közzétett** kimenetekből (Q1 + Q2 + Q3 + Q4 + Q5) **nincs** olyan 1–4 érték, amely pontosan visszaállítható (minden elérhető értékhez van legalább két, a kimenettel konzisztens adathalmaz); (d) **mutációk (mind elbukik):** a Q2 összevonás nélkül (az 5 alatti cella külön sorban marad); pontos összeg kiírása a részek mellett; a Q3 élő-sor becslés visszakerül; a `indicative_gap` vagy az `n_spends` oszlop visszakerül; a vödör-tábla `<5` sávja `<4`-re szűkül; (e) **valódi DB** (csak külön jóváhagyással, izolált eldobható teszt-DB-n, **szintetikus** adattal: 1, 3, 4, 5 soros cellák, egy- és többcellás csoportok): a Q1–Q5 tényleges kimenete a modell várt vödör-címkéivel egyezik.

**Végrehajtási lehetőségek a census SQL-hez (TERV; EGYIKET SEM hozzuk létre, EGYIKET SEM futtatjuk; mindkettő külön, kifejezett jóváhagyást igényel).** **Alapelv:** egy `BYPASSRLS` jogú `LOGIN` szerepkör **nem kap közvetlen `SELECT` jogot a nyers `credit_ledger.metadata` oszlopra** (az nyers felhasználói szöveget hordoz: `topic`, `keyword`, `niche`, `channel_id`, `seed_keyword`). A korábbi `lr1_census_ro` terv (`BYPASSRLS` + oszlopszintű `SELECT` a `metadata`-ra is) **visszavonva**.
- **A) Egyszeri, felügyelt admin-olvasás, pontosan ellenőrzött SQL-lel.** *Mit jelent:* a **meglévő** adminisztrátori szerepkör (a legkisebb jogú meglévő, csak olvasó katalógus-ellenőrzéssel azonosítva) **egyetlen**, felügyelt munkamenete; **semmilyen új adatbázis-objektum** (szerepkör, séma, függvény, jog) **nem jön létre**. *Pontos ellenőrzés:* (1) a futtatott fájl SHA-256-ja **egyezik** a jóváhagyottal (a futtató eszköz a futás előtt kiszámolja és összeveti; eltérés → **nem indul**); (2) a végrehajtás kizárólag `psql -f` erre a fájlra, **nincs interaktív SQL, nincs más utasítás**; (3) a Q0 őr: `transaction_read_only = on` és `repeatable read`, különben megáll; (4) a `READ ONLY` tranzakció az **írást** védi, de az olvasható adatot **nem szűkíti** — ezért a védelem a hash-hez kötött SQL, a **felügyelet** (a felhasználó jelen van, a jelszót ő adja be, interaktívan), a v2 vödör-kimenet és a kimenet-szűrő, **nem a jogosultság**; (5) futás előtt `EXPLAIN` (`ANALYZE` nélkül) a terhelésre; csendes időszak; (6) futás után: a kapcsolat bezárva, a mentett kimenet redaktált (nincs gazdanév / projekt-azonosító), egy futás naplózva. *Előny:* nincs DB-változás, nincs szerepkör-életciklus. *Hátrány / maradék:* a munkamenet jogosultsága széles (ha a futtatott szöveg eltérne a jóváhagyottól, az nyers adatot is olvashatna — ezt a hash-ellenőrzés és a felügyelet zárja); ismétléshez új jóváhagyás. *Mikor:* ha a census egyszeri bemenet a D-r-hez.
- **B) Kizárólag aggregált kimenetet adó DB-felület, szűk szerepkörrel.** *Mit jelent:* egy dedikált, **nem exponált** séma (javaslat: `lr1_census`; **nem** szerepel a PostgREST sémái között) egy `SECURITY DEFINER`, `STABLE` függvénnyel (javaslat: `lr1_census.phase0()`), amely a fájl lekérdezéseinek logikáját futtatja és **csak vödör-címkéket és deklarált szöveges oszlopokat** ad vissza (nyers oszlop és szabad szöveg nincs). A függvény tulajdonosa az a szerepkör, amely a két táblát az RLS megkerülésével olvassa (a táblák tulajdonosa, ha `relforcerowsecurity = false`, vagy egy `BYPASSRLS` tulajdonos — csak olvasó katalógus-ellenőrzés); `SET search_path = pg_catalog, pg_temp`, minden objektum sémával minősítve. A `STABLE` függvény belső lekérdezései a hívó lekérdezés **egy** pillanatképét használják (PostgreSQL-dokumentáció), tehát az eredmény konzisztens. *A szűk login szerepkör* (javaslat: `lr1_census_exec`): `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOINHERIT`, **`NOBYPASSRLS`**, `CONNECTION LIMIT 1`, rövid `VALID UNTIL`, szerepkör-szintű `default_transaction_read_only = on` és időkorlátok; jogai: `CONNECT`, `USAGE` a `lr1_census` sémára, `EXECUTE` **kizárólag** a függvényre (a `PUBLIC` `EXECUTE` visszavonva); **semmilyen** tábla-, oszlop- vagy szekvencia-joga nincs (a nyers `metadata` tehát közvetlenül **nem** olvasható), nincs szerepkör-tagsága. *Ellenőrzés:* a függvény `md5(pg_get_functiondef(oid))`, tulajdonos, `prosecdef`, `proconfig`, ACL **pinje** a jóváhagyott értékkel (a 090 leltár-pin mintájára); a visszaadott oszlopok engedélylistán (mind szöveg); a fájl és a függvény logikai azonossága szöveg-egyezéssel (ugyanaz a vödör-tábla, ugyanazok a lekérdezések, normalizált alakon). *Létrehozás:* DB-változás (séma, függvény, szerepkör, jogok) — **külön jóváhagyott, fázisos**: előbb **izolált, eldobható teszt-DB** szintetikus adattal, majd a staging, majd a production, mindegyik külön jóváhagyással, a felhasználó / jóváhagyott operátor végrehajtásával; eltávolítás (`REVOKE`, `DROP FUNCTION`, `DROP SCHEMA`, `DROP ROLE`) szintén külön jóváhagyás. *Előny:* a login szerepkör **nem tud nyers adatot olvasni**, a futás ismételhető (a D-r-0 megfigyelés, és a későbbi 1. szakasz `S0`–`S4` census ugyanezzel a mintával), auditálható. *Hátrány / maradék:* több mozgó alkatrész; a `SECURITY DEFINER` hibalehetőségei (`search_path`, tulajdonos) — a pin és a katalógus-ellenőrzés zárja; a függvény a **tulajdonos** jogával olvas, ezért a függvény szövege a kritikus ellenőrzési pont.
- **Összehasonlítás:**
  | | A) egyszeri admin-olvasás | B) aggregált DB-felület |
  |---|---|---|
  | DB-változás | nincs | séma, függvény, szerepkör, jogok (migráció-jellegű) |
  | Ki olvashat nyers adatot | a munkamenet elvben igen (hash + felügyelet véd) | a login szerepkör **soha** |
  | Ismételhetőség | minden futás új jóváhagyás | a szerepkör / függvény megmarad, a használat kisebb kockázatú (a létrehozás jóváhagyása után is a futtatás külön döntés) |
  | Ellenőrizhetőség | fájl-hash | fájl-hash **és** függvény-pin, katalógus-ellenőrzés |
  | Kockázat | széles jog egyszer | létrehozási hiba / `SECURITY DEFINER` hiba |
  | Javaslat | egyszeri D-r bemenetnél | ha a census ismétlődik (megfigyelés, 1. szakasz) |
- **Közös szabályok:** mindkét úton a v2 vödör-kimenet, a kimenet-szűrő, az interaktív jelszó, a redaktált mentés, és **nincs futtatás** (stagingen sem) jóváhagyás nélkül; a futtatás előtt a staging szintaxis- és kimenet-alak próba is külön jóváhagyás. A kimenet semmilyen úton **nem kapu** (Q4–Q5 tájékoztató).
- *Tesztek (terv, DB-mentes, a következő kódlépésben; DDL még nincs):* a terv szövegében a login szerepkör (`BYPASSRLS`) **sehol** nem kap `SELECT`-et a `credit_ledger.metadata` oszlopra (forrás-teszt a dokumentumra és a későbbi DDL-re; mutáció: ilyen jog felvétele → elbukik); a B) lehetőség szerepkörének jog-listája üres a táblákra (modell: `tablePrivileges = ∅`, `executeOn = {phase0}`); a függvény kimeneti oszlopai engedélylistán; *valódi DB (külön jóváhagyás, előbb izolált teszt-DB, szintetikus adat):* `has_table_privilege` / `has_column_privilege` hamis a szűk szerepkörre a két táblán, **a `metadata` oszlopra is**; közvetlen `SELECT metadata` a szűk szerepkörrel `permission denied`; `EXECUTE` csak a függvényen; a függvény kimenete csak címke; a pin egyezik.

*Tesztek az SQL-fájlra (terv, DB-mentes, forrás-szintű; a következő, külön jóváhagyandó kódlépésben) — v3 kiegészítések:* (a) **a kapuk valódiak:** a Q0 és a Q0b egy-egy `DO` blokk `RAISE EXCEPTION`-nel, a Q0b feltétele a **pontosan 10** (nem „legalább”), `BASE TABLE`-ra; a `DO` blokk nem író (nincs `INSERT` / `UPDATE` / `DELETE` / DDL a törzsében); mutációk: a `<> 10` helyett `< 10` → elbukik (több oszlop átmenne); a `RAISE EXCEPTION` elhagyása → elbukik; a kapu a census lekérdezések **után** áll → elbukik; (b) **fix szótár:** a `tool_type` és a `status` oszlop **nem** szerepel a `SELECT` listán nyersen (csak `JOIN` / `WHERE` / `FILTER` / `IS NULL` helyen); a kimeneti értéket a szótár oldalról (`tv.value`, `sv.value`) vagy konstans címkéből (`(other)`, `(null)`) veszi; a szótár-listák **egyeznek** a migrációk SQL-jéből kiolvasott listákkal (026 `paid_results_tool_type_check` — 17 érték; 019 `status` — 4 érték); egy elcsúszás (új eszköz a CHECK-ben, a szótárban nincs) → a teszt elbukik, és a SQL új hash-t kap; mutáció: a szótár helyett a nyers oszlop kerül a kimenetbe → elbukik; (c) a fájl első utasítása `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, az utolsó `ROLLBACK`; **nincs** `INSERT` / `UPDATE` / `DELETE` / `DROP` / `ALTER` / `CREATE` / `TRUNCATE` / `GRANT` / `COPY` / `FOR UPDATE` / `SELECT *`; a `OUTPUT:` oszlopnevek mind egy engedélylistán belül (v2: `*_bucket`, `tool_type`, `status`, `period`, `relname`, `stats_reset`, `table_name`, `column_name`, és a Q0 három őr-oszlopa); a tiltott oszlopnevek (`user_id`, `input_hash`, `normalized_input`, `original_input`, `result_json`, `summary_json`, `source_run_id`, `external_ref`, `metadata`, `related_transaction_id`, `id`) **nem szerepelnek** `OUTPUT:` sorban; **nincs** pontos darabszám-oszlop (`n_rows`, `n_spends`, `n_completed`, `indicative_gap`, `n_live_tup`, `n_tup_*` bucket nélkül) az `OUTPUT:` sorokban; a `metadata` csak `metadata->>'feature'` alakban fordul elő; a fájl **hash-e egyezik a dokumentumban rögzítettel** (módosítás → a teszt elbukik, amíg a hash és a jóváhagyás nincs frissítve); a futásidejű kimenet-szűrő tesztje mintákkal (UUID, e-mail, JWT-szerű, kulcs-szerű, hosszú hex → megáll; sima számok / eszköznevek → átmegy); mutációk: egy `user_id` kerül az `OUTPUT:`-ba → elbukik; a `ROLLBACK` helyett `COMMIT` → elbukik.

**Külön megfékezési döntési pont — D-r (a felhasználóé; NINCS döntve; a B5 kapu).** **Az éles átvezetés VÉGREHAJTÁSA előtt** (a production előzetes import futtatása, az `enableCutover`, a karbantartási rés megkezdése) a termékfelelősnek **rögzítenie kell**, hogy az `LR-1` kitettséget a várakozás idején hogyan kezeljük. **A B5 a végrehajtást blokkolja, nem a biztonsági tervezést:** a terv, a modell és a DB-mentes tesztek, a census tervezése, a megfékezési opciók kidolgozása, az izolált teszt-DB-s igazolás (külön jóváhagyással) és az olvasó-leltárak **folytatódhatnak** D-r nélkül is — épp ezek adják a döntés bemenetét. A döntés bemenete a fenti census (0. szakasz, majd ahol lehet az 1.). Lehetőségek (nem kizárólagosak, mindegyik **külön jóváhagyást** igényel a megvalósításhoz):
| Opció | Mit csinál | Mit NEM véd | Mi kell hozzá |
|---|---|---|---|
| `D-r-0` elfogadás + megfigyelés | nincs változás; időszakos csak olvasó census; az elfogadás **indoklással, felelőssel, felülvizsgálati dátummal** rögzítve | a már meglévő és a jövőbeli out-of-band törlés kitettségét **nem** csökkenti | csak akkor megalapozott, ha a census nem mutat magyarázat nélküli törlést / nem `completed` sort |
| `D-r-1` DB-szintű törlés-/archiválás-megelőzés | a `service_role` `DELETE` (és a `status` módosítás) jogának elvétele vagy a bizonyíték-trigger **előre hozása** a `paid_results`-ra; a kód nem töröl (forrásból igazolt), a fiók-kaszkád a tulajdonosi jogkörrel fut | a `session_replication_role`, owner, superuser; a már megtörtént törlést nem állítja vissza | migráció (a 044 grant-pin és a 090 leltár-pin frissítése), valódi DB-s regresszió, **külön jóváhagyás**; a `service_role` DELETE jog elvétele más (nem route) hívót is törhet — előbb csak olvasó hívó-leltár |
| `D-r-2` az érintett eszköz forgalmának szüneteltetése | karbantartási üzenet; nincs új generálás | a többi eszköz; a szüneteltetés felhasználói költsége | termékdöntés; **nincs** legacy route-módosítás (a platform / környezeti kapcsoló módja külön vizsgálandó) |
| `D-r-3` legacy route őr | előzetes ellenőrzés a legacy kódban | — | **ma nincs megtervezve és nincs engedélyezve**: a legacy kódnak nincs bizonyítéka a „törölt” állapotról; csak külön engedéllyel és külön tervvel |
**Rövid összehasonlítás a várható felhasználói hatással (a census eredménye előtt: minőségi, nem mért):**
| Opció | A felhasználó mit lát / mit tapasztal | Ki viseli a kockázatot | Mikor ésszerű |
|---|---|---|---|
| `D-r-0` elfogadás + megfigyelés | **semmi változás**: a legacy út a hiányzó eredményre új fizetős futást kínál; ha volt korábbi levonás, a felhasználó **másodszor is fizethet** ugyanazért (a gyakoriság ismeretlen); a panaszt utólag, reaktívan kezeljük | a felhasználó (pénzügyi), a támogatás (utólagos terhelés) | ha a census nem mutat magyarázat nélküli nem `completed` sort / törlést, és a támogatási folyamat kész |
| `D-r-1` DB-szintű törlés-megelőzés | a normál felhasználó **nem lát változást** (az app nem töröl); a közvetlen, kézi törlés elbukik (operátori élmény); a **már meglévő** hiányt nem javítja | a fejlesztés / üzemeltetés (migráció, regresszió), nem a felhasználó | ha a census out-of-band törlést mutat, vagy a jövőbeli kockázat csökkentendő; **jóváhagyott migráció** kell |
| `D-r-2` az érintett eszköz szüneteltetése | az eszköz **nem használható** a szünetelés idejére (karbantartási üzenet); **nincs** új fizetős futás, tehát nincs újabb kettős levonás | a felhasználó (kiesés), a termék (forgalom) | ha a census ismert, magyarázatlan kitettséget mutat egy eszközön, és a kiesés elfogadható |
| `D-r-3` legacy route őr | (feltételes) az érintett kéréseknél blokkoló / figyelmeztető üzenet | — | **nincs engedélyezve és nincs megtervezve** |
*A felhasználói üzenetek mind **tervezetek**, nem kész szövegek: lásd a támogatási indulási kaput (`G-SUP`).*

**Támogatási ígéret — KÜLÖN INDULÁSI KAPU (`G-SUP`, 2026-10-07).** Az a mondat, hogy „a támogatás ellenőrzi az ügyet”, **ígéret**; az éles szöveg csak akkor állíthatja, ha **mind** teljesül: (1) **kijelölt felelős** (név / szerep, helyettes) és elérhetőség; (2) **működő egyeztetési folyamat**, leírva és kipróbálva: a bejelentés csatornája; a **felhasználó azonosítása** (az operátortól független, a `paid_user_restore_request` azonosítási szabályával egyező); a **csak olvasó** kreditmozgás-ellenőrzés lépései (a `credit_ledger` felhasználói sorai, az eszköz és időablak szerint; nyers `metadata` nem kerül a jelentésbe); a döntés (jóváírás / elutasítás) csak a jóváhagyott úton (D-d őrök); határidő (SLA) és eszkaláció; audit-nyom; (3) **végigpróbált kör** stagingen vagy tesztfiókon, a nyers eredménnyel és a visszajelzéssel; (4) **kapacitás**: a becsült érintett felhasználószám (a census alapján) kezelhető; (5) a termékben **megjelenik a kapcsolatfelvétel módja**. **Amíg a `G-SUP` nem teljesül:** a támogatási szöveg (`V1`) **nem kész, nem használható élesben**; a támogatás nélküli változat (`V0`) is **tervezet**, és az átvezetett, fail-closed `S3` út **zsákutcát** adna a felhasználónak — ezért az `S3` útvonal felhasználói szövege (és az útvonal élesítése) is a `G-SUP`-ra vár. A `G-SUP` nem feloldja a `B5`-öt (az a D-r), és nem engedélyezi az `enableCutover`-t.
*Tesztek (terv, DB-mentes):* minden felhasználói / támogatási szöveg-sablon hordoz egy `requires_gate` mezőt; a „támogatás” / „ellenőrzi az ügyet” állítást tartalmazó sablon **kötelezően** `requires_gate = 'G-SUP'`; a kapu alapértéke **nem teljesült**; a kapu-függvény csak a (1)–(5) mind igaz bemenetre ad igent (táblavezérelt: mindegyik hiánya külön elutasít); forrás-teszt: a `V1` szöveg nem fordul elő olyan kódúton, amely a kaput nem ellenőrzi; mutáció: a kapu alapértékét igazra állítva a teszt elbukik; mutáció: a „támogatás” szó egy kapu nélküli sablonba kerül → elbukik.

**A döntési pont feltétele:** a census eredménye rögzítve; a választott opció, a felelős, a felülvizsgálati dátum és az **elfogadott maradék kitettség** szövege rögzítve; a döntés **nem** engedi az `enableCutover`-t (az külön kapu), és **nem** módosít legacy route-ot. **Amíg a D-r nincs rögzítve, az éles átvezetés végrehajtása nem indul** (kapu: `B5`); a tervezés és a biztonsági munka nem áll le.
**Tesztek (terv, DB-mentes):** a census lekérdezés-szövegeinek forrás-tesztje (csak olvasó, nincs azonosító a kimenetben, `READ ONLY`); a census-eredmény alak-tesztje (csak számok, a „közelítés” címke kötelező a 0. szakaszra, nincs „nincs törlés” állítás nulla szám mellett); a kapu-modell: `B5` döntés nélkül a **végrehajtási** lépések (production import futtatása, `enableCutover`, karbantartási rés megkezdése) elutasítottak, a **tervezési / biztonsági** lépések (modell-futtatás, census-tervezés, izolált teszt-DB-s igazolás) **nem** (a modell ma nem ír ilyet: a következő, külön jóváhagyandó kódlépés; mutáció: a B5 a tervezést is blokkolja → elbukik); a dokumentumban az `LR-1` név, a „legacy route nem módosul” és a „a cutover blokkolása nem véd” állítás forrás-tesztje (egy ezt tagadó szöveg elbukik); **szöveg-tesztek az `LR-1` megfogalmazásra:** a felhasználói és az operátori szöveg tartalmazza a „korábban már fizethettél / korábbi levonás történhetett” és a „nem tudja megbízhatóan az eredményhez kötni” állítást, és **nem** tartalmaz a fenti tiltott megfogalmazást (forrás-teszt a dokumentumra, a riport- és üzenet-sablonokra, a route-válaszok szövegeire; mutáció: egy „kettős levonás történt” vagy „nincs levonás” szöveg beillesztése → elbukik); a három eset (a)–(c) **nem** képződik egyetlen verdiktre.

#### A ledger-kapcsolat kikényszerítése — konkrét PostgreSQL-mechanizmusok (TERV, nem igazolt garancia)

**PostgreSQL-dokumentáció (ellenőrizve):** „PostgreSQL does not support CHECK constraints that reference table data other than the new or updated row being checked” — a ledger-sor ellenőrzése tehát
**nem CHECK-kel** oldható meg; a dokumentáció UNIQUE / EXCLUDE / FOREIGN KEY használatát javasolja, egyszeri ellenőrzésre pedig triggert. Többoszlopos FK-ban egy NULL oszlop kihagyja az ellenőrzést
(`MATCH SIMPLE`); a hivatkozott oszlopoknak nem részleges egyedi kulcsot / indexet kell alkotniuk; a `RESTRICT` az azonnali, a `NO ACTION` halasztható; a **constraint trigger** AFTER ROW,
`DEFERRABLE INITIALLY DEFERRED` lehet, és a tranzakció végén fut; a trigger `WHEN` feltétele nem tartalmazhat alkérdést; a `STABLE` függvény a hívó lekérdezés pillanatképét használja, és nem módosíthat.
**Amit a lekérdezett oldalak nem mondanak ki:** hogy egy tárolt generált oszlop FK referáló oszlopa lehet-e — erre **nem építünk**.

| # | Mechanizmus | Mit ellenőriz | Mit NEM |
|---|---|---|---|
| 1 | **Egysoros CHECK** a generációs táblán: `(charge_link = 'linked') = (credit_transaction_id IS NOT NULL)`, `(charge_link = 'linked') = (credit_cost_evidence = 'ledger_linked')`, `(charge_link = 'free') = (credit_cost_evidence = 'free')`, `(charge_link = 'unlinked_legacy') = (credit_cost_evidence = 'legacy_unverified')`, `charge_link <> 'free' OR credit_cost = 0`, az értékkészletek | a három jelölés **belső** konzisztenciája | a ledger-sort nem látja |
| 2 | **FK** `credit_transaction_id → credit_ledger(id)` `ON DELETE RESTRICT` | a ledger-sor létezik, és nem törölhető | hogy `credit_spend`, `gop:<művelet>`, azonos felhasználó, `−delta = ár` |
| 3 | **UNIQUE:** részleges index `(credit_transaction_id) WHERE credit_transaction_id IS NOT NULL`, `UNIQUE (operation_id)`; a meglévő `credit_ledger.external_ref` UNIQUE | egy ledger-sor legfeljebb egy generációt támaszt alá; egy `gop:<id>`-hez egy levonás | tartalmi egyezés |
| 4 | *(opcionális keményítés, **nem a terv alapja**)* összetett FK: `credit_ledger` új UNIQUE `(id, external_ref, user_id, reason)`, a generációs táblán tárolt generált oszlopok és `FOREIGN KEY (...)`; `MATCH SIMPLE` miatt a NULL-os sorok kimaradnak | a ledger-sor azonossága deklaratívan | **a generált oszlopos FK dokumentációból nem megalapozott, valódi DB-n igazolandó**; a `credit_ledger` új indexe egy forró tábla módosítása (`CONCURRENTLY`, külön jóváhagyás) |
| 5 | **Halasztott constraint trigger a generációs táblán** (AFTER INSERT, `DEFERRABLE INITIALLY DEFERRED`, soronként): `linked` esetén a hivatkozott ledger-sor `reason = 'credit_spend'`, `external_ref = 'gop:' ‖ operation_id`, azonos `user_id`, `−delta = credit_cost`; `free` / `unlinked_legacy` esetén **nincs** `gop:<operation_id>` ledger-sor | a **cross-táblás** tartalmi egyezés, a tranzakció végén, a függvényen belüli utasítás-sorrendtől függetlenül | csak azt, ami a tranzakcióban keletkezett; a már létező, kézzel módosított sorokat nem |
| 6 | **Halasztott constraint trigger a ledgeren — SZŰK hatókörrel** (AFTER INSERT, **`WHEN (NEW.external_ref LIKE 'gop:%')`**, `DEFERRABLE INITIALLY DEFERRED`): minden **`gop:<id>`** levonáshoz a tranzakció végén léteznie kell a `linked` generációnak, és az eszköznek a regiszter szerint átvezetettnek kell lennie | **a D1/D2 `gop:` levonások és az átvezetett eszközök körében** nem commitolhat levonás eredmény nélkül (I2 DB-szinten); a `WHEN` alkérdés nélküli (csak `NEW.external_ref`), minden más ledger-sor (legacy `spend:`, `refund:`, `stripe:`, a 093 `op:` sorai) **nem fut a triggerre** | a legacy és a 093 levonásokra **nem** állítjuk ezt a garanciát (lásd a névtér-szakaszt) |
| 7 | **Jogosultságok és változtathatatlanság:** a generációs, művelet-, kvóta-táblákra `REVOKE ALL` PUBLIC / anon / authenticated / `service_role` alól; írni csak a definer függvények tulajdonosa tud; `BEFORE UPDATE OR DELETE` trigger elutasít | hogy a bizonyítékot csak a három DB-művelet állíthatja | a tulajdonos / superuser / megkerülő szerepkör (dokumentált maradék) |
| 8 | **RPC-szerep:** a levonó / ingyenes / import függvény a jelölést **az ágból** állítja; az 1–3. megszorítások és az 5–6. trigger **független** második réteg egy függvény-hibájára | két réteg | — |

**Hiba-osztályozás:** a halasztott trigger kivétele a tranzakció **végén** (commit-fázisban) jön, és a tranzakció visszagörgetődik; az RPC hibaválaszát a „bizonyított visszagörgetés” listán kell felismerni
(saját, egyedi SQLSTATE-tal), különben **bizonytalan kimenet**.

**Tesztek (terv):** *DB-mentes:* forrás-teszt a migrációs SQL szövegén (mint a 089 / 090 source-policy tesztek): a CHECK-ek, az FK, a UNIQUE-ok, a két constraint trigger (`DEFERRABLE INITIALLY DEFERRED`, a
ledger-oldali `WHEN`), a `REVOKE`-ok és a változtathatatlansági trigger megvannak; nincs bizonyíték-paraméter az aláírásokban; modell-invariáns a hármas konzisztenciára és a „levonás ⇔ generáció” kettős
kapcsolatra. *Valódi DB (külön jóváhagyás), negatív tesztek:* ellentmondó hármas → 23514; nem létező ledger-azonosító → 23503; ugyanaz a ledger-azonosító kétszer → 23505; **másik felhasználó** ledger-sora,
`credit_refund` reason, rossz `external_ref`, rossz összeg → kivétel a **COMMIT-nál** (nem az INSERT-nél; a teszt ezt külön ellenőrzi); `free` generáció mellett létező `gop:` ledger-sor → commit-kivétel; `gop:` levonás
generáció nélkül → commit-kivétel (árva `gop:` levonás kizárva); `service_role` INSERT / UPDATE / DELETE → 42501 (`has_table_privilege` mátrix); a halasztott trigger kivétele a hibaosztályozásban felismerhető, ismeretlen hiba →
bizonytalan. **Státusz: tervezett mechanizmus. Garanciaként csak akkor tekinthető, ha ezek a negatív tesztek valódi DB-n lefutottak;** a dokumentációs állítások a PostgreSQL-dokumentáción alapulnak, ebben az
adatbázisban nem igazoltak.

#### A `gop:` névtér, a névütközés a 093-mal és a ledger-trigger szűk hatóköre (javítás)

**Forrásból, a PR #8 `093_video_package_atomic_charge_save.sql`-ből (a stagingen alkalmazva):** a 093 saját `public.paid_operations` táblát hoz létre, és a `spend_credits`-t
**`'op:' || operation_id`** hivatkozással hívja (`:233`). A korábbi tervünk ugyanezt az `op:` előtagot tartotta volna fenn a D1/D2 levonásoknak, és ugyanezt a `paid_operations` nevet használta volna — ez
**ütközött** volna a 093-mal (a fenntartott névtér elutasította, a ledger-oldali trigger pedig a 093 levonásait is generációhoz kötötte volna). **Javítás (terv):**
- a D1/D2 levonások hivatkozása **`gop:<művelet>`**; a `spend_credits` wrapper a **`gop:`** névteret tartja fenn, az **`op:` a 093-é marad, érintetlenül**;
- a D1/D2 táblák neve egyedi: `paid_generation_ops` (a műveletsor), `paid_result_generations`, `paid_free_quota_use`, `paid_reconciliation_ticket` / `_audit`, `paid_tool_cutover`,
  `paid_tool_free_quota`, `paid_tool_import_state` — **a 093 `paid_operations` táblájához nem nyúlunk** (a két mechanizmus egyesítése továbbra is a D-b tárgya);
- a modell és tesztjei ma még `op:` hivatkozást és „műveletsor” fogalmat használnak: a következő kódlépésben `gop:`-ra kell cserélni.

**A ledgeroldali trigger hatóköre:** csak a **`gop:%`** hivatkozású sorokra fut (`WHEN (NEW.external_ref LIKE 'gop:%')`, alkérdés nélkül), a trigger-függvény pedig ezen felül ellenőrzi, hogy az eszköz a
regiszter szerint **átvezetett**; egy `gop:` sor csak az új commit-függvénytől és csak átvezetett eszközre keletkezhet. **Nem töri el a meglévőt:**
| Ledger-sor | Honnan | `WHEN` | Hatás |
|---|---|---|---|
| `spend:<uuid>` | `chargeFeature` (`lib/credits.ts`), `chargeProtectedFeature` (`lib/usage-protection.ts:264`) — a legacy levonások | hamis | nem fut a trigger |
| `refund:<spend>` | `refundCreditsAfterPersistenceFailure` (`lib/credits.ts:366`) | hamis | nem fut |
| `stripe:…` | a Stripe-kreditjóváírások (3 hívás a kódban) | hamis | nem fut |
| **`op:<uuid>`** | **a 093 `spend_credits_and_save_paid_result` RPC-je (stagingen alkalmazva)** | hamis | **nem fut; a 093 útja változatlan** |
| minden más (pl. SQL-oldali kezdőkredit) | — | hamis, hacsak nem `gop:` kezdetű | nem fut |
A kódban a `p_external_ref` előtagjait ellenőriztem (`spend:`, `refund:`, `stripe:`; a 093: `op:`); az SQL-oldali hivatkozásokat nem néztem végig — ez nem szükséges, mert a `WHEN` miatt a trigger
**egyetlen más hivatkozásra sem fut**, és a statikus teszt kikényszeríti, hogy a `WHEN` pontosan `gop:%`.

**A „levonás eredmény nélkül nem commitolhat” állítás hatóköre — addig szűk:** **kizárólag** a D1/D2 `gop:` levonásokra és az átvezetett eszközökre igaz. A legacy `spend:` levonásokra **nem**
állítjuk (a legacy út ismert maradéka a „levont, de el nem mentett” futás), és a 093 `op:` levonásaira sem (azok atomicitása a 093 saját RPC-jének tulajdona).

**Tesztek (terv):** *forrás-teszt* a migrációs SQL-en: a ledger-trigger `WHEN` feltétele **pontosan** `'gop:%'`, nincs szélesebb minta; a wrapper csak a `gop:` névteret tartja fenn, az `op:`-ot nem; a D1/D2
táblanevek nem ütköznek a 093-éval (`paid_operations`). *Valódi DB — **előbb izolált, eldobható teszt-DB-n**, stagingen csak a lent leírt külön jóváhagyott, kontrollált próbával:* a **meglévő** 090 / 091 / 093 integrációs tesztek **változtatás nélkül zöldek**
a migráció után; a 093 RPC teljes útja (**pénzmozgás és írás**: levonás + mentés + `paid_operations` sor, `duplicate`, `P0003`, ütközés-visszagörgetés) regresszió nélkül; egy `spend:` legacy levonás és egy 093-stílusú `op:` levonás generáció
nélkül **sikeresen commitol**; egy `refund:` és egy `stripe:` sor szintén; egy `gop:` levonás generáció nélkül **commit-kivétellel bukik**; egy `gop:` levonás nem átvezetett eszközre elutasított;
`pg_get_triggerdef` / `pg_trigger` ellenőrzés: a trigger `WHEN (new.external_ref ~~ 'gop:%'::text)`; a nem-`gop:` ledger-beszúrásoknál a trigger-függvény **nem hívódik** (hívásszám-statisztika);
a ledger-beszúrások teljesítménye nem romlik a nem-`gop:` sorokra.

**A 093 RPC-regresszió és a többi pénzmozgató valódi-DB teszt környezeti szabálya.** A 093 teljes RPC-futtatása **pénzmozgást** (kreditlevonás, ledger-sor) és **írást** (`paid_results`, `paid_operations`) okoz;
ugyanez igaz a `gop:` levonásos negatív tesztekre. Ezért:
1. **először izolált, eldobható teszt-DB-n** fut (mint a 093 korábbi preflightjának eldobható stackje): nincs valódi felhasználó, valódi egyenleg vagy szolgáltatói hívás;
2. a **stagingen csak külön, előzetesen jóváhagyott, kontrollált próbaként** futhat: kijelölt teszt-felhasználó és teszt-bemenet névtér, jóváhagyott teszt-kreditkeret, előtte és utána **csak olvasó** pillanatkép
   (egyenleg, ledger-sorok száma, `paid_results` és `paid_operations` sorok), megállási feltételek, és egyeztetési terv (a ledger-sorokat nem töröljük, hanem egyeztetjük); a „kredit-biztos tesztelés”
   elv szerint valódi felhasználó kreditjét nem érintjük;
3. a **jelen terv és jelentés semmilyen ilyen hívást nem engedélyez** — sem stagingen, sem productionben, és az izolált DB-n futtatás is csak külön kérésre indul;
4. **production:** csak olvasó katalógus-ellenőrzés; a 093 RPC hívása ott soha nem része a teszttervnek.

#### A leltár két további olvasója: döntések

- **Dashboard (`app/api/dashboard/summary/route.ts:44`) — ELDÖNTÖTT irány (D-l = (B) + (C)); a torzuló pénzügyi metaadat NEM elfogadott maradék.**
  Tényállás (forrásból): a lista csak `id, tool_type, original_input, created_at, last_opened_at, credit_cost, status` oszlopokat választ, **tartalmat
  (`result_json`, `summary_json`) nem szolgál ki**, és a listaelemek a (kapuzott) `?paidResultId=` újranyitásra mutatnak. **A `credit_cost` viszont pénzügyi
  metaadat:** a lista `credit_cost > 0` alapján állítja a „fizetős” / „ingyenes” állapotcímkét (`:341`), tehát egy eltért (vagy legacy íróval átírt) sor
  **hamis „ingyenes” vagy „fizetős” jelzést** mutathat arról, hogy a felhasználó fizetett-e. A `credit_cost` egy hordozott mező: a kapu a kiszolgált tartalmat védi,
  a listát nem. Ezért a lista nem maradhat a `credit_cost` mezőre épülő címkén. A megvizsgált változatok:
  **(A)** marad a közvetlen olvasás, a felhasználó **kifejezetten elfogadja** a torzulás kockázatát (rögzített döntés, forrás-teszt pineli az oszloplistát);
  **(B)** ellenőrzött lista: egy olvasó-függvény, amely átvezetett eszközre a **generáció pillanatképéből** adja a metaadatot, és `unverified`-del jelöli az eltért
  sort (a címke hamis értéket nem mutat); **(C)** a fizetős / ingyenes jelzés forrása a **ledger** (a generációhoz kötött levonás), nem a `credit_cost` mező;
  **(D)** a `credit_cost` és a belőle származtatott címke eltávolítása a listából. Külön, pénzügyi hatás nélküli hiba: a lista hibáját ma `data || []` nyeli (üres lista).
  **Eldöntött irány (2026-10-05): (B) + (C).** A lista átvezetett eszközre **ellenőrzött olvasóból** jön, a metaadat a generáció pillanatképéből, az eltért sort `unverified`-del jelölve
  (B); a fizetős / ingyenes / ismeretlen címke forrása a generáció `charge_link` / `credit_cost_evidence` jelölése, vagyis a DB-művelet tényleges ága és a ledger-kapcsolat, **nem a
  `credit_cost` mező** (C). Az (A) és a (D) elvetve. (Rögzítés: a terv javasolt irányát a felhasználó elfogadta; ha a (B)+(C) összevonás mást jelent, mint amit szántál, a rögzítés javítandó.)
  Címkék: `linked` → „fizetős”, `free` → „ingyenes”, `unlinked_legacy` és generáció nélküli `legacy_only` sor → **„ismeretlen”**, soha nem „fizetős” vagy „ingyenes”. Új tény, amely ezt
  indokolja: a `viral-score` legacy-cache backfillje a `credit_cost`-ot **keményen 1-re állítja** (`:314`), tehát egy ingyenes, kevés adatos legacy sor ma már „fizetősként” kerül a listára.
  Következmények: a dashboard `:341` címkelogikája cserélendő; a lista olvasója a G-REOPEN leltár része lesz (a „kivétel” megszűnik); a lista hibája nem képezhető üres listára.
- **PR #8 Video Package (nyitott draft, fej `61eef38`, ellenőrizve) — a `video_package` addig NEM vezethető át a D1/D2 generációkkal, amíg a két mechanizmus (093
  `paid_operations`) nincs egyesítve (D-b).** Addig passthrough, és a PR #8 olvasói a mai viselkedéssel működnek. A PR #8 olvasói, amelyek az egyesítéskor a
  kapura kötendők: a szigorú hash-olvasó (`getPaidResultByHashStrict`, kétszer: aktuális és legacy hash), a GET azonosító szerint (`video-package:484`), a
  **`chargeFeatureAndSavePaidResult` duplikátum-ága** (a `duplicate:true` válasz a RPC által visszaadott sort szolgálja ki, ellenőrzés nélkül — ezt az RPC-nek
  **ugyanabban a tranzakcióban** kell ellenőriznie, nem egy utólagos route-lépésnek), valamint a **22. olvasó:**
  `lib/opportunity-evidence/evidence-service.ts:49` (`getPaidResultById`; az `opportunity_engine` sor tartalmából bizonyíték-pillanatképet készít és ír).
  A szigorú olvasó hibafegyelme (hiba → 503, nincs levonás) összeegyeztethető a `read_error` szerződéssel. **A B4 leltárát a PR #8 beolvadása után újra le kell
  futtatni**: a tőle függő olvasók addig nem „átvezetettek”.

#### Teszterv-kiegészítések (a három pontra; csak terv, a tesztek még nem készültek)

- **`not_found` ≠ nincs korábbi levonás.**
  (T1) a `not_found` eredmény alakja pontosan `{ status: 'not_found' }` — nincs levonásra utaló mező (típus- és futásidejű kulcs-teszt);
  (T2) egy **levont, de el nem mentett** állapot (ledger-spend sor, `paid_results` sor és generáció nélkül) mellett a verdikt `not_found`, és a teszt ezt **KNOWN
  OPEN (D1/D2)** jelöléssel rögzíti, nem állítja, hogy ez rendben van; (T3) a route-válaszok és a naplók a `not_found` ágon nem állítanak „nincs levonás”-t
  (forrás-teszt a kimeneti szövegekre); (T4) tokenes atomikus úton ugyanaz az állapot nem létezhet (egy művelethez egy levonás), ezt a meglévő modell-tesztek
  fedik; (T5) a C-tábla „rendben” ítéletei a tesztekben csak „hiba / `unverified` nem jut levonásig” állításként szerepelnek.
- **F1 (`similar_videos`).** Háromállapotú gyorsítótár-olvasó tesztjei (200 + `[]` → `absent`; használható sor → `found`; minden más → `read_error`; soha nem dob, nincs
  titok); route-teszt: `read_error` → 503, és **egyetlen** `checkUsagePermission`, zár, YouTube-hívás vagy levonás sem fut; `absent` → a folyamat megy tovább;
  statikus teszt: a `similar-videos` keresési útján nincs hibát hiányra képező olvasó; mutációk: a hiba ismét `null`, a `read_error` ág a levonás után.
- **F2 (`viral_score`).** Statikus leltár: a `viral-score` útjában nincs legacy `savePaidResult(` (vagy mind generáció-tudó); route-teszt: legacy-gyorsítótár
  találatnál nincs `paid_results`-írási kísérlet átvezetett eszközön, és a válasz mezői (`from_paid_result`, `paid_result_id`) nem állítanak mentést; a
  modell-szintű tiltás (legacy írás átvezetett eszközön elutasítva) a meglévő tesztekben már rögzített.
- **Eszközönkénti kapu a modellben (később):** `enableCutover('similar_videos')` elutasítva F1 nélkül, `enableCutover('viral_score')` F2 nélkül; más eszköz
  nem kapja az F1/F2 követelményt; a globális B1–B4 minden esetben kell.
- **Dashboard (D-l = (B) + (C)).** (B) ellenőrzött lista: eltért sor → `unverified`, a metaadat a generáció pillanatképéből jön, a lista olvasója a leltár része (nincs közvetlen
  `paid_results` olvasás); olvasási hiba → nem üres lista, hanem hiba. (C) a címke a `charge_link` / `credit_cost_evidence` jelölésből jön: `credit_cost = 0` és `credit_cost = 3` mellett is
  azonos címke; `linked` → „fizetős”, `free` → „ingyenes”, `unlinked_legacy` és `legacy_only` → „ismeretlen” (három külön teszt); statikus teszt: a dashboard nem vezet le címkét a
  `credit_cost`-ból; a viral-score backfill állandó `1`-ese nem „fizetős” címkét ad.

## Cutover-blokkolók (a modellben végrehajtva: `enableCutover` elutasítja, amíg a katalógus-snapshot nem teljesíti a szabályokat)

**A terv jelenleg NEM cutover-kész.** Egyetlen eszköz átvezetése sem engedélyezhető, amíg az alábbiak mind nem teljesültek és nincsenek bizonyítva: B1–B4 és a **B5** (az `LR-1` megfékezési döntés, **D-r**: az éles átvezetés **végrehajtása** nem indul nélküle; a biztonsági tervezés igen); az F1 / F2 / F4 eszközönkénti kapuk; az F4
**forrás-leképezés** igazolása (addig a `LEGACY` csak egyeztetési becslés, felső korlát nincs); a **D-o** termékdöntés a forrás-eltérésről; az F4 **lefedési mátrix** minden sora — a „nem igazolt” sorok
(régi production telepítések kérés-naplója, teljes körű service-kulcs lefedés, Preview env-hatókör) addig **blokkolják** az `enableCutover`-t; a célzott operátori helyreállítás állapotgépe és versenytesztjei; a
valódi-DB igazolások (előbb izolált teszt-DB-n). A kapu alapértelmezése **blokkolt**, és mérhetően nem igazolható sor esetén az is marad. A határ-igazított karbantartás hibaszabálya (**D-p**) külön termékdöntés, amely nincs meghozva.

**Következő lépés (külön engedélyezendő):** a **modell és a DB-mentes versenytesztek hozzáigazítása a tervhez** (kódmódosítás a `tests/support/` alatt és a két tesztfájlban: `gop:` névtér, módos eszköz-zár,
`free` generáció és kvóta, a kísérlet állapotgép és a kerítés — `snapshotMode` mutációval és izoláció-őrrel —, a rollback-tilalom a `free` generációra, az `enableCutover` bizonyíték-sorai és zár alatti `S2` / `S3u` / `S3i` ellenőrzése, a hatókör-állapotok `S0`–`S4` (az `S3` szétbontva `S3u` / `S3i`) táblavezérelt tesztjei, a `resync` (`legacy_unverified` jelöléssel), az eltávolítás-bizonyíték és a bizonyítékos operátori helyreállítás tesztjei, a trigger megosztott eszköz-zára). **Nincs jóváhagyva:** az `enableCutover`, bármilyen élő vagy valódi
DB-teszt, és a deploy.

- **B1 — a spend-kerítés nincs megvalósítva és igazolva.** A mai katalógus (090:159, **forrásból származtatott, nem adatbázisból olvasott**) **nem**
  felel meg: nincs core, nincs commit függvény, a `spend_credits` közvetlenül hívható. A split a forró kredit-RPC-t módosítja minden legacy hívó számára,
  ezért kell hozzá: (i) SQL-terv és migráció (külön jóváhagyás); (ii) valódi DB-n a 037/091 szerződések regressziója; (iii) a 090 DB-integrációs teszt
  függvény-leltár pinjének (az összes publikus függvény tulajdonosa, `prosecdef`, ACL-je és törzs-md5-je) és a 045 ACL listájának szándékos frissítése;
  (iv) a valódi `pg_catalog`-ból vett snapshot (`provenance = 'pg_catalog_query'`) átmegy a `checkSpendFenceCatalog`-on. **Amíg ez nincs, semmilyen
  `tool_type` nem vezethető át, és a modellben engedélyezett átvezetés csak `simulated` bizonyítékú.**
- **B2 — a `paid_results` invariáns-trigger** valódi DB-n nem igazolt (a digest kanonikussága, megkerülő szerepkörök, az OLD/NEW alapú döntés).
- **B3 — a refund-őrök (D-d)** a meglévő `refund_credit_spend` módosítását igénylik.
- **B4 — G-REOPEN (D-g = igen):** a teljes fail-closed újranyitás **nincs megvalósítva**; az éles cutover előtt kötelező minden átvezetett `tool_type`-ra.
  **A B4 NEM teljesül pusztán staging-teszttől.** Mind a hét feltétel kell, külön bizonyítékkal:
  (1) **olvasók:** az összes érintett olvasó át van vezetve — 21 route-hely, 16 hash szerinti hely, és a dashboard-lista olvasója az eldöntött **(B) + (C)** irány szerint
  (nincs kivétel); a PR #8 beolvadása után a leltár újrafuttatva (az `evidence-service`, a szigorú olvasó, az atomikus duplikátum-ág); egy statikus teszt
  tiltja, hogy az `app/` és `lib/` bármely más helye a `paid_results`-ot közvetlenül olvassa és kiszolgálja;
  (2) **valódi DB-s igazolás:** **először izolált, eldobható teszt-DB-n**, majd stagingen **csak külön jóváhagyott, kontrollált próbával** igazolt a pillanatkép-konzisztencia, a
  passthrough-ekvivalencia, a határ-tábla minden sora, és mind a 19 mező eltérése (a pénzmozgást vagy írást okozó próbák szabálya: lásd a 093-regresszió környezeti szabályát);
  (3) **production jogosultságok:** a production katalógusból, csak olvasva ellenőrzött a függvény tulajdonosa, `SECURITY DEFINER`, `search_path`, `proacl` és
  `has_function_privilege` (`service_role` igen; `anon`, `authenticated`, `PUBLIC` nem), a regiszter- és generációs tábla jogosultságai és RLS-e, a 090/045
  leltár-pin egyezése, a `pg_auth_members` lánc, és a PostgREST-séma ismeri a függvényt (eredet: `pg_catalog_query`);
  (4) **telepítési sorrend:** a production migráció a route-telepítés **előtt** fut; a route-ok csak ezután;
  (5) **regiszter:** üres marad, amíg B1–B4 mind igazolt;
  (6) **eszközönkénti kapuk:** `similar_videos` → F1, `viral_score` → F2 (kötelező, lásd fent);
  (7) **dashboard:** az eldöntött (B) + (C) irány megvalósítva (ellenőrzött olvasó, `charge_link`-alapú címke);
  az `enableCutover` mind a hét bizonyítékot elvárja.
  A modellben az `enableCutover` B4-előfeltétele **még nincs bekötve** (külön, kódot módosító lépés).
- **`G-SUP` — támogatási indulási kapu (külön, a B5-től független):** az éles szöveg csak működő, kijelölt felelősű és kipróbált egyeztetési folyamat mellett állíthatja, hogy a támogatás ellenőrzi az ügyet; addig a szöveg (és az `S3` útvonal) nem kész. Lásd *Támogatási ígéret — külön indulási kapu*.
- **B5 — az `LR-1` megfékezési döntés (D-r) nincs meghozva.** Hiányzó eredmény mellett korábbi levonás is történhetett, amit a mai adatok nem kötnek megbízhatóan az eredményhez (*LR-1*, **ma élő kockázat**; nem „minden hiány kettős levonás”); a cutover blokkolása ezt a várakozás alatt **nem** védi ki. Kell: a csak olvasó S3-census (0. szakasz közelítések; 1. szakasz a generációs tábla után) lefuttatva **külön jóváhagyással** és rögzítve; a megfékezési opció (`D-r-0` … `D-r-3`), felelős, felülvizsgálati dátum és az elfogadott maradék kitettség rögzítve. A legacy route **nem módosul** engedély nélkül. **A B5 az éles átvezetés VÉGREHAJTÁSÁT blokkolja D-r döntésig** (production import futtatása, `enableCutover`, karbantartási rés megkezdése); a biztonsági **tervezést** (modell, DB-mentes tesztek, census-tervezés, opciók kidolgozása, izolált teszt-DB-s igazolás külön jóváhagyással) **nem**. A B5 feloldása sem engedélyezi az `enableCutover`-t.

## A mutációs ellenőrzés

Összesen 77 mutációt alkalmaztam a modellen (56 a korábbi körökben, 15 az azonosító-szerződésre, 6 az újranyitási kapura), a repón kívül tartott szkriptekkel (kerítés kikapcsolva, a CAS eltávolítva, a visszagörgetés eltávolítva, a kötés
lazítása, a zársorrend megfordítása, a commit és a visszalépés döntésének a zár **elé** hozása, a rollback régi szabálya, a katalógus-szabályok egyenkénti
eltávolítása, a mezőosztályok elrontása, a digest mezőinek kihagyása, az evidencia-címke hamisítása stb.). **75-öt elbuktatott legalább egy teszt** (az újranyitási kapura mind a 6-ot, köztük azt, amely a mai utat fail-closed-dá tenné: a pin addig bukik, amíg
a dokumentum és a tesztek tudatosan nincsenek frissítve). A két
túlélő **ekvivalens mutáns**: (1) „a commit saját projekció-írásának elutasítását figyelmen kívül hagyja” — a commit előbb beszúrja a generációs sort, így az
írás nem utasítható el; (2) „a `paidResultId` hiányzó sornál is visszaadódik” — hiányzó sornál a `projectionStatus` már eleve inkonzisztenst jelez (committed
műveletnek mindig van generációja), így a feltétel nem változtat. A szkriptek nem részei a repónak.

## Nyitott pontok, amelyekhez külön jóváhagyás kell

- **D-d:** a `refund_credit_spend` két új őre (op-levonás elutasítása, már meghozott emberi döntés elutasítása) a meglévő RPC módosítása.
- **B1** (fent): a wrapper/core split migrációja.
- **G-REOPEN (D-g = igen, B4)** (fent): kötelező az éles cutover előtt; megvalósítandó route-/DB-kapu. **Ma nem működik.** Nyitott: D-h (a hash szerinti olvasás is a
  hatókörben van-e), a megvalósítási terv jóváhagyása.
- **Eldöntött irányok (2026-10-05) — nem nyitott tételek:**
  (1) az **E2 import egyetlen tranzakcióban** hozza létre a generációt és a `paid_results` vetületet, azonos hatókörrel és zárral; önmagában egy generációs sor nem teszi megnyithatóvá a
  cache-eredményt;
  (2) a legacy `credit_cost` **nem bizonyít levonást** (leíró metaadat, a címke „ismeretlen”);
  (3) **P-3 = (b)**: a `low_data` ingyenes generáció csak 1. generáció lehet; a tranziens válasz kimondja, hogy az új eredmény nincs mentve, a `found` szöveg **csak korábbi mentett
  eredményt** állít, a „kifizetett” szó **kizárólag igazolt ledger-kapcsolat** (`payment_evidence = ledger_linked`) mellett szerepelhet; **csak** a
  `free_low_data_requires_first_generation` válhat tranziens választ, minden más RPC-hiba a saját hibaválaszát kapja, a bizonytalan kimenet pedig sem a mentést, sem a nem-mentést nem állítja;
  (4) a **`credit_cost_evidence` a DB-művelet tényleges ágából származik** (levonó → `ledger_linked`, ingyenes → `free`, import → `legacy_unverified`), nem a hívó állítása, és DB-szintű
  konzisztencia-megszorítás védi;
  (5) **P-1:** az ingyenes kevés adatos `viral_score` előzmény megmarad `free` generációként; **P-2:** a legacy-cache-only vásárlások előzménye megmarad importtal;
  (6) **D-m (javítva):** a legacy gyorsítótár írása az átvezetett eszközön megszűnik; **futásidejű import nincs** (kiadási ablaknyi sem): alapút a teljes előzetes import, a régi írók kizárása
  és a nulla maradékot igazoló végső census; kimaradt sor → fail-closed megállás és **célzott operátori javítás** (jegy, pontos hatókör, audit, zárak és zár utáni E3-ellenőrzés, route-hozzáférés nélkül — nem import-ablak újranyitás); futásidejű import csak új, külön döntéssel;
  (7) **F4:** a `similar_videos` és az `opportunity_engine` ingyenes útjai is `free` generációt kapnak (kötelező kapu az érintett eszközön); az engedélyezett (eszköz, ok) pár **önmagában nem védi** a
  napi / heti keretet: a jogosultság-ellenőrzés és a keret felhasználása **egyetlen atomikus DB-döntés**, versenytesztekkel (lásd az F4 szakaszt);
  (8) **D-l = (B) + (C):** ellenőrzött dashboard-olvasó, a címke a `charge_link` / `credit_cost_evidence` jelölésből jön.
- **F4 átállás — nyitott / blokkoló:** (a) a **forrás-leképezés** igazolása (melyik forrás pontosan melyik felhasználó–eszköz–ablak egyedi ingyenes futását jelenti; addig a `LEGACY` becslés, felső korlát nincs);
  (b) **D-o** (a forrás-eltérésű felhasználók keretének kezelése — termékdöntés, nem automatikus; döntés hiányában nincs zárolás és nincs cutover); (c) a **lefedési mátrix** nem igazolt sorai
  (régi production telepítések kérés-naplója, teljes körű service-kulcs lefedés, Preview env-hatókör) — **blokkolják az `enableCutover`-t**; (d) a határ-igazított időzítés (`F = B − 15 perc`, `E ≥ B`) és a
  karbantartási rés termékhatásának jóváhagyása.
- **Operátori helyreállítás — nyitott:** az állapotgép (`outcome_unknown`, tartós kerítés, csak olvasó egyeztetés, emberi döntés) és versenytesztjei megvalósítása előtt a célzott javítás nem engedélyezett;
  kerítés nélkül a kísérlet `outcome_unknown` marad.
- **`LR-1` és D-r (2026-10-06, harmadik kör; a felhasználóé, NINCS döntve):** ma élő kockázat — hiányzó eredmény mellett korábbi levonás is történhetett, amit a mai adatok nem kötnek megbízhatóan az eredményhez (nem „minden hiány kettős levonás”; a kitettség mértéke ismeretlen); a cutover-blokk nem véd; a B5 az éles átvezetés **végrehajtását** blokkolja D-r-ig, a biztonsági tervezést nem; csak olvasó S3-census (0. és 1. szakasz) és megfékezési döntési pont (`D-r-0`…`D-r-3`) **tervezve, nincs lefuttatva / eldöntve**; legacy route-módosítás nincs engedélyezve. Az `S3i` helyreállítása kétrétegű fail-closed: **D-q2 döntéséig** `recovery_policy_undecided`, utána **csak az érintett felhasználó azonosítható, új kérésével** (operátori jegy + audit önmagában nem elég); a tesztterv a hiányzó és a nem `completed` sorra külön bizonyítja, hogy kérés nélkül nincs INSERT / UPDATE.
- **Visszaengedés előzetes import után (2026-10-06):** az `M2` pontosítva (a `linked` / `free` generáció hiánya, nem bármilyen generációé); a visszaengedés engedett, az állapottábla (`S0`–`S4`), a `resync`, a trigger megosztott eszköz-zára és az `enableCutover` zár alatti `S2` / `S3` ellenőrzése **terv**, nem megvalósított; **D-q (a felhasználó javasolt iránya rögzítve, 2026-10-06; megvalósítás nincs):** az `S3` (törölt / archivált vetület generáció mellett): nincs automatikus `reproject`, kiszolgálás vagy levonás; a bizonyítottan szándékos eltávolítás (`S3i`) elkülönül az ismeretlen eredetű hiánytól (`S3u`), az utóbbi blokkolja az **adott eszköz** cutover-jét az egyeztetésig; helyreállítás csak bizonyítékkal és audittal; a `legacy_resync` generáció `unlinked_legacy` / `legacy_unverified`, fizetési állítás nélkül. **Pontosítva (2026-10-06, második kör):** az `S3` két fizikai állapota külön helyreállítást kap (`reproject_missing`: INSERT az **eredeti `id`-val**, amelyet a generációs tábla `projection_row_id`-ja és a bizonyíték OLD `id`-ja hordoz; `restore_status`: feltételes, előkép-auditált UPDATE csak a `status`-ra, eltérő tartalom → elutasítás), és az **`S3i` sem cutover-kész**: blokkol, amíg a D-q2 nincs eldöntve és a GET / POST / `force_refresh` / dashboard útmátrix három szinten nincs tesztelve. **Új nyitott: D-q2** (az `S3i` átvezetés utáni viselkedése; alapértelmezés fail-closed, a kapu blokkol) és az eltávolítás-bizonyíték (trigger, jegy) migrációja — a mai kódban és DB-ben **nincs** bizonyíték-forrás, ezért minden mai `S3` `S3u`; a modell- és versenytesztek a következő, külön jóváhagyandó kódlépés részei, a valódi-DB kétkapcsolatos teszt izolált teszt-DB-t igényel.
- **`fence_attempt` izoláció (2026-10-06):** a `READ COMMITTED`-őr, az önálló zár-utasítás + zár utáni friss olvasás, a `STABLE` csak olvasó egyeztetés külön hívása és a `lock_timeout` függvény-attribútum **specifikáció**; a kétkapcsolatos teszt **nincs lefuttatva**, a `lock_timeout` függvény-attribútumként való működése valódi DB-n igazolandó.
- **D-p (a felhasználóé, nyitott):** a határ-igazított karbantartás hibaszabálya — `T_gate`, `T_stop_max`, a visszaengedés és a leállítva-tartás előre meghatározott feltételei; döntésig a határ-igazított cutover nem indítható.
- **F1 (`similar_videos`) és F2 (`viral_score`):** az érintett eszköz **kötelező cutover-kapuja**, nem opcionális javaslat.
- **`not_found` ≠ nincs korábbi levonás:** a verdikt nem állíthat ilyet; a legacy úton a levont, de el nem mentett futás a D1/D2 ismert maradéka marad.
- **A zársorrend SQL-őre** (tool → op → scope) csak migráció mellett építhető meg; addig a modell-szintű őrteszt védi.
- **Nem modellezett:** a token aláírása (HMAC), az eszköz-cookie kiadása, a frontend, a két mechanizmus egyesítése (D-b): a D1/D2 táblák neve a névütközés elkerülésére egyedi (`paid_generation_ops` stb.), a 093 `paid_operations` táblája és `op:` hivatkozása érintetlen.
- **Valódi DB-re vár:** minden, ami a fenti „modellezett” jelzőt kapta.
