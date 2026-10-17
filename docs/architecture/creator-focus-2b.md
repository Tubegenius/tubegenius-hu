# Creator Focus 2B — döntésrekord (helyi, DB-mentes mag)

Státusz: **helyi, nem commitolt, nem tartós, nem felhasználó által használható.** A PR #12 (2A) alapjára épülő
tiszta modul-csomag és DB-mentes tesztjei. **Nincs** migráció, döntéstábla, trigger, API-route, UI, profilíró-módosítás,
AI-hívás vagy kreditművelet. Az események a hívó argumentumai; a modul semmit nem tárol, és egy megerősítés a
folyamat végével elvész, amíg nincs tartós tár (külön döntés, lásd „Nyitott”). **Ez nem kész Creator Intelligence
Engine**, csak a döntési szabályok DB-mentes magja.

Hatókör: csak a `specific_focus` és a `main_category`. Az `audience` és az `avoid_topics` későbbre marad.

## Fájlok (`lib/creator-focus/`)

| Fájl | Szerep |
|---|---|
| `decision-contract.ts` | `creator-focus-decision.v1` típusok, korlátok, hibakódok, `DECISION_LIMITATIONS` |
| `sha256.ts` | tiszta SHA-256 (nincs Node-függőség); `node:crypto`-hoz hasonlítva tesztelve |
| `fingerprint.ts` | **verziózott, szigorú** ujjlenyomat (v1): érték és javaslat; **nem** a 2A `identityKey`-t használja |
| `decision-events.ts` | az események és a pillanatkép szigorú validálása (egy hibás elem = az egész elutasítva) |
| `decision-reduce.ts` | az olvasási modell: `applyDecisions(profil, pillanatkép, események)` |
| `decision-command.ts` | egy parancs kiértékelése: új / újrajátszás / ütközés, és az esemény-tervezet |
| `contract.ts`, `index.ts` | csak additív: egy új `ClaimReasonCode` (`confirmed_by_decision_record`), a `FocusProfile` opcionális `decision_projection` mezője, új exportok |
| `profile-validate.ts` | **2A-fájl, csak additív módosítás:** a `decision_projection` kulcsot engedi (`PROFILE_KEYS`) és szigorúan validálja (csak `{ contract_version: 'creator-focus-decision.v1' }`) |

A 2A viselkedése **jelölő nélküli bemenetre változatlan**: üres eseménylista = azonos profil (tesztelve), és egy 2A
profil (nincs `decision_projection` kulcs) pontosan úgy érvényes vagy érvénytelen, mint korábban. Az egyetlen
tartalmi eltérés: egy érvényes `decision_projection` jelölős profilt a 2A-validátor korábban `unknown_field`-del
elutasított, most elfogad (ez a 2B kimenet jelölője; az `applyDecisions` és a parancsértékelő mégis bemenetként
elutasítja, lásd lent). A 2A témailleszkedési szabálya (`identityKey`, `termsOf`, `assessFocusFit`) és az adapter
javaslat-illesztése **érintetlen**.

## Az egyetlen forrásigazság-szabály

- Az **érték** forrása a `profiles` sor. A döntés sosem tárol „aktuális értéket".
- A **döntés** egy `(felhasználó, mező, csatorna, értékujjlenyomat, mezőrevízió)` kötés.
- Egy megerősítés csak addig érvényes, amíg a **mezőrevízió egyenlő** az eseményben rögzítettel, a csatorna az aktív,
  és az ujjlenyomat is egyezik. Egy mentés, amely a mezőt megváltoztatja, új, soha nem ismétlődő revíziót ad: az
  **érték** `A → B → A` útja után a régi megerősítés **nem** él újra, új explicit döntés kell.
- A revízió **decimális szöveg**, csak egyenlőségre hasonlítjuk; sorrendet nem feltételezünk, számmá nem alakítjuk.
- Ha a revízió egyenlő, de az ujjlenyomat eltér (a revízió-védelem megkerülése), az `integrity_mismatch`, és a
  megerősítés **nem** érvényesül.
