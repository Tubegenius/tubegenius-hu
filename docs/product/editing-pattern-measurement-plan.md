# Editing Pattern Engine — mérési terv: retention-görbe becslés és stílusklaszterezés

Státusz: **terv; semmi nem épült, és a UI-ban semmi nem jelenhet meg kész eredményként.** Az `EditingAnalysisResult`
csak `not_available` jelölőt hordoz ezekre (`reason: no_training_data_baseline_calibration`).

## 1. Miért nem jelenhet meg még

Nincs (a) tanítóadat, amelyben vágásmetrikák mellett mért nézőmegtartás van; (b) baseline, amelyhez a becslés hasznosságát
mérjük; (c) kalibráció, amely megmondja, mennyire megbízható az adott becslés. Ezek nélkül egy görbe vagy klaszter
**pontosságot sugallna, amit nem mértünk**. A vágásérzékelő maga is csak fiktív fixture-ökön igazolt.

## 2. Előfeltétel: a vágásérzékelő validálása valós adaton

| Lépés | Mit mérünk | Kapu |
|---|---|---|
| V1 | címkézett vágásadat (hozzájáruló alkotók vagy licenc-ellenőrzött nyilvános shot-határ adatkészlet) | az adatforrás és a hozzájárulás dokumentált |
| V2 | precision / recall a kemény vágásokra, időbélyeg-toleranciával; külön: sötét, gyors mozgású, fokozatos átmenetes anyag | **előre rögzített** küszöbök (termékfelelős) |
| V3 | a küszöb- és padló-értékek újrakalibrálása | a V2 küszöbeinek teljesítése tartott kimaradó adaton |

A retention-modell addig nem indul, amíg a V2 kapu nem teljesül: rossz vágásmetrikára épített modell félrevezető.

## 3. Retention-görbe becslés

**Cél:** egy videó nézőmegtartási görbéjének (a hossz %-ában, pl. 10 %-os lépcsőkkel) becslése vágás- és pacing-metrikákból.

**Adat:**
- a mért megtartás forrása: a YouTube Analytics audience-retention adat **az alkotó hozzájárulásával** (OAuth), vagy alkotó által
  exportált adat. Hozzájárulás nélkül nincs adat. Nem használunk idegen csatorna nem nyilvános adatát.
- elemzési egység: videó; csoportosítás: alkotó, niche, hossz-sáv, platform.
- jellemzők: az `EditingAnalysisResult` metrikái (átlagos shot-hossz, vágássűrűség, pacing-ablakok, nyitó ablak),
  **plusz a zavaró tényezők**: hossz, téma/niche, platform, thumbnail és cím (ezeket a modellben kontrollálni kell).
- minimális mennyiség: előre rögzítendő (alkotónként és szegmensenként); a döntés a termékfelelősé, az adatfelmérés (M0) után.

**Baseline-ok (a modellnek ezeket kell legyőznie):**
- B0: a hossz-sáv és platform átlagos megtartási görbéje;
- B1: B0 + regresszió a hosszra és a niche-re (vágásmetrikák nélkül);
- B2: B1 + a már meglévő metaadat-jellemzők.

A vágásmetrikák hozzáadott értéke = a modell és a B1/B2 különbsége **kimaradó adaton**.

**Kiértékelés:**
- felosztás **alkotó szerint és idő szerint** (nincs szivárgás: ugyanaz az alkotó nem lehet a tanító és a teszt halmazban);
- hibamérték: a görbe MAE-je a rögzített pontokon, az átlagos nézési arány hibája, rangkorreláció;
- kalibráció: az előre jelzett sávok (pl. 80 %-os) tényleges lefedettsége, megbízhatósági diagram, szegmensenként;
- szegmens-elemzés: rövid/hosszú, niche, alkotó-méret; ahol nem teljesül, ott nem jelenik meg.

**Elfogadási kapuk (a számokat az adat megtekintése ELŐTT kell rögzíteni):** a B1-hez képest szignifikáns javulás a
kimaradó adaton; a kalibráció a megengedett sávon belül; az alkotó-szintű hiba nem romlik a baseline alá.

## 4. Stílusklaszterezés

**Cél:** vágási/ritmus-stílus csoportok felismerése (leíró, nem minősítő).

- jellemzők: shot-hossz eloszlás, vágássűrűség, pacing-profil, nyitó ablak; **hossz- és platform-normalizálással**.
- módszer: felügyelet nélküli; a klaszterszám nem előre adott, hanem stabilitás alapján választott.
- validáció: (a) **stabilitás** bootstrap-mintákon (egyezés-mérték), (b) szétválás (silhouette), (c) **vak emberi címkézés**,
  legalább két értékelővel, egyetértés-mérővel, (d) a klaszter ne legyen egyetlen alkotóra vagy niche-re redukálható.
- kimondott tiltás: a klaszter nem lehet „jó/rossz” vagy „viral” minősítés; nevet csak emberi validáció után kaphat.

## 5. Megjelenítési kapu (mindkét eredményre)

Csak akkor jelenhet meg, ha egyszerre teljesül: a vágásérzékelő V2 kapuja; a modell elfogadási kapui kimaradó adaton;
dokumentált kalibráció; a UI az **bizonytalanságot** is mutatja (sáv, nem pontérték); a felületi szöveg nem ígér eredményt;
árnyék-üzemmód (a becslés számolódik, de nem látható) legalább egy előre rögzített időszakra. Addig a UI a
`not_available` állapotot jeleníti meg, és nem rajzol görbét vagy címkét.

## 6. Fázisok

| Fázis | Tartalom | Kimenet |
|---|---|---|
| M0 | adatfelmérés: van-e hozzájárult, mért megtartási adat, mennyi, milyen szegmensben | mennyiség- és hozzájárulás-jelentés |
| M1 | vágásérzékelő validálása (V1–V3) | precision/recall, kalibrált küszöbök |
| M2 | baseline-ok és jellemzők | B0–B2 eredmények kimaradó adaton |
| M3 | retention-modell és kalibráció | elfogadási kapuk teljesítése vagy elutasítás |
| M4 | stílusklaszterezés és validáció | stabilitás, emberi egyetértés |
| M5 | árnyék-üzemmód, majd megjelenítési döntés | termékdöntés |

## 7. Adatvédelem és megőrzés (döntési pont)

A tanítóadat alkotói hozzájáruláshoz kötött; a megőrzési idő, az anonimizálás és a törlés (fiók-kaszkád) **külön
adatmegőrzési döntés**, a tartós tárolás előtt. Ez a terv nem ír elő megőrzési időt.
