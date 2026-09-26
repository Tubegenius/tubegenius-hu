# Lifecycle reviewer-útmutató (`corroborating → coherent`)

| | |
| --- | --- |
| **Útmutató-verzió** | **1.0.0** (dokumentum-verzió, lásd a 9. pontot) |
| **Dátum** | 2026-09-26 |
| **Jelleg** | Csak dokumentáció. Tanácsadó jellegű útmutató az emberi reviewernek. Nincs kódhatása. |
| **Backend `reviewPolicyVersion`** | **Változatlan: 1** (`LIFECYCLE_REVIEW_POLICY_VERSION`, `lib/semantic-topic/lifecycle-review-types.ts`). Ezt az útmutató **nem** módosítja, nem küldi a backendnek, és nem tárolja az adatbázisban. |
| **Kapcsolódó szerződés** | `docs/architecture/semantic-topic-identity-v0-contract.md` (§8, §15, §31, §38, §39) |

## 1. Hatály és visszamenőlegesség
- Az útmutató a **jövőbeli** lifecycle review-k emberi mérlegelését segíti. **Nem visszamenőleges.**
- **A korábbi döntések érvényesek és változatlanok:** a hozzárendelési review-k, a meglévő tagságok (az A-tagságot is beleértve), a lifecycle requestek és azok döntései. Egy korábbi tagság újraértékelése **külön döntés**: külön kérdés, hogy kell-e, ki végzi, és milyen engedélyezett gate-tel.
- **Nincs automatikus visszaminősítés.** A tárolt `lifecycle_status` a szerződés szerint nem lép vissza automatikusan, ha a bizonyíték később változik. Ehhez külön, kifejezetten engedélyezett gate kellene (§38, „Stored lifecycle + live evidence-vector").
- Az útmutató **nem ad új mechanikus feltételt.** A mechanikus küszöb (`_semantic_topic_lifecycle_mechanical_check`) változatlan.

## 2. Alapok a szerződésből (nem új szabály)
- **Az egység a tárolt bizonyíték-tétel** (`signal_evidence`: cím + kivonat + publikálási idő), nem a teljes videó vagy cikk. Egy tétel egészében tartozik legfeljebb egy topichoz (§8). A kinyerés a tétel szövegén fut, és tételenként egyetlen jelenség-címkét ad (§15, `extraction-service.ts`). A kinyerés kimenete **AI-segéd**, nem bizonyíték.
- **A `corroborating` mechanikus állítás:** különböző, ismert forrássorok, nem szindikációs másolatok. **Nem** bizonyítja a szerzői függetlenséget és **nem** a szemantikai azonosságot, ezt a `coherent` emberi review-ja ítéli meg (§38).
- **A `coherent` jóváhagyáshoz mind a négy checklist-pont „Megerősítve" kell legyen.** Az indoklás kötelező, de önmagában nem elég (§39).
- **A hatókört a topic rögzített `scope`, `inclusion_criteria` és `exclusion_criteria` mezői adják** (a hozzárendelési review snapshotja, §31).
- A szerződés **nem mondja ki**, hogy egy vegyes témájú tétel mikor „elég" egy konkrét eseményhez. Ezt a 5. pont segédszabálya kezeli, tanácsadó jelleggel.

## 3. Az értékelés hármas skálája
| Jelölés | Jelentése | Mit tegyen a reviewer |
| --- | --- | --- |
| **Kellően alátámasztott** | A megfelelő bizonyítékforrás **kellően alátámasztja** a pontot, és nem áll fenn ellentmondó jel. | Az adott checklist-pont „Megerősítve" jelölhető. |
| **Bizonytalan** | A megengedett forrásból nem dönthető el, vagy csak külső információ segítene. | **Nem** „Megerősítve". Az indoklás megnevezi, mi hiányzik. |
| **Nem megfelelő** | A megengedett forrás **pozitívan ellentmond**. | „Nem teljesül". |

Ha bármelyik pont **bizonytalan** vagy **nem megfelelő**, a `coherent` jóváhagyás nem támogatott. Ilyenkor az **Elutasítás** zárt indoklásai közül a helyzethez illőt használd: **„Még nem áll készen döntésre"** (`not_ready_for_decision`), ha a hiányzó információ beszerezhető. **„Nem elegendő a bizonyíték"** (`insufficient_evidence`), ha a tárolt bizonyíték maga elégtelen. **„Érvénytelen azonossági állítás"** (`invalid_identity_claim`), ha az azonosság pozitívan cáfolt. A **Visszavonás** csak a saját zárt indokaira való.

## 4. Bizonyítékforrások: három külön osztály
A két ellenőrzés (identitás/hatókör és provenance) **különböző forrásra épül**, és nem keverhető.

| Osztály | Mi tartozik ide | Mire használható | Mire **nem** |
| --- | --- | --- | --- |
| **E-I: identitás és hatókör** | A tárolt **cím + kivonat + időpont**. A topic rögzített definíciója, `scope`, bevonási és kizárási kritériuma. A korábbi review-k indoklása (kontextus). A kinyerés kimenete (**csak AI-segéd**). | 1., 2. és 3. checklist-pont | A teljes videó/átirat/cikk mint **bizonyíték**: megnézhető döntéstámogatásként, de **nem emelhet** egy tételt magasabb értékelésre, mint amit a tárolt szöveg támogat („felülvizsgált = tárolt"). |
| **E-P: provenance és önállóság** | A forrássorok és a `source_family_key`. Az `is_syndication_copy_of` jelölő. A kanonikus URL vagy külső azonosító. A csatornák/kiadók nyilvános „Névjegy" adatai (tulajdon, kiírt linkek). A fizetett promóció jelölése. A publikálási idők. A szövegi hasonlóság (**csak diagnosztika**, vágópont nincs). Az azonos forrássor és az eltérő szöveg is **csak diagnosztikai jel** (lásd az 5. pontot). | 4. checklist-pont | Az esemény megtörténtének bizonyítása. |
| **E-C: eseménymegerősítés** | Külső sajtó vagy elsődleges források az esemény megtörténtéről. | **Döntéstámogatás**, az indoklás külön blokkjában. | A 4. pont teljesítése. Az 1. pont önálló bizonyítása. **Nem** provenance, **nem** tagság. |

**Kereszt-tilalmak:** két önálló feldolgozás **nem bizonyítja**, hogy az esemény megtörtént. A sajtó-megerősítés **nem bizonyítja** a feldolgozások függetlenségét. Az E-C-nek mindig meg kell neveznie az **eredet-láncot** (több híradás **közös eredetű**, például ugyanarra a bejegyzésre épül, vagy **eltérő eredetű**).

## 5. A négy teszt
**T-I, azonosítás (E-I).** A tárolt cím és kivonat **együtt** állítja-e az esemény lényegét (mi történt, kivel/mivel, mikor), külső tudás nélkül? Külső tudás kell hozzá → **bizonytalan**.

**T-E, érdemi eseményfeldolgozás (E-I).** A **teljes tárolt cím + kivonat** ténylegesen foglalkozik-e az eseménnyel (elmondja, magyarázza vagy reagál rá), nem csak említi?
- Azonosító részlet nélküli említés → **nem megfelelő**.
- **Diagnosztikai jelzés, nem döntő:** a „kivételi teszt" (ha kivesszük az eseményt leíró mondatokat, változik-e a tétel megnevezett tárgya?). A cím tárgya alapján utalhat arra, hogy az esemény felütés vagy kivezetett példa. Ez **nem helyettesíti** a T-E ítéletet.

**T-S, hatókör (E-I).** A rögzített bevonási/kizárási kritérium lefedi-e a tételt? Ha **mindkettő** ráilleszthető, vagy a szöveg nem dönt: **bizonytalan**. A hatókört a szerződés nem oldja fel, ezt nem szabad csendben egyik irányba eldönteni.

**T-P, önállóság (E-P).** Három állapot:
- **Nem megfelelő (cáfolt):** pozitívan kimutatott másolat vagy szindikáció (szó szerinti újrahasználat, `is_syndication_copy_of`, vagy más, a tétel tartalmára vonatkozó alátámasztás). Ez **egy** feldolgozás, nem kettő. Az **azonos forrássor önmagában nem elég** ehhez (lásd „Diagnosztikai jelek").
- **Nem cáfolt:** külön forrás és család, nincs másolat-jel, nincs kiírt kapcsolat. **A nyilvános kapcsolat hiánya nem elegendő alátámasztás a függetlenséghez.** Sosem jelölhető „kellően alátámasztottnak" a hiányból.
- **Kapcsolat látható → mérlegelés (nem kizárás):** közös tulajdon, keresztlink, fizetett promóció. A reviewer azt ítéli meg, hogy a **tétel szövege** ténylegesen önálló-e. Önmagában a kapcsolat nem zár ki.

**Diagnosztikai jelek, nem következtetések.** Két jel önmagában nem dönt:
- **Azonos forrássor** (`signal_sources`): **nem automatikusan másolat.** Egy forrás (például egy csatorna) több, tartalmilag különálló tételt is adhat. A mechanikus küszöb az azonos forrássorú tételeket egy forrásnak számolja. Ez a számlálás szabálya, nem következtetés arra, hogy a tételek másolatok.
- **Eltérő szöveg**: **nem automatikusan önálló feldolgozás.** Ugyanarra a közös forrásra épülő, átfogalmazott vagy lefordított tartalom szövegileg eltérhet, mégsem önálló.
- Mindkettő **diagnosztikai jel**: a reviewer figyelmét irányítja. A „másolat" vagy az „önálló feldolgozás" **következtetéséhez további alátámasztás kell** (például szó szerinti újrahasználat, `is_syndication_copy_of`, a tételek tartalmi és időbeli összevetése, a nyilvános kiadói adatok).
- Ha csak diagnosztikai jel áll rendelkezésre, a T-P eredménye **nem cáfolt** (a jel jellegétől függően **mérlegelés**), nem „cáfolt", és a függetlenség sem „kellően alátámasztott".

## 6. Indoklás-konvenció (meglévő `reviewer_rationale` mező)
A `reviewer_rationale` legfeljebb **1000 karakter** (`LIFECYCLE_RATIONALE_MAX_LENGTH`). Javasolt szerkezet, rövid blokkokkal:
1. **IDENTITÁS/HATÓKÖR (E-I):** T-I, T-E, T-S eredménye, a kritérium megnevezésével.
2. **ÖNÁLLÓSÁG (E-P):** T-P eredménye (cáfolt / nem cáfolt / kapcsolat látható → mérlegelés), a nyilvános ellenőrzés forrásával.
3. **MEGERŐSÍTÉS (E-C, döntéstámogatás, nem provenance):** források és az eredet-lánc (közös vagy eltérő).
A blokkok egymást nem helyettesítik. Az ellenőrizetlen elemeket **nyitottként** kell megjelölni.

## 7. Nem változik
Kód, séma, migráció, DB, topic-státusz, tagság, a backend `reviewPolicyVersion` (1), a mechanikus küszöb, a korábbi döntések. Nincs új request és nincs executor.

## 8. Alkalmazási példák (tájékoztató, nem döntés)
| Eset | T-I | T-E | T-S | T-P | Összkép |
| --- | --- | --- | --- | --- | --- |
| **Az esetet címben és kivonatban tárgyaló tétel** | Kellően alátámasztott | Kellően alátámasztott | Kellően alátámasztott (ha a bevonás lefedi) | Nem cáfolt | Az ellenőrzött pontokon nincs ellentmondás. Az önállóság **nem kellően alátámasztott**, csak nem cáfolt. |
| **Általános témájú tétel, amelynek kivonata az esettel indul** | Kellően alátámasztott, ha a kivonat elmondja az esetet | **Bizonytalan** (a kivételi teszt kivezetett példát jelezhet, de ez csak jelzés) | **Bizonytalan** (bevonás és kizárás is ráilleszthető) | Nem cáfolt / mérlegelés | **Bizonytalan**, a döntés a reviewer szakmai mérlegelése. |
| Azonosító részlet nélküli futó említés | Nem megfelelő | Nem megfelelő | — | — | **Nem megfelelő** |
| Szó szerinti újrafeltöltés másik csatornán | Kellően alátámasztott | Kellően alátámasztott | Kellően alátámasztott | **Nem megfelelő** (másolat) | Egy feldolgozásnak számít, nem kettőnek. |
| Közös tulajdonú csatornák, mindkettő tárgyszerep | Kellően alátámasztott | Kellően alátámasztott | Kellően alátámasztott | **Mérlegelés** (nem kizárás) | A tétel önállóságának reviewer-ítélete kell. |
| Két híradás ugyanarra a közös forrásra épül | — | — | — | — | Két önálló feldolgozás lehet, az **eseménymegerősítés egy eredetű** (E-C blokkban kimondva). |

### Függelék A: a tech-AI topic A/B esete (állapot: 2026-09-26)
- A topic **`corroborating`, `status_version` 2**, változatlan. Az A-tagság változatlan és érvényes. Az újraértékelése külön döntés.
- **B (NikByte):** T-I, T-E és T-S kellően alátámasztott. Megjegyzés: a definíció „code freeze" eleme a **tárolt** szövegben nem szerepel, azt külső forrás hordozza.
- **A (Kunal Kushwaha):** T-I kellően alátámasztott, T-E és T-S **bizonytalan**. Az A fizetett promóciót jelöl, ez mérlegelendő jelzés.
- **Az A ↔ B önállóság:** nem cáfolt, de nem kellően alátámasztott.
- Az esemény külső megerősítése (sajtó) **közös eredetű**: Lemkin bejegyzései és a Replit nyilatkozatai. Ez E-C, nem provenance.

## 9. Verziózás és változásnapló
- Az **útmutató-verzió** (MAJOR.MINOR.PATCH) **kizárólag dokumentum-verzió**. **Független** a backend `reviewPolicyVersion` értékétől: az útmutató változása nem érinti a backendet, és nem módosít korábbi döntést.
- **PATCH:** szövegjavítás, példa-pontosítás. **MINOR:** új, tanácsadó pontosítás, amely nem változtatja meg egy meglévő teszt jelentését. **MAJOR:** egy teszt vagy a skála jelentése változik.
- Egy új útmutató-verzió **nem visszamenőleges**.

| Verzió | Dátum | Változás |
| --- | --- | --- |
| 1.0.0 | 2026-09-26 | Első verzió: hármas skála, három bizonyítékforrás-osztály, T-I/T-E/T-S/T-P, indoklás-konvenció. A kivételi teszt diagnosztika. A kapcsolat hiánya nem elegendő alátámasztás a függetlenséghez, a kapcsolat nem automatikus kizárás. Az azonos forrássor és az eltérő szöveg csak diagnosztikai jel. Az értékelési kategória neve „kellően alátámasztott". |

## 10. Hivatkozások
- `docs/architecture/semantic-topic-identity-v0-contract.md`: §8 (tagság-egység), §15 (kinyerés), §31 (hozzárendelési review-snapshot), §38 (a `corroborating` mechanikus jellege, nincs automatikus visszaminősítés), §39 (lifecycle keret, négy pont).
- `lib/semantic-topic/extraction-service.ts` (a kinyerés promptja), `lib/semantic-topic/normalize.ts` (a tétel szövege).
- `lib/lifecycle-review-decision-presentation.ts` (a négy checklist-pont és a zárt indokok szövege), `lib/semantic-topic/lifecycle-review-types.ts` (`LIFECYCLE_REVIEW_POLICY_VERSION`, `LIFECYCLE_RATIONALE_MAX_LENGTH`).