- Régi sorból vagy a `niche_validated_for_channel_id` jelölőből **soha** nem lesz `user_confirmed`.

### Termékszabály: a csatorna `A → B → A` körútja

A csatorna a kötés része, de egy csatornaváltás **nem** növeli a mezőrevíziót. Ha az aktív csatorna `A → B → A`
útját járja be úgy, hogy **az érték és a mezőrevízió közben nem változott**, az `A`-n tett megerősítés **újra
érvényes** (a `B`-n nem volt érvényes). Ez szándékos: a készítő erről az értékről döntött erre a csatornára, és
egyik sem változott. Új explicit döntés csak értékváltozás, visszavonás vagy másik csatorna után kell. (Ez más, mint
az érték `A → B → A` útja, ahol a revízió megváltozik, és a megerősítés nem él újra.)

## Eredet (provenance) — a megerősítés nem gyengítheti a készítő saját állítását

Csak olyan claim emelhető `user_confirmed`-re, amelyet a 2A adapter nem tud a készítőnek tulajdonítani: `origin:
unknown`, csatornából származó (suggestion-illeszkedő) claim. A készítő **saját** (`user_declared`,
`user_corrected`) és az **már megerősített** claimjét döntésesemény **soha** nem írja át csatornából származóvá.

- Parancs (`evaluateDecisionCommand`): ilyen claimre a `confirm` **nem** ad eseményt (`claim_not_confirmable`).
- Olvasási modell (`applyDecisions`): ha ilyen claimre mégis létezik egyező esemény (kézzel készített vagy régi), a
  státusz `claim_not_confirmable`, a claim érintetlen, `decision_id` nincs.
- A `main_category` megerősítése a **teljes** kiválasztott javaslathoz kötött: a jelenlegi fókusznak szigorúan egyeznie
  kell a javaslat fókuszával (parancsnál `value_not_adopted`); az olvasási modellben, ha a fókusz később már nem a
  javaslat fókusza, a kategória-megerősítés `invalidated_by_value_change` (ha a claim egyébként megerősíthető; ha nem,
  a státusz `claim_not_confirmable`: az eredet-ellenőrzés megelőzi).
- **Fókuszrevízió-kötés (eseményséma: `focus_revision`).** A kategória-megerősítés a megerősítéskor látott
  `specific_focus` **revíziójához** is kötött (parancs: `expected_focus_revision`, kötelező a kategóriánál, tiltott
  máshol; az esemény `focus_revision` mezője kategória-megerősítésnél kötelező, másnál `null`). Így a fókusz `A → B →
  A` útja (új fókuszrevízió, változatlan kategóriarevízió) után a kategória-megerősítés **nem** éled újra
  (`invalidated_by_value_change`); új explicit döntés kell. A séma még javítható: nincs tartós 2B adat.
- **Aszimmetria (szándékos, nem hallgatólagos):** a `specific_focus` megerősítése **nem** függ a kategóriától és a
  kategória revíziójától. Ha a készítő kategóriája eltér a javaslatétól, a fókusz mégis megerősíthető, és a későbbi
  kategóriamentés nem szünteti meg. A kategória a fókuszhoz kötött, a fókusz nem a kategóriához. Tesztelt
  (`creator-focus-decision-guards.test.ts`).
- Függő csatorna-felülvizsgálat (`niche_needs_review`) vagy csatorna-eltérés alatt a `confirm` parancs eleve
  `channel_context_uncertain`; ha ilyen helyzetben kézi esemény emel egy javaslat-illeszkedő claimet, az
  `user_confirmed`, de **nem tény** (`fact_eligible: false`).

Regressziós példa (a külön review-ból): fókusz `saját egyedi témám`, kategória `health`, javaslat
`(otthoni edzés kezdőknek, health)` az `A` csatornán → az adapter `user_declared`, `channel_derived:false`,
tény; a `confirm` ezt nem módosíthatja (parancs: `claim_not_confirmable`; olvasási modell: a claim változatlan).

