# Editing Pattern Engine — 1A–1B (kontraktus és aszinkron, idempotens elemzés)

Státusz: **megvalósítva a modul és a DB-mentes tesztek; nincs bekötve route-ba, nincs migráció, nincs deploy.**
A program sorrendje kötött: Editing Pattern → Creator Intelligence → Unified Pipeline → End-to-End Audit Trail →
ellenőrzött Staging→Production Promotion. Ez a dokumentum csak az 1. fázis 1A–1B csomagját írja le.

## 1. Mi volt a kiindulás (a meglévő útvonalak vizsgálata)

| Terület | Tény (forrásból) |
|---|---|
| `app/api/video-audit/route.ts` | A bemenet YouTube API metaadat (cím, leírás, hossz, statisztika, címkék, a thumbnail URL megléte) vagy felhasználó által megadott mutatók. A nyelvi modell csak a címet, a témát és a backend score-okat kapja. |
| `lib/video-audit-scoring.ts` | A „retention_potential” **szerkezeti becslés** a hosszból és a megadott mutatókból (a kód maga is jelzi: „Nincs nézőmegtartási adat”). |
| Képkocka-/vágáselemzés | **Nincs.** Nincs dekódoló, nincs médiakönyvtár a függőségek között, nincs háttérfeladat-minta (`waitUntil`/queue), és nincs általános job-tábla. |
| Videóforrás | A YouTube-videót nem töltjük le; a terv sem teszi. |

Következmény: az elemzés **képkocka-aláírás sorozatra** épül (képkockánkénti luminancia-hisztogram), és a forrás egy
port mögött van. A valódi dekódolás külön infrastruktúra-döntés (lásd a 7. pontot).

## 2. Mit változtattunk a meglévő auditon

Additív, a viselkedés pontozása nem változik:

- a válasz új mezőt kap: `evidence_basis` (`kind: 'metadata_only'`, `frame_analysis_performed: false`,
  `editing_analysis_available: false`, `basis_fields`, magyar megjegyzés);
- az értelmező prompt kap egy bizonyíték-korlát szakaszt („a képkockákat, vágásokat nem láttad…”), a sablon
  verziója `v1` → `v2` (`lib/prompts/catalog.ts` és az útvonal együtt);
- a régi, már mentett eredményekben nincs `evidence_basis`: a frontend a hiányzó mezőt **metaadat-alapúként** kezeli.

## 3. Adatkontraktus (`editing-analysis.v1`, algoritmus: `hist-delta-hard-cut.v2`)

Forrás: `lib/editing-pattern/contract.ts`, validáció: `validate.ts` (szigorú, ismeretlen mezőt elutasít).

**Bemenet:** `contract_version`, `video { source_kind: fixture|user_upload, source_id (opak azonosító, nem URL), duration_ms }`,
`sampling { sample_interval_ms 100–5000, signature_bins 8–64 }`, opcionális `params { cut_sensitivity, min_shot_length_ms }`,
opcionális `limits` (csak szigoríthatja a kemény plafonokat; efölött elutasítja).

**Kemény plafonok:** 30 perc, 6 000 képkocka, 64 bin, 384 000 számítási egység (képkocka × bin), 20 s határidő, 2 000 listázott shot.

**Kimenet:**

| Mező | Tartalom |
|---|---|
| `status` | `complete` · `partial` · `insufficient_data` · `limit_exceeded` · `failed` |
| `reason_code` | gépi kód (pl. `too_few_frames`, `frame_budget`, `deadline_exceeded`, `invalid_frame_data`, `source_error`) |
| `evidence_basis` | `frame_signature_series`, `frame_analysis_performed`, `frames_examined` |
| `coverage` | **idő-alapú** lefedettség: `covered_ms` = a [t, t+köz) intervallumok **pontos uniója** [0, duration)-re vágva, `uncovered_ms` = a maradék (MINDEN fedetlen idő), `coverage_ratio` = `covered_ms`/duration **három tizedesre LEFELÉ csonkolva** (sosem kerekítve felfelé, ezért 94,996 % = 0,949 és nem 0,950; a státusz pontosan akkor `complete`, ha a kiadott arány ≥ 0,95, és `insufficient_data`, ha < 0,5); a `gaps` csak a fél mintavételi köznél hosszabb fedetlen szakaszokat **listázza** (megjelenítési és shot-értékelési szabály, a mért időt nem érinti) |
| `cuts[]`, `shots[]` | vágások (`t_ms` = az új shot első képkockája, `uncertainty_ms`, `strength`, `confidence`) és shotok (`spans_gap`) |
| `metrics` | shot-szám, vágássűrűség/perc, átlag/medián/min/max shot-hossz, nyitó ablak, pacing ablakok + trend |
| `timestamp_resolution_ms` | a vágásidő pontossága: ± a mintavételi köz |
| `limitations[]` | mindig: `hard_cuts_only`, `gradual_transitions_not_detected`, … |
| `not_available` | `retention_curve` és `style_cluster`: **`not_available`** (nincs érték) |
| `cost` | `units_estimated`, `units_consumed` |

