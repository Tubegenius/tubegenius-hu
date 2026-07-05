const TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/Altalanos ajanlasok/g, 'Általános ajánlások'],
  [/Sajat analytics alapjan pontosithato/g, 'Saját analytics alapján pontosítható'],
  [/Pontosabb idoziteshez sajat csatorna teljesitmenyadat szukseges/g, 'Pontosabb időzítéshez saját csatorna teljesítményadat szükséges'],
  [/Felvezetes/g, 'Felvezetés'],
  [/Fo gondolat/g, 'Fő gondolat'],
  [/Fo tartalom/g, 'Fő tartalom'],
  [/Kovetkezmeny/g, 'Következmény'],
  [/Lezaras/g, 'Lezárás'],
  [/Narracio/g, 'Narráció'],
  [/Vizual/g, 'Vizuál'],
  [/Cim/g, 'Cím'],
  [/Osszefoglalas/g, 'Összefoglalás'],
  [/Temahoz/g, 'Témához'],
  [/Rovid/g, 'Rövid'],
  [/Magyar cim/g, 'Magyar cím'],
  [/rovid caption/g, 'rövid caption'],
  [/SEO-barĂˇt/g, 'SEO-barát'],
  [/szo\b/g, 'szó'],
  [/szoban\b/g, 'szóban'],
  [/masodperc/g, 'másodperc'],
  [/idoszak/g, 'időszak'],
  [/passszív/g, 'passzív'],
  [/passsziv/g, 'passzív'],
  [/szakkifejezés-heavy/g, 'szakkifejezésekkel terhelt'],
  [/nem-szakmai/g, 'nem szakmai'],
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