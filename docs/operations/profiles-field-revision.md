# profiles mezőrevízió (Creator Focus 2B, „V-trigger”) — telepítési és visszagörgetési runbook

Helyi munkacsomag (`supabase/migrations/094_profiles_field_revision.sql`). A trigger tényleges viselkedését DB-mentes
teszt **nem** bizonyítja (lásd „Nyitott”). A futási státuszt **ez a dokumentum** rögzíti („Futási státusz”), nem a migráció
szövege és nem egy forrás-teszt: így nem avul el, és az első futás nem kényszerít már átnézett fájl szerkesztésére.

## Futási státusz (itt frissítendő; futás után dátummal és a futtató megjelölésével)

| Környezet | Státusz | Megjegyzés |
|---|---|---|
| Eldobható, izolált helyi PostgreSQL (`scripts/profiles-field-revision-probe.sql`, P1–P12) | **futott: 2026-10-18, 4 eldobható konténer, PostgreSQL 17.6** | a 094 és a 16 ellenőrzés elsőre lefutott (minden konténerben 16 `PROBE_PASS`, `PROBE_RESULT\|checks=16`, kilépés 0); a guard `violations=0`, `public_functions=110`; részletek és a nem igazolt pontok az átadásban. A konténerek törölve. Nem futott: P7, P11, P12. |
| A 090 teljes DB-teszt-suite, a hozzá bedrótozott stacken | **nem futott** | külön, megfelelő stacken igazolandó; **a kihagyott (skipped) teszt nem PASS** |
| Staging | **nem futott** | kizárt, amíg külön nem engedélyezik |
| Production / szolgáltatói adatbázis | **nem futott** | kizárt |
| Független review-k | 2 kör (szöveg alapján) | a legutóbbi javítások utáni állapotot újabb olvasó review még nem látta |

Nincs commit, push vagy PR ehhez a csomaghoz.

## Mit ad, és mi nem része

A 2B tiszta döntési mag (`lib/creator-focus/decision-*.ts`) egy megerősítést a `(felhasználó, mező, csatorna,
értékujjlenyomat, mezőrevízió)` kötéshez ír. Ehhez a `profiles` soron **mezőnkénti revízió** kell
(`specific_focus_revision`, `main_category_revision`).

Ennek a csomagnak **nem része**: döntéstábla, audit, nyugta, RPC, API, UI, profilíró-módosítás, a `lib/creator-focus`
módosítása, bármilyen adatátírás.

## Invariánsok

| # | Invariáns | Hol érvényesül |
|---|---|---|
| R1 | Egy mező revíziója **új**, ha a mező értéke megváltozik (`IS DISTINCT FROM`, NULL is érték). | BEFORE trigger, ellenőrzi az AFTER trigger |
| R2 | **Soha nem használódik újra**: az `A → B → A` értékváltás három különböző revíziót ad. Közös, `CACHE 1`, `NO CYCLE` `bigint` szekvenciából jön, amit sosem állítunk vissza. | szekvencia + R1 |
| R3 | Ha az érték **nem** változik, a revízió sem (a profilűrlap minden mentésnél minden mezőt visszaír; ez nem érvénytelenítheti a megerősítéseket). | BEFORE trigger, AFTER ellenőrzés |
| R4 | A revíziót a **kliens nem állíthatja**: INSERT-nél mindig friss, UPDATE-nél a trigger felülírja. | BEFORE trigger |
| R5 | A két mező revíziója soha nem azonos, és csak már kiosztott, pozitív érték lehet. | AFTER trigger, CHECK, UNIQUE index |
| R6 | A revízió **egyedi, nem rendezett** azonosító: csak egyenlőségre szabad használni (a sorszám kiosztása nem commit-sorrend, a rollback lyukat hagy). | szerződés (a tiszta mag is így használja) |
| R7 | Olvasása mindig **`::text`**: a PostgREST a `bigint`-et JSON számként adja, ami 2^53 felett veszteses. | jövőbeli olvasó (nem része ennek a csomagnak) |

