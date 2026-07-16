// ============================================================
// WILLVIRAL — Content Gap Finder (Phase 2 #10)
// ============================================================
// A "res" azonositasa ket VALOS jelforrás osszevetesebol szarmazik:
// (1) mi mar letezik a YouTube-on erre a temara (valos videocimek),
// (2) mire van tenyleges kereslet (Google relatedSearches/peopleAlsoAsk).
// Az AI csak ezt a ket valos halmazt veti ossze — nem talal ki keresletet.

export interface ContentGapSuggestion {
  gap_topic: string
  demand_signal: string
  evidence: string
  angle: string
}

function normalizeSignal(value: string) {
  return value.trim().toLocaleLowerCase('hu-HU').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ')
}

export function validateContentGapSuggestions(value: unknown, allowedDemandSignals: string[]): ContentGapSuggestion[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 8) throw new Error('A content gap javaslatok elemszáma hibás.')
  const allowed = new Set(allowedDemandSignals.map(normalizeSignal))
  const seenTopics = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Hibás content gap javaslat.')
    const row = item as Record<string, unknown>
    const gapTopic = typeof row.gap_topic === 'string' ? row.gap_topic.trim() : ''
    const demandSignal = typeof row.demand_signal === 'string' ? row.demand_signal.trim() : ''
    const evidence = typeof row.evidence === 'string' ? row.evidence.trim() : ''
    const angle = typeof row.angle === 'string' ? row.angle.trim() : ''
    const topicKey = normalizeSignal(gapTopic)
    if (!gapTopic || gapTopic.length > 200 || seenTopics.has(topicKey) || !allowed.has(normalizeSignal(demandSignal)) || !evidence || evidence.length > 800 || !angle || angle.length > 800) {
      throw new Error('Hiányos, ismétlődő vagy nem bizonyított content gap javaslat.')
    }
    seenTopics.add(topicKey)
    return { gap_topic: gapTopic, demand_signal: demandSignal, evidence, angle }
  })
}

export function buildContentGapPrompt(input: {
  niche: string
  existingVideoTitles: string[]
  relatedSearches: string[]
  peopleAlsoAsk: string[]
}): string {
  return `Egy magyar tartalomgyártónak segítesz megtalálni a tartalmi réseket (content gap) ebben a niche-ben: "${input.niche}"

RELEVÁNS YOUTUBE-VIDEÓCÍMEK A LEGFELJEBB 25 TALÁLATOS KERESÉSI MINTÁBÓL:
${input.existingVideoTitles.slice(0, 20).map(t => `- ${t}`).join('\n') || '(nincs adat)'}

VALÓS KERESÉSI IGÉNY (Google kapcsolódó keresések + "emberek ezt is kérdezik"):
${[...input.relatedSearches, ...input.peopleAlsoAsk].map(q => `- ${q}`).join('\n') || '(nincs adat)'}

FELADAT:
Vesd össze a két listát. Keress olyan keresési igényeket vagy kérdéseket, amelyekre a VIDEÓCÍMEK KORLÁTOZOTT MINTÁJA alapján ÚGY TŰNIK, nincs közvetlen válasz, vagy a találatok más szögből közelítik meg. Ez csak rés-jelölt, nem a teljes YouTube-lefedettség bizonyítéka.

Adj 3-8 KONKRÉT content gap javaslatot. Minden javaslathoz:
- gap_topic: a konkrét, hiányzó videótéma
- demand_signal: pontosan egy elem a fenti VALÓS KERESÉSI IGÉNY listából, változtatás nélkül
- evidence: 1 mondat, MIÉRT gondolod, hogy ez rés (hivatkozz a fenti adatra — pl. "ezt kérdezik, de a létező videók X-ről szólnak, nem erről")
- angle: 1 mondatos javaslat, milyen szögből érdemes feldolgozni

KRITIKUS SZABÁLYOK:
- CSAK a fenti két lista alapján dolgozz — ne találj ki külső adatot vagy statisztikát.
- A keresési jel nem keresési volumen: ne állítsd, hogy sokan keresik vagy hogy népszerű.
- Ne állítsd, hogy senki nem készített még ilyen videót; csak a megadott keresési mintáról beszélhetsz.
- Ha egy keresési igényre már van jó lefedettség a listában, NE javasold azt gap-ként.
- SOHA ne használj idézőjelet a JSON string értékek BELSEJÉBEN.

Válaszolj KIZÁRÓLAG valid JSON tömbben:
[{"gap_topic": "...", "demand_signal": "a fenti lista egyik pontos eleme", "evidence": "...", "angle": "..."}]`
}