## Az ujjlenyomat (v1): szigorú, Unicode-megőrző értékazonosság

A döntés azonossága **nem** a 2A veszteséges `identityKey`-t használja (kisbetű, ékezet- és írásjel-eltávolítás,
minden nem `a-z0-9` szóközzé) — az pl. a `日本料理 ramen`, `韓国料理 ramen` és `ramen` értéket, a `Łódź` és `odz`,
a `Straße` és `Stra e`, a `Đà Nẵng` és `A Nang` párt ugyanarra a kulcsra képezi. Az azonosság:

```
érték     sha256("cf-fp-v1\n" + mező + "\n" + kanonikus_érték)
javaslat  sha256("cf-fp-v1\nsuggestion\n" + főkategória + "\n" + kanonikus_fókusz)
```

A kanonikus szöveg: a claimként tartott érték (`cleanText`: szóközsorozatok egy szóközzé, trim, hosszkorlát), majd
Unicode **NFC**. **Semmi más** nem esik össze: kis/nagybetű, ékezet, írásjel, írásrendszer, zéró szélességű karakter
és emoji megmarad. Azonos: szóközben vagy NFC/NFD-ben eltérő szöveg. Egy magányos (pár nélküli) surrogate-ot
tartalmazó szövegnek nincs ujjlenyomata (az UTF-8 minden ilyet ugyanarra a helyettesítő karakterre képezne, és
különböző értékek ütköznének).

A v1 szerződés **kijavítva** (nem v2): még nem létezik tartós 2B adat, a korábbi, `identityKey`-alapú v1 sosem
került tárba. Fagyasztott aranyvektorokat és a fenti ütköző párok külön tesztjét lásd
`tests/creator-focus-fingerprint.test.ts`; a vektorok `node:crypto`-val, a kód másolata nélkül készültek.

Következmények (termékkompromisszum): egy elvetett javaslat, amelyet a generátor más kis/nagybetűvel vagy
írásjellel újra kiad, **másik javaslat**, és újra megjelenik; egy megerősítéshez a profilnak a javaslat pontos
szövegét kell tartalmaznia (a 2A adapter továbbra is lazán, `identityKey`-vel illeszti a javaslatot, ezért egy
csak kisbetűben eltérő fókusz `unknown` eredetű marad, de ahhoz a `confirm` `value_not_adopted`-et ad). Az
ujjlenyomat alapján latin betű nélküli szöveg is köthető lett.

**A hash nem anonim adat.** Rövid, kis entrópiájú fókuszszövegek szótártámadással visszafejthetők; az ujjlenyomat
sózatlan, pszeudonim adat a készítőről. Az események nem tárolnak szöveget, de ez nem teszi őket anonimmá.

### Verziókezelés

Egy ujjlenyomat csak a létrehozó verzióval együtt értelmezhető; egy verzió kanonikus formája **fagyasztott**, bármi
változás **új verzió**. Az olvasási modell az **értékazonosságot igénylő, ismeretlen verziójú eseményt tétlennek**
kezeli (`confirm`, `dismiss`, `withdraw(dismissal)`): soha nem érvényesül, nem értelmeződik újra, és **nem tiltja le**
a réteget (`unsupported_fingerprint_version`). A **`withdraw(confirmation)` kivétel**: nem hordoz ujjlenyomatot (csak
mező + csatorna + sorrend köti), ezért **verziótól függetlenül továbbra is visszavon**. Egy visszavonás tétlenné
tétele korábbi megerősítést éleszthetne fel, ezért ez szándékos és tesztelt (rögzítve:
`creator-focus-decision-guards.test.ts`). Az eseményvalidátor ettől
függetlenül az ujjlenyomat-mezőket **64 hexa**ként várja, bármilyen verziónál; tehát egy más formátumú jövőbeli
verzióhoz a validátort is módosítani kell. Strukturálisan hibás esemény (pl. verzió 0, 1001 fölött vagy törtszám)
az egész réteget letiltja.

## Visszavonás és elvetés