**A tiszta mag `REVISION_PATTERN`-je és az adatbázis tartománya.** A mag store-független kanonikus tizedes alakot fogad
el (`0` vagy 1–19 számjegy, egyenlőségre használva); a `"0"` is érvényes alak, és a tiszta tesztek használják. Az
adatbázis ennél szűkebb: a szekvencia 1-ről indul és mindkét oszlopon `CHECK (> 0)`, tehát `0` sosem kerül ki. A mag
szigorítása a már pusholt #13 szerződését változtatná haszon nélkül (egy `0` pillanatkép-revízió csak egy `0` esemény-
revízióval egyezhet), ezért **nem módosítjuk**; a tartományviszonyt teszt rögzíti.

## Séma- és íróaudit

- A `profiles` sorokat **kizárólag a `handle_new_user()` (001, SECURITY DEFINER) hozza létre**. Az alkalmazás
  (`app/`, `lib/`) összes írója `UPDATE` (`POST /api/profile`, `resolve-niche-review`, `discover-niche`,
  `confirm-channel`, `resolve-mismatch`, `lib/channel-profile-sync.ts`); a 041 szerint `authenticated`/`service_role`
  csak SELECT/UPDATE jogot kap. INSERT/UPSERT az alkalmazásban nincs.
- **Az e2e fixture-ök viszont használnak `INSERT … ON CONFLICT (user_id) DO UPDATE`-et** (nyers SQL `psql`-en át, eldobható
  helyi stacken): `e2e/support/db.ts` (`seedProfileOnboarded`) és `e2e/support/credit-fixtures.ts`
  (`seedOnboardedProfile`). Mindkettőben a sor már létezik (a `handle_new_user` hozta létre), a `DO UPDATE` csak
  `onboarding_completed`-et (és `channel_name`-et) állít, a fókusz- és kategóriaoszlopot nem. **Nyomkövetéssel (NEM
  igazolt, DB kell hozzá):** a BEFORE INSERT trigger előbb lefut és két szekvenciaértéket elhasznál; a konfliktus
  után a BEFORE UPDATE trigger a változatlan fókusz-/kategóriaoszlopokat látja, ezért a **régi revíziókat tartja meg**;
  az AFTER INSERT nem, az AFTER UPDATE lefut és átmegy. Ezt a `tests/094-…-source-policy.test.ts` driftőrként
  rögzíti (a két ismert utasítás fix lista, nem nyúlhat a fókusz-/kategóriaoszlophoz), és a próbamátrix is tartalmazza.
- Egyetlen meglévő trigger van a `profiles`-on a migrációs előzményekben: `profiles_updated_at` (BEFORE UPDATE). Az új
  BEFORE trigger neve (`profiles_zz_revision_assign`) úgy rendeződik, hogy **utolsónak** fusson. A staging/production
  kézzel létrehozott triggereit nem ismerjük; ezért kell az előzetes `pg_trigger` lekérdezés.
- Az űrlap-mentés minden mezőt visszaír, ezért **csak értékváltozásra** adunk új revíziót (R3).
- `select('*')` olvasók (a dashboard oldalak) **megkapják** az új oszlopokat (és a Realtime payload is hordozhatja);
  a TypeScript típusok szándékosan nem változtak. A döntési réteg `::text`-ként olvas, nem `select('*')`-gal.
- **Ez a trigger az egyetlen védelem** az ellen, hogy az `authenticated` szerepkör (táblaszintű UPDATE joggal, 041)
  közvetlenül beírja a revíziós oszlopokat: oszlopszintű `REVOKE UPDATE` táblaszintű GRANT mellett nem lehetséges.
- Információ: a közös szekvencia értékei felhasználók közt szivárogtatják az írási forgalom nagyságrendjét (nem titok,
  de ismert).
- Meglévő sorok hátterezése: **volatile oszlop-DEFAULT** (`nextval`) az `ADD COLUMN`-ban (táblaújraírás, soronként más
  érték), nem `UPDATE`, ezért a `profiles_updated_at` nem fut és az `updated_at` nem változik; a DEFAULT utána eldobva.