**Állapotok:** csak `complete` (a lefedett idő ≥ 95 %) és `partial` ad metrikát; `partial` esetén a `metrics.scope` kimondja, mit fed le. A `metrics.scope.covers_full_duration` ennél szigorúbb: csak `complete` **és** `uncovered_ms` = 0 (egyetlen fedetlen ezredmásodperc sincs) **és** az utolsó shot eléri a deklarált hosszt esetén igaz. Időbélyeg-jitterű forrás ezért jellemzően `complete`, de `coverage_ratio` < 1 és `covers_full_duration: false`; csak a pontos többszörös időbélyegek adnak `true`-t. A vágássűrűség nevezője, az ablak- és harmad-lefedettség ugyanezt az uniót használja; a tolerancia alatti, de összeadódó hiányokat a `data_gaps_present` helyett az `uncovered_time_below_gap_tolerance` figyelmeztetés jelzi. Az
`insufficient_data`, `limit_exceeded`, `failed` állapotban **nincs metrika**: egy előtag nem adható ki a teljes videó értékeként.

## 4. Algoritmus és korlátai

Két egymást követő hisztogram távolsága = fél L1-távolság (0..1). Vágás = a küszöb feletti ugrás; a küszöb
`max(abszolút padló, medián + k·1,4826·MAD)`. Egy mintányi villanás (be+ki ugrás) kiesik; közeli ugrásoknál az erősebb marad.
A lyukon átnyúló vágás nem értékelhető, és nem is találjuk ki. **Nem látja:** fokozatos átmenetet, tartalmat, mozgást, hangot.

**v2 (idő-alapú lefedettség és invariánsok):** egy képkocka-aláírás a `[t, t + köz)` időt képviseli; a lefedettség az idő, nem a képkockák száma, ezért az idő egy részébe sűrített képkockák nem látszhatnak teljesnek. Képkocka-szerződés: `0 ≤ t_ms < duration_ms` (a határon vagy túl lévő képkocka hibás bemenet, a vágás a forrás-adapter feladata), szigorúan növekvő időbélyeg (az egyenlő is `timestamp_not_increasing`). A túl sűrű, de növekvő időbélyeg nem hiba: egyszer számolódik a lefedettségben, `sampling_denser_than_declared` figyelmeztetéssel, és a futásidejű számítási keret védi. Minden metrikás eredmény kielégíti az invariánsokat (`invariants.ts`: shotok pozitív hosszúak és összefüggőek, vágások a videón belül, ablakok vágásainak összege = `cut_count`, `shot_count = cut_count + 1`); sérülés esetén az eredmény `failed` / `invariant_violation`.

## 5. Aszinkron, idempotens futtatás

`submit` → idempotencia-kulcs (owner + verziók + a **normalizált** bemenet SHA-256-ja) → `insert-if-absent`.
`run` → `claim` (queued vagy lejárt bérletű running, `attempt+1`) → elemzés → `complete`, **`attempt`-tel kerítve**
(a lejárt bérletű worker nem írhatja felül az átvevő eredményét). Csak a `source_error` próbálható újra (max. 3 kísérlet);
minden más kimenet a bemenet determinisztikus függvénye, és `completed`-ként zárul. Az egyetlen adapter az **in-memory
referencia-tár** (`job-store-memory.ts`): a folyamattal együtt elvész. Tartós tár nincs.

