const TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  // Common mojibake fragments from older generated strings and source files.
  [/Ă/g, 'Á'],
  [/Ă‰/g, 'É'],
  [/ĂŤ/g, 'Í'],
  [/Ă“/g, 'Ó'],
  [/Ă–/g, 'Ö'],
  [/Ăš/g, 'Ú'],
  [/Ăś/g, 'Ü'],
  [/Ăˇ/g, 'á'],
  [/Ă©/g, 'é'],
  [/Ă­/g, 'í'],
  [/Ăł/g, 'ó'],
  [/Ă¶/g, 'ö'],
  [/Ăş/g, 'ú'],
  [/ĂĽ/g, 'ü'],
  [/Ĺ°/g, 'Ű'],
  [/Ĺ‘/g, 'ő'],
  [/Ĺ±/g, 'ű'],
  [/Ĺ/g, 'Ő'],
  [/â€”/g, '-'],
  [/â€“/g, '-'],
  [/â€ž/g, '"'],
  [/â€ť/g, '"'],
  [/â€˘/g, "'"],
  [/Â·/g, '·'],

  // Frequent already-corrupted whole words.
  [/VideĂł/g, 'Videó'],
  [/TĂ©ma/g, 'Téma'],
  [/TĂ­pus/g, 'Típus'],
  [/Ăllapot/g, 'Állapot'],
  [/DĂˇtum/g, 'Dátum'],
  [/LegutĂłbbi/g, 'Legutóbbi'],
  [/tĂ¶rtĂ©neted/g, 'történeted'],
  [/MĂ©g/g, 'Még'],
  [/naplĂłzott/g, 'naplózott'],
  [/aktivitĂˇs/g, 'aktivitás'],
  [/KĂ©szĂ­ts/g, 'Készíts'],
  [/elsĹ‘/g, 'első'],
  [/videĂłcsomag/g, 'videócsomag'],
  [/videĂłcsomagot/g, 'videócsomagot'],
  [/elemzĂ©shez/g, 'elemzéshez'],
  [/szemĂ©lyes/g, 'személyes'],
  [/mutatĂłid/g, 'mutatóid'],
  [/kĂˇrtyĂˇk/g, 'kártyák'],
  [/Ăˇtlag/g, 'átlag'],
  [/pontszĂˇm/g, 'pontszám'],
  [/felhasznĂˇlva/g, 'felhasználva'],
  [/Ă¶sszesen/g, 'összesen'],
  [/tĂ©mĂˇk/g, 'témák'],
  [/lezĂˇrva/g, 'lezárva'],
  [/minĹ‘sĂ©g/g, 'minőség'],
  [/TartalomirĂˇny/g, 'Tartalomirány'],
  [/EllenĹ‘rzĂ¶tt/g, 'Ellenőrzött'],
  [/korlĂˇtokkal/g, 'korlátokkal'],
  [/KevĂ©s/g, 'Kevés'],
  [/forrĂˇs/g, 'forrás'],
  [/hĂ­r/g, 'hír'],
  [/kockĂˇzat/g, 'kockázat'],
  [/projektjeid/g, 'projektjeid'],
  [/lehetĹ‘sĂ©g/g, 'lehetőség'],
  [/keresĂ©se/g, 'keresése'],
  [/videĂłjelek/g, 'videójelek'],
  [/LĂˇtott/g, 'Látott'],
  [/videĂłk/g, 'videók'],
  [/lekĂ©r/g, 'lekér'],
  [/kĂ¶zben/g, 'közben'],
  [/amĂşgy/g, 'amúgy'],
  [/naplĂłzza/g, 'naplózza'],
  [/Megvett eredmĂ©ny/g, 'Megvett eredmény'],
  [/Mentett eredmĂ©ny/g, 'Mentett eredmény'],
  [/LezĂˇrva/g, 'Lezárva'],
  [/ElutasĂ­tva/g, 'Elutasítva'],
  [/ErĹ‘sĂ¶dik/g, 'Erősödik'],

  // Accentless leftovers that are common in AI output and prompts.
  [/\bAltalanos ajanlasok\b/gi, 'Általános ajánlások'],
  [/\bSajat analytics alapjan pontosithato\b/gi, 'Saját analytics alapján pontosítható'],
  [/\bPontosabb idoziteshez sajat csatorna teljesitmenyadat szukseges\b/gi, 'Pontosabb időzítéshez saját csatorna teljesítményadat szükséges'],
  [/\bFelvezetes\b/g, 'Felvezetés'],
  [/\bFo gondolat\b/g, 'Fő gondolat'],
  [/\bFo tartalom\b/g, 'Fő tartalom'],
  [/\bFelismeres\b/g, 'Felismerés'],
  [/\bKovetkezmeny\b/g, 'Következmény'],
  [/\bLezaras\b/g, 'Lezárás'],
  [/\bNarracio\b/g, 'Narráció'],
  [/\bVizual\b/g, 'Vizuál'],
  [/\bCim\b/g, 'Cím'],
  [/\bOsszefoglalas\b/g, 'Összefoglalás'],
  [/\bTemahoz\b/g, 'Témához'],
  [/\bRovid\b/g, 'Rövid'],
  [/\bMagyar cim\b/g, 'Magyar cím'],
  [/\brovid caption\b/gi, 'rövid caption'],
  [/\bSEO-barat\b/gi, 'SEO-barát'],
  [/\bszo\b/g, 'szó'],
  [/\bszoban\b/g, 'szóban'],
  [/\bmasodperc\b/g, 'másodperc'],
  [/\bidoszak\b/g, 'időszak'],
  [/\bpasssziv\b/gi, 'passzív'],
  [/\bszakkifejezés-heavy\b/g, 'szakkifejezésekkel terhelt'],
  [/\bnem-szakmai\b/g, 'nem szakmai'],
  [/\bEros\b/g, 'Erős'],
  [/\bKozepes\b/g, 'Közepes'],
  [/\bKozvetlenul\b/g, 'Közvetlenül'],
  [/\bReszben\b/g, 'Részben'],
  [/\bTavolabb all\b/g, 'Távolabb áll'],
  [/\bniche-edtol\b/g, 'niche-edtől'],

  // Accentless Opportunity/validation phrases that make paid output feel unfinished.
  [/\bGyenge\/kozepes jel\b/gi, 'Gyenge/közepes jel'],
  [/\bKutatando irany\b/gi, 'Kutatandó irány'],
  [/\btovabbi forraskereses kell\b/gi, 'további forráskeresés kell'],
  [/\bmielott gyartasi temava valik\b/gi, 'mielőtt gyártási témává válik'],
  [/\bNincs eros videos bizonyitek\b/gi, 'Nincs erős videós bizonyíték'],
  [/\bNincs relevans YouTube bizonyitek\b/gi, 'Nincs releváns YouTube bizonyíték'],
  [/\bNem passzolo forrasokat kiszurtunk\b/gi, 'Nem passzoló forrásokat kiszűrtünk'],
  [/\bTovabbi szukites vagy mely frissites javasolt\b/gi, 'További szűkítés vagy mély frissítés javasolt'],
  [/\btovabbi szukites\b/gi, 'további szűkítés'],
  [/\bmely frissites\b/gi, 'mély frissítés'],
  [/\bforraskereses\b/gi, 'forráskeresés'],
  [/\bgyartasi temava\b/gi, 'gyártási témává'],
  [/\bbizonyitek\b/gi, 'bizonyíték'],

  // Guardrail for odd Claude wording seen in Viral Score recommendations.
  [/\bmédiabűke\b/gi, 'webes visszhang'],
  [/\bmediabuke\b/gi, 'webes visszhang'],
  [/\bmédia ?bűke\b/gi, 'webes visszhang'],
  [/\bmedia ?buke\b/gi, 'webes visszhang'],
]