## 090 zárt függvény-allowlist és DB-integrációs teszt (kezelve, merge-blokkolóval)

A 090 egy zárt, 77 függvényes allowlistet és hash-eket rögzít (a már alkalmazott, **nem módosított** 090 fájlban), és a
`tests/090-public-schema-privilege-hardening-db-integration.test.ts` ezt a migráció törzsének újrafuttatásával is
ellenőrzi. A 094 két új public függvényt hoz, ezért a teszt **igazítva van, az allowlist gyengítése nélkül**:

- `PRE_094_UNDO_SQL`: a két trigger és két függvény eldobása **kizárólag abban a hat visszagörgetett tranzakcióban,
  amely a `MIGRATION_BODY`-t újrafuttatja** (explicit, név szerint: `runBodyAfter`, apply, PUBLIC-revoke, reapply, a
  „szigorúbb” és a „szélesebb” default-ACL forgatókönyvek), hogy a 090 saját ellenőrzése a 090-kori függvénykészletet
  lássa. **Nem** injektálja a `psql()` burkoló: a guard-injektáló, a `TRUNCATE`-szerepkör, a keeper-olvasó forgatókönyvek,
  az élő pin-/számláló-ellenőrzések, az auth-trigger és a PostgREST-negatívok a **valódi, 094 utáni katalógust** látják.
  A valódi, commitolt 094 objektumokhoz nem nyúl (visszagörgetés), és a 090 ellenőrző logikája változatlanul fut. A hat
  hely számát és sorrendjét a `094-…-source-policy` teszt rögzíti.
- `PIN_094_APP`: a két függvény tételes, pontos pinje (aláírás, tulajdonos, fajta, security mód, volatilitás,
  `search_path`, ACL, törzs-md5), nem wildcard. A törzs-md5-öt ugyanaz a módszer adta, amely mind az 5 CI-ben már élőben
  megerősített PR #8 (092) pint reprodukálta. **Még nem erősítette meg élő katalógus**; eltérésnek buknia kell, nem
  lazítani. A `094-…-source-policy` teszt tartja szinkronban a pineket a migráció szövegével.
- Számlálók: `public_functions` 108 → **110**, alkalmazási függvények 77 → **79** (ez a 094-es állapotot kódolja: a
  „pin” és „számláló” ellenőrzések **094 nélkül** a stacken elvárt módon elbuknak; a **rollback-es** MIGRATION_BODY
  forgatókönyvek az `IF EXISTS` undo miatt 094 nélkül is futnak). A 094 visszavonásával a pineket és a számlálókat
  vissza kell állítani.
- A „valódi 090 fájl újraalkalmazása” teszt visszagörgetett `MIGRATION_BODY`-futtatásra váltott (a régi forma
  commitolta volna a 094 függvények eltávolítását).

**MERGE-BLOKKOLÓ (nyitott, nem rendezett):** a PR #8 (092/093, `feat/opportunity-evidence-snapshot`) **ugyanazt a
teszt-fájlt** módosítja ugyanezekkel a PIN-/számláló-/reapply-részekkel (`PRE_092/093_UNDO_SQL`, `PIN_092/093_APP`,
számlálók 114 / 83, átírt reapply-teszt). A két módosítás **textuálisan ütközik**, és az összevont számlálókat újra kell
számolni a tényleges pinekből (becslés, nem újraszámolt: `public_functions` ≈ 116, alkalmazási függvények ≈ 85).
Ezt a közös ág még **nem** rendezte; nem állítjuk, hogy rendezett.

## Telepítés

**Sorrend.** A migráció additív; az alkalmazás nem írja az új oszlopokat, és a döntési réteg még nem olvassa, ezért nincs
alkalmazás-oldali előfeltétel és nincs „előbb DB, utána app” kényszer. A `select('*')` kliensek megkapják az új
oszlopokat, ez ártalmatlan. Az eddig deployolt alkalmazás UPDATE-jei változatlanul működnek.

