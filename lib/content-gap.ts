// ============================================================
// WILLVIRAL — Content Gap Finder (Phase 2 #10)
// ============================================================
// A "res" azonositasa ket VALOS jelforrás osszevetesebol szarmazik:
// (1) mi mar letezik a YouTube-on erre a temara (valos videocimek),
// (2) mire van tenyleges kereslet (Google relatedSearches/peopleAlsoAsk).
// Az AI csak ezt a ket valos halmazt veti ossze — nem talal ki keresletet.

export interface ContentGapSuggestion {
  gap_topic: string
  evidence: string
  angle: string
}

export function buildContentGapPrompt(input: {
  niche: string
  existingVideoTitles: string[]
  relatedSearches: string[]
  peopleAlsoAsk: string[]
}): string {
  return `Egy magyar tartalomgyártónak segítesz megtalálni a tartalmi réseket (content gap) ebben a niche-ben: "${input.niche}"

MÁR LÉTEZŐ YOUTUBE VIDEÓK CÍMEI ERRE A TÉMÁRA (ezt már sokan lefedték):
${input.existingVideoTitles.slice(0, 20).map(t => `- ${t}`).join('\n') || '(nincs adat)'}

VALÓS KERESÉSI IGÉNY (Google kapcsolódó keresések + "emberek ezt is kérdezik"):
${[...input.relatedSearches, ...input.peopleAlsoAsk].map(q => `- ${q}`).join('\n') || '(nincs adat)'}

FELADAT:
Vesd össze a két listát. Keress olyan keresési igényeket vagy kérdéseket, amikre a MÁR LÉTEZŐ videócímek alapján ÚGY TŰNIK, nincs jó válasz (vagy a meglévő videók más szögből közelítik meg). Ez a "content gap" — amit még senki nem gyártott jól le.

Adj 5-8 KONKRÉT content gap javaslatot. Minden javaslathoz:
- gap_topic: a konkrét, hiányzó videótéma
- evidence: 1 mondat, MIÉRT gondolod, hogy ez rés (hivatkozz a fenti adatra — pl. "ezt kérdezik, de a létező videók X-ről szólnak, nem erről")
- angle: 1 mondatos javaslat, milyen szögből érdemes feldolgozni

KRITIKUS SZABÁLYOK:
- CSAK a fenti két lista alapján dolgozz — ne találj ki külső adatot vagy statisztikát.
- Ha egy keresési igényre már van jó lefedettség a listában, NE javasold azt gap-ként.
- SOHA ne használj idézőjelet a JSON string értékek BELSEJÉBEN.

Válaszolj KIZÁRÓLAG valid JSON tömbben:
[{"gap_topic": "...", "evidence": "...", "angle": "..."}]`
}
