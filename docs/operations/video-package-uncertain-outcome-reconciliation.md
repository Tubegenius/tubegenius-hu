# Video Package — `uncertain_outcome` kézi egyeztetési protokoll

Státusz: **helyi/tervezett protokoll, még nem éles használatra jóváhagyva.** A lekérdezések kizárólag olvasnak; semmilyen írás/refund/újrapróbálás nem része a protokollnak, amíg az 5. lépés szerinti emberi döntés meg nem születik.

Kapcsolódó: `lib/paid-results/atomic-charge-save.ts` (a naplózás forrása), `supabase/migrations/093_video_package_atomic_charge_save.sql` (RPC + `paid_operations`).

## Mikor alkalmazandó

Amikor a `chargeFeatureAndSavePaidResult()` `errorCode: 'uncertain_outcome'`-t adott vissza (a log sora `BIZONYTALAN KIMENET`-tel kezdődik). Ez azt jelenti: a hívás **nem** egy megerősített, Postgres által adott visszagörgetési hibával (`P0001`, `P0003`, `P0004`, `23505`) végződött, hanem hálózati/időtúllépés-jellegű, PostgREST-szintű (`PGRST*`), ismeretlen vagy kivételként dobott hibával. **Nem tudjuk**, hogy a tranzakció commitolt-e, még fut-e, vagy sosem érte el az adatbázist.

## Alapelvek (miért ilyen óvatos)

1. **Az elveszett válasz nem állítja meg az eredeti tranzakciót.** Ha a kliens oldalon lejárt a hívás, a szerveroldali tranzakció még futhatott, és később commitolhat. Egy mostani „nincs `paid_results` sor" **NEM bizonyíték** arra, hogy nem történt levonás — csak arra, hogy *ebben a pillanatban* nem látszik.
2. **Egy meglévő sor sem bizonyítja, hogy ez a kísérlet vont le.** A sor lehet egy korábbi, sikeres futás eredménye: ilyenkor az RPC `duplicate: true`-val, levonás nélkül tért vissza. Csak az a sor „a mi kísérletünké", amelyhez a `paid_operations` / ledger-kapcsolat és az időzítés is illeszkedik (lásd 4. lépés).
3. **Csak az elsődleges (primary) adatbázison olvasunk.** Read replika, cache, PostgREST-gyorsítótár vagy Studio-nézet késhet; az „ott még nincs" nem bizonyíték.
4. **Sorok hiányából a „nem történt meg" soha nem bizonyítható.** Se időablak, se `pg_stat_activity`, se többszöri olvasás nem zárja ki, hogy az eredeti művelet még úton van (lásd 1. lépés). A legerősebb megfogalmazás: *„nem találtunk commitot, a kimenet továbbra is bizonytalan."*
5. **Ha az adatbázis nem érhető el, az állapot „bizonytalan" marad.** Ilyenkor nincs újrapróbálás, nincs refund, nincs új generálás — csak várunk, és később újra olvasunk.
6. A `console.error` sor **nem tartós incidensnapló** (platformnapló, korlátozott megőrzéssel); csak a kiindulási pontot adja (`userId`, `inputHash`, `attemptStartedAt`, `elapsedMs`). A forrás az adatbázis.

## 0. Befagyasztás (azonnal)

- Ugyanarra a felhasználó + bemenet párra **ne** indíts új kísérletet, és ne biztasd erre a felhasználót.
- Ne adj refundot, és ne mondd a felhasználónak, hogy „nem vontunk le" vagy hogy „biztonságos újrapróbálni".
- Jegyezd fel a logból: `userId`, `inputHash`, `toolType` (`video_package`), `feature`, `attemptStartedAt`, `elapsedMs`.

## 1. „Lezárt-e az eredeti művelet?" — ez adatbázisból NEM bizonyítható

Korábbi tervezet egy `pg_stat_activity` lekérdezést használt lezártsági kapuként. **Nem alkalmas erre**, ezért kapuként nem szerepel:

- **Nem azonosítja az adott műveletet.** A kérés PostgREST-en keresztül, paraméterezett hívásként érkezik; a `pg_stat_activity.query` a függvény nevét mutathatja, de a felhasználót és az `input_hash`-t nem (kötött paraméterek) — egy találat vagy bármely felhasználó, vagy egy másik kísérlet lehet, és nem köthető ehhez a kísérlethez.
- **Nem lát mindent.** A tranzakciós pooleren, a PostgREST-en vagy a hálózaton még várakozó, az adatbázist *még el nem ért* kérés ott sehol sem szerepel; a már lezárult backend szintén nem. A „nincs sor" tehát nem zárja ki, hogy a kérés *később* ér oda és commitol.
- A teljes `query` szöveg láthatósága és csonkolása szerepfüggő (`track_activity_query_size`, jogosultság).