- `withdraw(confirmation)`: visszavonja a mező, adott csatornán, **korábbi** megerősítéseit; egy későbbi `confirm` új
  döntés. `withdraw(dismissal)`: visszaadja az elvetett javaslatot. A legutóbbi döntés nyer.
- Az elvetés **csak ebben az olvasási modellben** rejt el egy javaslatot; a javaslatgenerátorra nem ígér semmit, és a
  claim-eket nem érinti.

## Parancsok és `request_id`

Azonos `request_id` + azonos jelentés (művelet, mező, visszavonás célja, javaslat, várt mező- és fókuszrevízió) =
`replay`: a rögzített esemény **másolata** jön vissza, az aktuális állapottól és a kapacitástól függetlenül. Eltérő
jelentés = `request_id_conflict` (pl. egy elvetés és annak visszavonása sosem ugyanaz a kérés). A kis/nagybetű nem
számít (`request_id` UUID). A felhasználó és a csatorna a munkamenetből és a profilból jön, sosem a parancsból. A
`confirm` nem módosítja a profilt; egy már ott lévő értékről szóló döntést rögzít. Hibakódok: lásd
`DecisionFailureCode`.

**Az ismétlés nem rögzít semmit** (új `request_id`-vel sem): az áll már fennálló megerősítésre `already_confirmed`
(azonos mező, csatorna, revízió(k), érték, és nincs későbbi visszavonás), az már elvetett javaslatra
`already_dismissed`, a már visszavont (vagy sosem tett) megerősítés visszavonására `nothing_to_withdraw`. Egy
újrapróbáló kliens így nem tölti meg az eseménylistát. Egy fennálló, de elavult megerősítés továbbra is visszavonható.

**Kapacitás.** Ha az eseménylista már a 5000-es korlátnál tart, a parancs **nem ad új tervezetet**
(`event_capacity_reached`), mert annak hozzáfűzése letiltaná az egész réteget. Ez **csak kapacitásőr**: nem
kompakció, nem szabadít fel semmit, és **nem tartós visszavonhatóság**. A korlátnál a visszavonás sem rögzíthető.
Replay és ütközés a korlátnál is működik; az állapothiba (pl. `already_confirmed`) megelőzi a kapacitáshibát.

## Korlátok és a bemenet határa

- Egy megerősítés rögzített kérés, **nem bizonyíték arra, hogy ember látta és elfogadta**; a modul ezt nem tudja
  igazolni.
- Az események a hívó által adottak; a modul semmit nem tárol.
- **Eseményszám-plafon: 5000.** Fölötte az egész réteg letiltódik (`too_many_events`), a parancs pedig a korlátnál
  már nem ad új tervezetet (`event_capacity_reached`). Ez **korlát, nem megoldás**: nincs kompakció és nincs
  visszavonhatóság/törlés; a korlátnál lévő készítő semmilyen új döntést (visszavonást sem) nem tud rögzíteni. A plafon
  emelése vagy „az utolsó N esemény" olvasása csendben jelentést változtatna (egy kihagyott visszavonás feltámasztana
  egy megerősítést). **Nyitott blokkoló a tartós tár előtt: eseményplafon, kompakció, visszavonhatóság és
  adatmegőrzés.**
- **A kimeneti profil nem bemenet.** Egy nem üres lista alkalmazása után az `applyDecisions` kimenete a
  `decision_projection` jelölőt hordozza (a 2A `FocusProfile` opcionális, 2A-ban hiányzó mezője). Egy ilyen profilt az
  `applyDecisions` és a parancsértékelő is elutasít (`profile_already_projected`): az elvetett javaslatok már hiányoznak
  belőle, egy második futás csendben gyengébb olvasási modellt adna. Ugyanazon, jelöletlen bemenetre ugyanazokat az
  eseményeket alkalmazva az eredmény ismételhető és azonos. A jelölőt az objektum birtokosa állítja, mint minden más
  mezőt; a modul nem hitelesíti.