**Szám.** A fájl száma (094) ideiglenes: a 092/093 egy még nem merge-elt ágon van (`feat/opportunity-evidence-snapshot`,
a 093 stagingen alkalmazva; production 091-ig). Nincs CLI migrációs előzmény, ezért a sorrendet eszköz nem őrzi. Szabály:
a végleges számot a merge pillanatában osszuk ki (`max(main + nyitott PR-ok migrációi) + 1`); megosztott környezetre
csak akkor alkalmazható, ha minden kisebb számú, már merge-elt migráció ott is megvan. Átnevezéskor a 094-es tesztek
(`MIGRATION_FILE`) és a hivatkozások együtt módosítandók.

**Zárak és időkorlát.**
- `SET LOCAL lock_timeout = '5s'`: a zár megszerzésére várás felső határa; ha nem sikerül, a migráció hibával megáll és
  semmit nem hagy hátra.
- `SET LOCAL statement_timeout = '60s'`: **minden** utána következő utasításra (táblaújraírás, indexek, a meglévő
  adat ellenőrzése: mind O(sorok száma)); túllépés esetén a teljes migráció visszagördül.
- `LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE` közvetlenül ezek után, **a pre-ellenőrzések előtt**, így a
  pre-ellenőrzés és a változtatás között nem jöhet létre később rendezett BEFORE trigger, revíziós oszlop vagy
  szekvencia-változás.
- **A zár tartamának felső becslése:** a `statement_timeout` **utasításonként** érvényes (egy `DO` blokk egy utasítás);
  a nehéz utasítások a hátterezés/újraírás (`ADD COLUMN`), a CHECK-ellenőrzés, a két index, a két pillanatkép-szám és a
  post-check: nagyságrendileg 6 × 60 s = **~360 s**, plusz a kliens utasítások közti késleltetése és a `COMMIT` ideje,
  amelyeket a `statement_timeout` **nem** korlátoz (kliens oldali szünetre az `idle_in_transaction_session_timeout` az
  egyetlen korlát). A teljes tranzakcióidő és a zártartam tehát **nem korlátos 60 másodpercben**.
- **Fennmaradó korlát:** a kizárólagos zár a `LOCK`-tól a `COMMIT`-ig tart, vagyis legfeljebb az utasítások idejének
  összege; ez alatt a `profiles` **olvasása és írása is blokkol** (a dashboard minden oldala olvassa). A sorok száma
  ismeretlen: **az időt egy másolaton kell mérni**, és alacsony forgalmú ablakot kell választani.
- A meglévő adat változatlanságát **sorokra bontott, memóriakorlátos** ellenőrzés vizsgálja: soronként egy 64 bites
  md5-részlet (a sor jsonb-szövegéből), amit `numeric`-ként összegzünk (nincs egyetlen, az egész táblát tartalmazó
  `string_agg`, sorrendfüggetlen). Ez **változás-detektálás**, nem kriptográfiai bizonyíték; a memóriája a legnagyobb
  sorral arányos, az ideje a sorok számával.

**Előzetes, csak olvasó ellenőrzések** (futtatás külön jóváhagyással, nem futtattam):

```sql
SELECT count(*) FROM public.profiles;                                   -- a táblaújraírás költsége
SELECT tgname, tgenabled, tgtype FROM pg_trigger
 WHERE tgrelid = 'public.profiles'::regclass AND NOT tgisinternal ORDER BY tgname;   -- várt: csak profiles_updated_at
SELECT pid, state, xact_start, left(query, 80) FROM pg_stat_activity
 WHERE xact_start < now() - interval '1 minute' AND pid <> pg_backend_pid();         -- hosszú tranzakciók
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name LIKE '%\_revision';  -- várt: üres
SELECT to_regclass('public.profiles_field_revision_seq');               -- várt: NULL (vagy egy korábbi alkalmazásból)
```

**Utóellenőrzés** (csak olvasó; a migráció saját fail-closed utóellenőrzése mellett):