Egyetlen, **csak pozitív irányban használható** jelzés létezik: az RPC a tranzakció elején `pg_advisory_xact_lock(hashtext(operation_id::text))`-ot vesz, ahol `operation_id = uuid_generate_v5('7d9e9b1a-f3c4-4b8e-9a2d-6c1f0e5d8a3b', user_id::text || ':video_package:' || input_hash)`. Ha egy ilyen advisory lock **látszik** a `pg_locks`-ban, akkor az eredeti művelet nagy valószínűséggel még fut → várj.

```sql
-- csak pozitív jelzés: találat = valószínűleg még fut; NINCS találat = semmit nem bizonyít
WITH k AS (
  SELECT hashtext(extensions.uuid_generate_v5('7d9e9b1a-f3c4-4b8e-9a2d-6c1f0e5d8a3b'::uuid,
         :user_id::text || ':video_package:' || :input_hash)::text)::bigint AS key
)
SELECT l.pid, l.granted, l.locktype
FROM pg_locks l, k
WHERE l.locktype = 'advisory' AND l.objsubid = 1
  AND ((l.classid::bigint << 32) | l.objid::bigint) = k.key;
-- (a függvény sémája telepítésenként eltérhet: extensions.uuid_generate_v5 vagy uuid_generate_v5;
--  ez a lekérdezés lokálisan SEM futott -- első éles használat előtt egy tesztfelhasználóval ellenőrizendő)
```

Korlátok: a lock csak a 0. lépés (feature/cost ellenőrzés) *után* jön létre, tehát a korai szakaszban nem látszik; a kulcs 32 bites hash, ütközhet; a nem látszó lock semmit sem jelent. **Ezért a művelet lezártsága bizonyíthatatlan marad**; csak az eltelt időt lehet óvatos *becslésként* figyelembe venni (a `attemptStartedAt + elapsedMs` óta legalább néhány perc), és ez sosem garancia.

## 2. Két olvasás — csak a stabilitás jelzésére

Végezd el a 3–4. lépés lekérdezéseit **kétszer**, legalább 60 másodperces különbséggel, ugyanazon az elsődleges DB-n. Eltérés (pl. közben megjelent egy sor) azt jelenti, hogy az eredeti művelet még lezáratlan volt → várj, ismételd. Az azonos eredmény **nem bizonyíték** a lezártságra, csak annyit mond, hogy a két időpont között nem változott semmi.

## 3. Kapcsolódó sorok keresése

```sql
-- paid_operations: csak commitolt, ÚJ levonással járt műveletről keletkezik
SELECT po.operation_id, po.credit_transaction_id, po.paid_result_id, po.created_at
FROM public.paid_operations po
WHERE po.user_id = :user_id AND po.tool_type = 'video_package' AND po.input_hash = :input_hash;

-- paid_results (bármely státusz)
SELECT id, status, created_at, credit_cost
FROM public.paid_results
WHERE user_id = :user_id AND tool_type = 'video_package' AND input_hash = :input_hash;

-- ledger: az RPC külső hivatkozása 'op:' || operation_id
SELECT id, external_ref, reason, delta, balance_after, created_at
FROM public.credit_ledger
WHERE user_id = :user_id
  AND external_ref LIKE 'op:%'
  AND created_at >= :attempt_started_at::timestamptz - interval '1 minute'
ORDER BY created_at;

-- charge-audit
SELECT id, created_at, credits_charged, metadata
FROM public.ai_usage_logs
WHERE user_id = :user_id
  AND metadata->>'type' = 'charge'
  AND metadata ? 'operation_id'
  AND created_at >= :attempt_started_at::timestamptz - interval '1 minute';
```

Az RPC a ledger-, az audit- és a `paid_results`-sort **egyetlen tranzakcióban** írja, ezért a `created_at` (`now()` = tranzakció kezdete) értékük azonos; ez az összekapcsolás egyik bizonyítéka.

## 4. Korábbi állapot (baseline) megállapítása

Egy meglévő `paid_results` sor önmagában kétféle lehet:

- **a mi kísérletünk eredménye:** van hozzá `paid_operations` sor, amelynek `paid_result_id`-ja erre a sorra mutat, a `credit_transaction_id` egy `op:…` ledger sorra mutat, az audit sor `operation_id`-ja egyezik, és a `created_at` értékek azonosak, **valamint** a `created_at` a `attemptStartedAt` utáni sávba esik;
- **korábbi eredmény:** a `paid_results.created_at` a `attemptStartedAt` előtti, és nincs hozzá ehhez a kísérlethez tartozó `op:` ledger sor vagy `paid_operations` sor (régi, nem 093-as út által írt sor is lehet) → az RPC `duplicate: true`-t adott, **nem vont le újra**.

Baseline: a kísérlet előtti utolsó ledger sor `balance_after` értéke és a mostani `user_credits` egyenleg különbségét vesd össze a `delta` értékkel — csak egyezés esetén tekinthető a levonás bizonyítottnak.

## 5. Döntési tábla

A sorok **jelenléte** (összekapcsolt, azonos `created_at`-ú, baseline-nal egyező sorok) bizonyíthat egy megtörtént commitot. A sorok **hiánya** soha nem bizonyít semmit.

| Talált állapot | Következtetés | Teendő |
|---|---|---|
| `paid_operations` + `op:` ledger + `paid_results` + audit, azonos `created_at`, baseline egyezik | a levonás **és** a mentés megtörtént (bizonyított commit) | nincs teendő; a felhasználó a mentett eredményt látja (az útvonal cache-ből szolgálja ki) |
| korábbi `paid_results`, ehhez a kísérlethez nincs `op:` ledger/`paid_operations` | nem vont le újra ez a kísérlet | nincs levonás-probléma; az eredmény korábbról létezik |
| nincs `paid_results`, nincs `op:` ledger, nincs audit, nincs `paid_operations` (két olvasásban sem) | **nem találtunk commitot, a kimenet továbbra is bizonytalan** (az eredeti művelet még futhat vagy később érkezhet) | várj, ismételd; új kísérlet csak az 5a. pont szerinti, külön emberi döntéssel |
| ledger `op:` sor van, de `paid_results` / `paid_operations` nincs | **anomália** (az RPC atomicitása szerint nem fordulhat elő) | ne nyúlj hozzá; eszkaláció, emberi vizsgálat |
| részleges / ellentmondó sorok | **anomália** | eszkaláció; nincs automatikus lépés |
| DB nem elérhető / olvasás sikertelen | **bizonytalan** | nincs retry/refund; később ismételd |

### 5a. Új kísérlet a „nem találtunk commitot" állapotban

Csak **külön, kifejezett emberi döntéssel**, amely *előtte* tudatosan mérlegeli:

- **RPC-idempotencia azonos hash-re:** ugyanarra a `(user, tool_type, input_hash)`-re a RPC advisory lockkal szerializál, és ha a `paid_results` sor már completed, **nem von le újra** (`duplicate: true`). Ez védi a dupla levonástól akkor is, ha az eredeti tranzakció közben mégis commitol. Fenntartások: ez a tulajdonság a 093-as DB-tesztekkel **még nem futott** (a preflight bizonyíthatja); csak **azonos hash**-re igaz — ha a bemenet akár egy karakterben eltér, új `operation_id` jön létre, és a dupla levonás lehetséges.
- **A lehetséges még futó tranzakció kockázata:** az eredeti kísérlet bármikor commitolhat; az új kísérlet ilyenkor `duplicate`-ot kap (nincs dupla levonás), de **ismét lefut a provider-hívás** (költség), és a felhasználó a korábban generált eredményt kapja vissza, nem az újat.
- A döntést és az indoklást rögzítsd (ki, mikor, mely lekérdezés-kimenetek alapján).

## 6. Refund

Refund **kizárólag bizonyított anomália** esetén, **emberi döntéssel**, az idempotens `refund_credit_spend(user, spend_ledger_id, külső_hivatkozás, metadata)` RPC-vel, a konkrét ledger-sorra hivatkozva. Tévesen kiadott refund (pl. amikor a levonás mellett a mentés is megvan) kreditet termel — ezért bizonyítás nélkül tilos.

## 7. Elérhetetlen adatbázis

Ha az elsődleges DB nem olvasható (megszakadó kapcsolat, incidens): az eset **„bizonytalan"** marad. Nincs újrapróbálás, nincs refund, nincs új generálás. Később ismételd a protokollt.

## Ismert korlát

Az eredeti tranzakció lezártsága adatbázisból nem bizonyítható; az eltelt idő csak becslés, nem garancia. A protokoll azt biztosítja, hogy *bizonyított commit* csak összekapcsolt, stabil, elsődleges-DB-sorokból következzen, és hogy a hiány soha ne legyen „biztonságos" ítélet.