**Határidő — mit garantálunk és mit nem.** Minden `iterator.next()` egy időzítővel versenyez, az időzítő mindig takarítva van, és a lezárás utáni (késői) válasz vagy elutasítás semmit nem ír és nem is okoz kezeletlen elutasítást; a terminális tár-írás pontosan egyszer történik.
- **Garantált (ebben a fázisban):** az **eseményhurkot elengedő** (aszinkron I/O) forrás mellett az *elemzés* lezárhat `limit_exceeded` / `deadline_exceeded` eredménnyel akkor is, ha a `next()` soha nem válaszol.
- **Nem garantált:** hogy a *job* a bérlet lejárta előtt tartósan lezárul (a tár-művelet késhet; a `leaseMs` felülírható — a futtató a bérletet a határidő kétszerese alá nem engedi, de ez konfigurációs védelem, nem garancia; a késői írást az `attempt`-kerítés utasítja el); hogy a forrás vagy a dekódoló leáll (az `AbortSignal` kooperatív, az `iterator.return()` csak megkísérelt, egy függő `next()` mögött sorban áll); hogy egy szinkron, CPU-kötött forrás mellett bármilyen időzítő tüzel. Valódi erőforrás-leállítás izolált workert igényel (D1).

## 6. Tesztek (DB-mentes, hálózat- és dekódoló-mentes)

- `tests/editing-pattern-analyzer.test.ts`: kontraktus-validáció, vágáspontosság időbélyeg-toleranciával (köz-skálázás, jitter),
  zaj/drift, villanás, fokozatos átmenet (dokumentált korlát), shot-hossz és vágássűrűség a ground truth-ból, pacing-trend,
  erőforrás- és költséghatárok, explicit hiba/hiányos adat állapotok, determinizmus.
- `tests/editing-pattern-coverage-and-invariants.test.ts`: idő-alapú lefedettség (sűrített és túl sűrű időbélyegek, lyukak, a `covers_full_duration` szigora), a videón kívüli képkocka, tulajdonság-teszt véletlen lyukakra és jitterre, az invariáns-ellenőrző "fogai".
- `tests/editing-pattern-deadline.test.ts` és `…-invariant-guard.test.ts`: megakadó `next()`, késői válasz/elutasítás, időzítő-takarítás, egyszeri terminális írás, bérlet-padló, az invariáns-őr.
- `tests/editing-pattern-job-runner.test.ts`: idempotens submit, versenyhelyzet, bérlet és kerítés, kísérlet-kimerülés.
- `tests/editing-pattern-evidence-boundary.test.ts`: a metaadat-alapú audit nem állít képkocka-elemzést; a modul tiszta és
  egyetlen helyre van bekötve (csak az `evidence_basis` modul az auditútvonalban).
- Helyi mutációs ellenőrzés (repón kívüli szkript, nem része a PR-nek): 30 mutáció az elemzőn és a job-futtatón (küszöb, villanás-kiszűrés, idő-alapú lefedettség, `covers_full_duration`, időbélyeg-szerződés, határidő-verseny, időzítő-takarítás, késői elutasítás, invariáns-őr, futásidejű számítási keret, bérlet-padló stb.) — mind elbukott legalább egy tesztet.
- Fixture-ök: `tests/support/editing-pattern-fixtures.ts` (fiktív, seedelt; nincs URL, videó-azonosító vagy alkotó).

## 7. Döntési pontok (itt megállunk, külön döntés kell)

| # | Döntés | Miért blokkol |
|---|---|---|
| D1 | **Ki és hol bontja a videót képkockákra?** Dekódoló worker (pl. ffmpeg), nem szerverless függvény; forrás: csak felhasználói feltöltés vagy engedélyezett export, **nem YouTube-letöltés**; a nyers videó tárolása és törlése. | Jogi/üzemeltetési; nincs ilyen infrastruktúra. |
| D2 | **Tartós job-/eredménytár** (migráció) és **adatmegőrzés**: mennyi ideig élnek az aláírások és eredmények, a hozzájárulás, a törlés (fiók-kaszkád vs megőrzés). | Migráció és adatmegőrzési döntés. |
| D3 | **Költségmodell**: a számítási egység → kredit/ár, felhasználói kvóta. Jelenleg nincs kredit-levonás. | Termék- és pénzügyi döntés. |
| D4 | **Hitelesítés és hozzáférés** az API-ra (tulajdonos-ellenőrzés, RLS, a job-azonosító nem találgatható). | Biztonsági terv. |
| D5 | **Küszöbök kalibrálása valós, címkézett vágásadaton.** A jelenlegi padló-értékek fiktív fixture-ökön vannak igazolva. | Nyitott kockázat, lásd lent. |