```sql
SELECT count(*) AS rows, count(DISTINCT v) AS distinct_values
  FROM (SELECT specific_focus_revision AS v FROM public.profiles UNION ALL SELECT main_category_revision FROM public.profiles) s;  -- rows = distinct_values
SELECT tgname, tgenabled, tgtype FROM pg_trigger WHERE tgrelid = 'public.profiles'::regclass AND NOT tgisinternal ORDER BY tgname;
   -- várt: profiles_updated_at, profiles_zz_revision_assert (21, 'O'), profiles_zz_revision_assign (23, 'O')
SELECT proname, prosecdef, proconfig, proacl FROM pg_proc WHERE proname LIKE 'profiles_field_revision_%';
SELECT last_value, is_called FROM public.profiles_field_revision_seq;
```

és a `scripts/public-schema-privilege-guard.sql` 0 szabálysértéssel (az új függvényeknek és a szekvenciának nem lehet
PUBLIC/anon jogosultsága); a `public_functions` kimenet 110. Ez **nem ellenőrzött**: a guard és a 090 DB-tesztek
viselkedése az új objektumokkal DB nélkül nem bizonyított.

## Próbamátrix az első, izolált helyi PostgreSQL-futáshoz (külön jóváhagyás kell; a státusz fent)

**Környezet (a user iránya):** eldobható, izolált helyi PostgreSQL, **szintetikus adattal**; **nem** a közös
`supabase_db_WillViralFinal` konténer (a 090 DB-tesztek oda vannak kötve), főverzió ≥ 17 (a 090 `MAINTAIN` jogához),
Supabase-szerepkörökkel (`anon`, `authenticated`, `service_role`, `postgres`), 001–091 után a 094. Staging, production
és szolgáltatói adatbázis **kizárt**. A 092/093 együttes alkalmazása külön döntés.

**Ez a próba NEM a 090 DB-teszt-suite futtatása.** A `tests/090-public-schema-privilege-hardening-db-integration.test.ts`
a közös helyi Supabase stackhez van kötve: `docker exec` a `supabase_db_WillViralFinal` konténerbe, plusz HTTP a
`127.0.0.1:54321` auth/PostgREST végpontra; egy sima izolált PostgreSQL ezt nem adja. Ha a stack nem érhető el, az egész
fájl `describe.skip`-pel kimarad, ami „zöld”-nek látszhat **nulla lefutott teszttel — a kihagyott teszt nem PASS**. A teljes
090 suite külön, a hozzá való stacken igazolandó (és ott „nem skip” ellenőrzéssel: lefutott teszt > 0, kihagyott = 0;
CI-ben ezt a `scripts/ci-skip-guard.ts` végzi), a javított állapot áttekintése után, külön jóváhagyással. CRLF-es Windows
checkouton a `MIGRATION_BODY` kinyerése is kivételt dob; ehhez LF checkout kell.

**A helyi próba saját, nem átugorható SQL-ellenőrzései:** `scripts/profiles-field-revision-probe.sql` (16 ellenőrzés, egy
tranzakció, `ROLLBACK`-kal zárva, szintetikus felhasználóra) és `scripts/public-schema-privilege-guard.sql`. A próba
**csak akkor PASS**, ha mind igaz: a `psql` kilépési kódja 0; pontosan 16 darab `PROBE_PASS|C01` … `C16` sor, egyszer-egyszer,
sorrendben; az utolsó kimeneti sor `PROBE_RESULT|checks=16`; a guard kimenete `GUARD_RESULT|violations=0` és
`public_functions=110` (001–091 + 094 alapon). Bármilyen `PROBE_FAIL|`, hiányzó sor, eltérő darabszám vagy nem nulla kilépés
**FAIL**; „kihagyott” állapot nincs. A szkript szövegét a `094-…-source-policy` teszt rögzíti (16 ellenőrzés, ROLLBACK, nincs
COMMIT, nincs elnyelt hiba a két várt-hiba elkapáson kívül); a **futása** nem bizonyított.

