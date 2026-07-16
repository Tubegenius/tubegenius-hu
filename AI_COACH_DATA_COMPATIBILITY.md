# AI Coach sajátadat-kompatibilitás

Utolsó audit: 2026-07-16. Ez az AI Coach későbbi megvalósításának adat- és állításbiztonsági szerződése; jelenleg még nincs általános chat/coach végpont.

| Saját adatforrás | Jelenlegi alkalmasság | Coach által megengedett állítás |
|---|---|---|
| Creator profil, niche, platform | használható | személyre szabási preferencia |
| Video Idea workflow és Memory state | használható | mentett, folyamatban lévő, publikáltnak jelölt vagy elutasított döntés |
| Proof signalok | használható, provenance mezőkkel | piaci bizonyíték erőssége és forrása |
| Video Idea események | használható | a WillViralban történt döntések idővonala |
| Video Audit / Channel Audit | használható, AI/heurisztikus értékelésként címkézve | diagnosztizált erősség vagy kockázat; nem valós nézettségi siker |
| Competitor és trend snapshotok | használható | mért VPH/növekedés a snapshot-időponttal és confidence-szel |
| Paid Results és Video Package | használható | korábban elkészült elemzés vagy gyártási döntés |
| YouTube OAuth Analytics | részben használható | valós csatorna- és videóteljesítmény a lekért időablakban |

## Kötelező korlátok az AI Coach előtt

1. A `published` workflow csak publikálási döntés, nem sikerbizonyíték. „Bejött”, „jobban működött” vagy teljesítmény-összehasonlítás csak összekapcsolt YouTube Analytics outcome alapján mondható.
2. Minden kontextuselemhez tartozzon `source_type`, rekordazonosító, mérési/keletkezési idő, adatjellege (`measured`, `heuristic`, `ai_assessment`, `user_decision`) és confidence.
3. A coach kontextusa kizárólag tenant-szűrt, szerveroldalon összeállított és elemszám/méret szerint korlátozott lehet. A kliens nem küldhet hitelesnek tekintett sajátadat-JSON-t.
4. A Video Idea és a YouTube-videó közötti determinisztikus outcome-kapcsolat még hiányzik. Enélkül a coach nem tanulhatja meg, hogy egy ötlet ténylegesen jól vagy rosszul teljesített.
5. Kevés vagy ellentmondó adatnál a válasz mondja ki a bizonytalanságot, és kérjen következő mérési lépést; ne töltsön ki hiányzó tényt AI-véleménnyel.
6. A későbbi coach-végpontnak ugyanazt a paid-result, kredit, lock, prompt-verzió, timeout és output-validációs rendszert kell használnia, mint a többi fizetős eszköznek.

## Következő implementációs kapu

Előbb szerveroldali, verziózott `CreatorEvidenceContext` builder szükséges. Csak ezután épülhet AI Coach chat vagy mély válasz. A builder első verziója ne generáljon szöveget: kizárólag normalizált, provenance-os sajátadat-csomagot adjon vissza és legyen determinisztikusan tesztelhető.