## 8. Nyitott kockázatok

1. A küszöbök és a pontosság **valós videón nem mért**; a tesztek fiktív aláírásokon futnak.
2. A luminancia-hisztogram vágásérzékelése gyenge szűk tónusú, sötét vagy erősen mozgó anyagnál; hasonló jelenetek közti vágás kimaradhat.
3. A fokozatos átmenetek (fade, dissolve) nem észlelhetők; a vágássűrűség ilyen videónál alulbecsült.
4. A mintavételi köz (alap 250 ms) alatti shot-ok nem láthatók.
5. A `limits` hard cap-ek ideiglenesek, valós dekódolási költség ismerete nélkül.
6. A pacing-trend leíró statisztika, nem minőség- vagy retention-állítás; a UI nem használhatja annak.
7. Az in-memory tár nem tartós: újraindítás után a feladatok elvesznek (idempotencia csak a folyamat élettartamán belül).
8. A lefedettség pontos (nincs tolerancia), ezért egy valós dekóder időbélyeg-jittere a `covers_full_duration`-t gyakorlatilag kizárja és a lefedettséget néhány %-kal csökkenti (±40 ms jitter 250 ms-es köznél ≈ 94,7 % → `partial`; ±10 ms ≈ 98,7 % → `complete`). A `complete` küszöb (95 %) és a jitter-viselkedés valós dekóderen nem mért: a D1 döntés része (pl. a köz a tényleges képkocka-időbélyegekhez igazítva).
9. A határidő csak az elemzés lezárását garantálja eseményhurkot elengedő forrásnál; a forrás/dekódoló leállítása és az erőforrás-felszabadítás nem (izolált worker, D1). A job bérletlejárat előtti tartós lezárása sem garantálható (lassú tár, felülírható `leaseMs`).
10. Az AI-értelmezés szöveges bizonyíték-korlátja (prompt) nem garantált védelem: az elutasítás/szűrés (#4) külön döntésre vár (rate-/költségkorlát és a megfigyelés–javaslat szabály).

## 9. A frontendnek szükséges API-szerződés (JAVASOLT, még NEM megvalósított)

A típusok a `lib/editing-pattern/contract.ts`-ben vannak; a route-ok a D1/D2/D4 döntés után épülnek.

```
POST /api/editing-analysis                    (auth kötelező; tulajdonos = a bejelentkezett felhasználó)
  body: EditingAnalysisInput
  202 { job_id, state: 'queued'|'running'|'completed'|'failed', idempotent_replay: boolean }
  400 { error: 'invalid_input', issues: [{ path, code }] }
  401 / 429 / 413 …

GET /api/editing-analysis/{job_id}            (csak a tulajdonos; idegen azonosító → 404)
  200 { job_id, state, result: EditingAnalysisResult | null, error_code: string | null }
```

A UI-szabályok:

| `result.status` | Mit jelenítsen meg |
|---|---|
| `complete` | metrikák + a `limitations` + a `timestamp_resolution_ms` |
| `partial` | metrikák **a `metrics.scope` és a lefedettség megjelölésével**; a lyukak listája |
| `insufficient_data` | „Nincs elég adat” + az `reason_code` magyarázata; metrika nincs |
| `limit_exceeded` | „Túl nagy a videó/feladat” + melyik határ; metrika nincs |
| `failed` | hibaállapot a kód alapján; nyers hibaszöveg nincs |

Tiltott a UI-ban: a `not_available` mezőkből értéket, görbét vagy stílus-címkét kirajzolni; a pacing-trendet
„jó/rossz” minősítéssel megjeleníteni; a metaadat-alapú auditot (`evidence_basis.kind = metadata_only`, vagy hiányzó mező)
képkocka- vagy vágásalapúként jelölni.