| # | Próba | Elvárt eredmény |
|---|---|---|
| P1 | A teljes fájl szintaxisa és futása (`tgattr::int2[]` cast, `name COLLATE "C"`, `plpgsql record` változók, `regrole` szerepkörök, `bit(64)` idióma) | `COMMIT`, hiba nélkül |
| P2 | N szintetikus sor (10, 1000, 100k): 2N különböző pozitív revízió; **minden más oszlop, az `updated_at` is, bitre azonos**; a `profiles_updated_at` nem futott; idő- és zárprofil; a digest memóriája nagy N-nél | igaz; `statement_timeout` nem lép be a tervezett méretig |
| P3 | Triggersorrend: no-op UPDATE (csak `onboarding_completed`) | `updated_at` nő, revíziók változatlanok |
| P4 | Viselkedési mátrix: INSERT kliens-revízióval; UPDATE kliens-revízióval; `A → B → A`; NULL ↔ érték; azonos értékű újramentés; több mező egy UPDATE-ben; többsoros UPDATE; **`INSERT … ON CONFLICT (user_id) DO UPDATE` pontosan az e2e fixture-ök két utasításával**; `MERGE`; `COPY` | R1–R5 teljesül; az e2e utasításoknál a revíziók változatlanok, két szekvenciaérték elhasználva |
| P5 | AFTER-őr negatív próbák visszagörgetéssel: az assign trigger letiltva, majd az „érték változott, revízió nem” és a fordított eset; mindkét trigger letiltva és `session_replication_role = replica` | az őr kivételt dob; a kettős letiltásnál csendes bypass (dokumentált határ) |
| P6 | Párhuzamosság: két munkamenet ugyanarra a sorra (READ COMMITTED, REPEATABLE READ), váltakozó értékekkel | sorozatos, egyedi revíziók, nincs hamis őr-kivétel |
| P7 | Zár alatti viselkedés: a migráció futása közben egy másik munkamenet `SELECT`-et és `UPDATE`-et próbál a `profiles`-on | mindkettő a `COMMIT`-ig vár (a blokkolás időtartama mérve), utána a végleges adatot látja |
| P8 | `scripts/public-schema-privilege-guard.sql` a 094 után (az izolált adatbázison); a 090 DB-teszt-suite itt **nem** fut (lásd fent) | `violations=0`, `public_functions=110` |
| P9 | A dokumentált visszagörgetés + újraalkalmazás | a szekvencia megmarad, az új revíziók nagyobbak a korábbi legnagyobbnál, az indexek/CHECK-ek eltűnnek majd újra létrejönnek |
| P10 | Hibainjektálás: előre létrehozott `profiles_specific_focus_revision_key` név; szándékos hiba az utóellenőrzésben | teljes visszagörgetés, szekvencia sem marad |
| P11 | `pg_dump | pg_restore` triggerekkel (alapértelmezett) és `--disable-triggers`-szel | a revíziók viselkedése és az AFTER-őr dokumentálva |
| P12 | `NOTIFY pgrst` | egyszeri kézbesítés `COMMIT`-kor |
| P13 | **`authenticated` szerepkör UPDATE-je** RLS-en át (`profiles_update_own`): a trigger a függvényhez EXECUTE jog és a szekvenciához bármilyen jog nélküli szerepkörrel is működik; a kliens közvetlen revízió-írása figyelmen kívül marad (a próba C13-ja) | új revízió értékváltozásra, változatlan változatlanra, nincs `permission denied`; a próba C13 PASS |
| P14 | **Üres tábla (N = 0) és egysoros tábla (N = 1)** a migráció alkalmazásakor: két külön, tiszta adatbázison | `COMMIT`; N = 0: nincs sor, `coalesce(sum…, 0)` jó, a triggerek működnek az első beszúrt soron; N = 1: két különböző pozitív revízió, minden más oszlop (az `updated_at` is) változatlan |
| P15 | **`statement_timeout` negatív kontroll:** egy MÁSOLATON a `statement_timeout = '60s'` sort rövid értékre írva (a repó fájlja érintetlen), alkalmazva szintetikus adatbázison | A teljes tranzakció visszagördül: nincs oszlop, trigger, függvény, index, és a szekvencia sem jön létre (a `CREATE SEQUENCE` is a tranzakcióban van). **Az üzenet az értéktől függ:** az első futáskor (300 szintetikus sor) `1ms`-nál `canceling statement due to user request`, `3ms`-nál `canceling statement due to statement timeout` (mindkettő teljes visszagördüléssel); `20ms` már elég gyors volt, a másolat **lefutott és véglegesült**; `100ms` és `1s` mellett az újrafuttatás a már meglévő objektumok miatt fail-closed hibát adott. Nagyobb táblán (néhány ezer sor vagy több) a `1ms` negatív kontroll még nem futott. |
| P16 | **Teljes-lock / `lock_timeout` negatív kontroll:** egy másik munkamenet `ACCESS SHARE` zárat tart a `profiles`-on 8 s-ig | a migráció `lock_timeout` (5 s) miatt hibával áll meg, semmit nem hagy hátra |