- **JSON-alakú bemenet a szerződés** (amit `JSON.parse` vagy egy adatbázis-meghajtó ad). Getter-es objektum, Proxy,
  prototípus-láncon örökölt tulajdonság és ritka (lyukas) tömb **nem része** a szerződésnek, és ellene nincs külön
  védelem (pl. a kulcsellenőrzés `in`-t használ, ami örökölt kulcsot is lát; a lyuk kimarad). Ez külön ismert határ,
  nem azonos a fenti két elsődleges hibával (eredet, veszteséges azonosság).
- A SHA-256 32 bites előjeles eltolásai elvileg ~2 GiB bemenetnél túlcsordulnának; elérhetetlen (a bemenet
  korlátozott).

## Amit a jövőbeli tárnak teljesítenie kell (nem része ennek a csomagnak)

- eseményenként egyedi, növekvő `seq`; `(user_id, request_id)` egyediség; az esemény **nem tárol szöveget**;
- a revíziókat `::text`-ként kell olvasni (ne JS-számként);
- a profil mezőnkénti revíziója a `profiles` soron, egy `BEFORE INSERT OR UPDATE` triggerrel (`OF`/`WHEN` nélkül),
  közös sorozatból, plusz egy `AFTER` ellenőrző trigger; a garancia határa: kikapcsolt trigger vagy privilegizált
  közvetlen beavatkozás mellett nincs garancia;
- append-only jog alapú védelem (nem trigger), hogy a fióktörlés `CASCADE` működjön;
- **az 5000-es eseményplafont a tárnak ATOMIKUSAN, a hozzáfűzéssel egy tranzakcióban kell érvényesítenie.** A tiszta
  parancsértékelő csak a hívó által átadott lista hosszát látja (`event_capacity_reached`); ez önmagában nem elég: két
  párhuzamos parancs 4999 eseménynél mindkettő kaphat tervezetet, és a hozzáfűzés után 5001 esemény az
  `applyDecisions`-t letiltaná. A plafon a tárban (zárolt számláló vagy ellenőrzés ugyanabban a tranzakcióban), nem a
  kliensoldali listában dől el. (A plafon maga, a kompakció és a visszavonhatóság továbbra is nyitott döntés.)
- **A `decision_projection` jelölő NEM hitelesítési védelem.** Aki az objektumot tartja, leveheti, és akkor egy
  projektált profilt a redukáló újra elfogadna (a státusz `withdrawn` lehet, de egy már `user_confirmed` claim
  `user_confirmed` marad). A jelölő csak a véletlen kettős alkalmazást fogja meg. Ezért a későbbi API a redukálónak
  **csak szerveroldalon, a `profiles` sorból előállított, nyers 2A-profilt** adhat (az `adaptProfileRow` kimenetét),
  soha kliens által küldött vagy korábbi kimenetből továbbadott profilt. A tartós/API-fázisig ez **ismert bizalmi
  határ**.

## Nyitott (külön döntés kell)

- **Blokkoló a tartós tár előtt:** adatmegőrzés, visszavonás/törlés és fióktörlés szabálya; kompakció az 5000
  fölötti eseményszámra (lásd fent);
- a döntéstábla és a `profiles` revízió-oszlopai/triggere (migráció, a sorszám a repó tényleges állapotából);
- API-route-ok és a frontend szerződés; `correct`/`declare` a döntésrekordban; `audience`/`avoid_topics`;
- a 2A adapter lazább (`identityKey`) javaslat-illesztése és a 2B szigorú azonossága közti szakadék termékoldali
  kezelése. **Döntés (nem implementálva):** a 2B azonosságot nem lazítjuk. Későbbi API/UX-nél a `confirm`-hoz
  **pontos javaslatátvétel** kell (a tárolt szöveg szó szerint, pl. a `resolve-niche-review` úton), a szabadon beírt
  szöveghez pedig **külön `declare`/`correct` út**. A `value_not_adopted` és az újra megjelenő, más írásmóddal
  újragenerált elvetett javaslat addig a user által látható API/UX előtti blokkoló.