const SECTION_TITLE_REPLACEMENTS: Record<string, string> = {
  Hook: 'Hook',
  Felvezetes: 'Felvezetés',
  'Fo gondolat': 'Fő gondolat',
  'Fo tartalom': 'Fő tartalom',
  Felismeres: 'Felismerés',
  Kontextus: 'Kontextus',
  Kovetkezmeny: 'Következmény',
  'Lezaras + CTA': 'Lezárás + CTA',
  'Hook + Intro': 'Hook + Intro',
  CTA: 'CTA',
}

export function polishHungarianText(value: string): string {
  let text = value
  for (const [pattern, replacement] of TEXT_REPLACEMENTS) {
    text = text.replace(pattern, replacement)
  }
  return text
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .trim()
}

export function polishHungarianOutput<T>(value: T): T {
  if (typeof value === 'string') {
    return polishHungarianText(value) as T
  }
  if (Array.isArray(value)) {
    return value.map(item => polishHungarianOutput(item)) as T
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'title' && typeof item === 'string' && SECTION_TITLE_REPLACEMENTS[item]) {
        output[key] = SECTION_TITLE_REPLACEMENTS[item]
      } else {
        output[key] = polishHungarianOutput(item)
      }
    }
    return output as T
  }
  return value
}

export function polishStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null
  const labels: Record<string, string> = {
    verified: 'Ellenőrzött',
    verified_with_limits: 'Ellenőrzött, korlátokkal',
    insufficient_sources: 'Kevés forrás',
    saved: 'Mentett',
    in_progress: 'Folyamatban',
    completed: 'Lezárva',
    rejected: 'Elutasítva',
    completed_paid: 'Megvett eredmény',
    completed_free: 'Mentett eredmény',
  }
  return labels[status] || polishHungarianText(status)
}