## Visszagörgetés

**Feltételek.** A visszagörgetés csak akkor szabad, ha vagy még nincs tartós döntésadat, vagy tudatosan lekapcsoltuk a
döntési réteget. Az oszlopok eldobása után a pillanatkép nem állítható elő, ezért a réteg fail-closed letilt; újraalkalmazás
után **minden korábbi megerősítés érvénytelen**, mert az új revíziók ugyanabból a szekvenciából jönnek, és sosem
egyeznek a régiekkel. Ez biztonságos irány.

**A szekvenciát SOHA nem dobjuk el, és nem állítjuk vissza** (nincs `DROP SEQUENCE`, `setval`, `RESTART`). Ha eldobnánk,
az újraalkalmazás 1-ről indulna, és a régi revíziókkal ütközhetne, vagyis egy régi megerősítés újra érvényessé válhatna.
A migráció a meglévő szekvenciát ellenőrzi és újrahasználja.

```sql
-- NEM migráció, nem a supabase/migrations alatt él. Külön jóváhagyással, tranzakcióban futtatandó.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS profiles_zz_revision_assert ON public.profiles;
DROP TRIGGER IF EXISTS profiles_zz_revision_assign ON public.profiles;
DROP FUNCTION IF EXISTS public.profiles_field_revision_assert();
DROP FUNCTION IF EXISTS public.profiles_field_revision_assign();
ALTER TABLE public.profiles DROP COLUMN IF EXISTS specific_focus_revision, DROP COLUMN IF EXISTS main_category_revision;
-- A public.profiles_field_revision_seq-et szándékosan NEM dobjuk el.
COMMIT;
```

Az oszlopok eldobása a hozzájuk tartozó CHECK és UNIQUE objektumokat is eldobja.

**A 090 DB-teszt a visszagörgetés után.** A teszt a 094-es állapotot kódolja: a `PIN_094_APP`, a `79`-es hossz és a
`public_functions=110` a 094 jelenlétét **várja**, ezért a visszagörgetett stacken ezek az élő-állapot ellenőrzések
**elvárt módon elbuknak** (a rollback-es MIGRATION_BODY forgatókönyvek az `IF EXISTS` undo miatt futnak tovább). Egy 094-
visszavonáshoz tehát a pineket és a számlálókat (108, 77) vissza kell állítani ugyanabban a változtatásban.

## A garancia határa

**Nincs garancia**, ha a triggerek ki vannak kapcsolva (`ALTER TABLE … DISABLE TRIGGER`,
`session_replication_role = replica`, `pg_restore --disable-triggers`), vagy privilegizált közvetlen beavatkozás történik
(tulajdonos/superuser, `setval`, tömeges másolás). Az AFTER ellenőrző trigger ugyanígy kikapcsolható. A trigger nélküli
INSERT NOT NULL hibával áll meg (nincs DEFAULT), de a trigger nélküli UPDATE csendben megőrizheti a régi revíziót.
Védelem: jogosultságok, és egy időszakos ellenőrzés, hogy a két trigger létezik és `tgenabled = 'O'`.

**Az „soha nem használható újra” pontos hatóköre.** Garantált: a szekvencia monoton, `NO CYCLE`, `CACHE 1`; a trigger az
egyetlen kiosztó; a rollback csak lyukat hagy; a kliens nem állíthatja. **Nem garantált:**

- kikapcsolt trigger, `setval`, `ALTER SEQUENCE`, régebbi állapotú szekvencia-visszaállítás;
- **logikai visszaállítás triggerekkel** (`pg_restore` alapértelmezetten, `COPY`): az INSERT mindig felülírja a megadott
  revíziót, tehát minden sor a **cél** szekvenciából kap új számot (ez biztonságos irány: a régi megerősítések
  érvénytelenek), de a revíziók nem őrződnek meg;
- adatbázis-visszaállítás (backup, PITR): csak akkor konzisztens a döntésadattal, ha a `profiles`, a szekvencia és a
  döntéstáblák ugyanabból az időpontból állnak vissza;
- **logikai replikáció:** a szekvencia-állapot nem replikálódik (PostgreSQL 17-ig), ezért a célon régi számok újra
  kiadódhatnak;
- **aszinkron failover / `synchronous_commit = off` összeomlás:** az elveszett commitok szekvenciaértékei újra
  kioszthatók, miközben egy kliens már látta őket.

## Nyitott (külön döntés vagy munka kell)

- **A SQL soha nem futott.** A szintaxis, a katalógus-utóellenőrzések (pl. `tgattr::int2[]`, `tgtype` értékek,
  `proconfig` egyezés, `aclexplode` szerepkör-összehasonlítások, `indkey[0]`, a `bit(64)` hash-idióma), az
  `ADD COLUMN … DEFAULT nextval` táblaújraírás és a trigger-sorrend valódi viselkedése **nem bizonyított**. A DB-mentes
  tesztek a SQL **szövegét** és egy TypeScript **referenciamodellt** rögzítenek, nem a futást.
- Az első futás helye: eldobható, izolált helyi PostgreSQL (lásd a próbamátrixot); külön jóváhagyás kell.
- **Merge-blokkoló:** a 090 DB-integrációs teszt ütközése a PR #8-cal és az összevont számlálók újraszámolása.
- A 090 DB-teszt javított állapota és az új pinek **élő katalógus ellen nem futottak**.
- A zárolás időtartama production méretű táblán (a sorok száma nem ismert).
- A migrációszám végleges kiosztása (092/093 még merge-elésre vár).
- Az `INSERT … ON CONFLICT DO UPDATE` e2e-használat viselkedése (nyomkövetéssel igazolt, DB-vel nem).
- Az információszivárgás (közös szekvencia) elfogadása; az opcionális `NEW.rev > OLD.rev` erősítés (ellentmond R6-nak,
  logikai restore-nál sorrendet törne): termékdöntés.
- Egy később létrejövő, `profiles_zz_revision_assign`-nál nagyobb nevű BEFORE triggert csak a migráció pillanatában
  védi a pre-ellenőrzés.
- **A CRLF-teszt javítás NEM része ennek a csomagnak:** a `tests/creator-focus-fingerprint.test.ts` egyetlen sora
  (`.replace(/\r\n/g, '\n')` a `sourceCode` segédben) a már pusholt #13 fájlját érinti; külön commitban/patchben kezelendő,
  `git add -A`/`commit -a` nélkül, útvonal szerinti `git add`-dal. A V-trigger csomag fájlja egyik sem hivatkozik rá. Egy
  hasonló, a változtatásoktól független CRLF-hatás: a `tests/090-…-migration-source-policy.test.ts` „LF-only” tesztje
  CRLF-es Windows checkouton elbukik (`core.autocrlf=true`).
- A döntéstábla, az audit, a nyugta, az RPC, az API és a UI (mind külön, a korábbi tervezési döntések szerint).
