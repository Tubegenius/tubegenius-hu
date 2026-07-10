// ============================================================
// WILLVIRAL — Niche-relevancia kapu
// ============================================================
// A profil niche-e (pl. "AI, orvostudomány") ne szivárogjon be
// automatikusan minden promptba — csak akkor, ha az aktuális téma
// ténylegesen kapcsolódik hozzá. Enélkül pl. egy "otthoni edzés
// kezdőknek" témájú cím/leírás is indokolatlanul AI-t vagy orvost
// emlegetne, mert a promptba mindig belekerült a profil niche.
//
// MVP-logika: szó-szintű egyezés vagy legalább 5 karakteres közös
// prefix a téma és a niche/kategória tokenjei között (nem nyers
// substring-keresés, mert az pl. "ai"-t "kutyusaim"-ban is
// megtalálná — szóhatáros egyezést nézünk).

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const RELEVANCE_STOPWORDS = new Set([
  'es', 'a', 'az', 'egy', 'de', 'vagy', 'hogy', 'mint', 'is', 'nem', 'meg',
  'the', 'and', 'for', 'with', 'this', 'that', 'of', 'in', 'on', 'at', 'to', 'an',
])

export function tokenize(s: string): string[] {
  return normalize(s).split(' ').filter(w => w.length > 0 && !RELEVANCE_STOPWORDS.has(w))
}

function sharedPrefixLength(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

export function shouldUseProfileNiche(input: {
  topic: string
  profileNiche?: string | null
  mainCategory?: string | null
  specificFocus?: string | null
}): boolean {
  const topic = (input.topic || '').trim()
  const profileNiche = (input.profileNiche || '').trim()
  if (!topic || !profileNiche) return false

  const nicheTokens = new Set([
    ...tokenize(profileNiche),
    ...(input.mainCategory ? tokenize(input.mainCategory) : []),
    ...(input.specificFocus ? tokenize(input.specificFocus) : []),
  ])
  if (nicheTokens.size === 0) return false

  const topicWords = tokenize(topic)
  if (topicWords.length === 0) return false

  for (const topicWord of topicWords) {
    for (const nicheToken of nicheTokens) {
      if (nicheToken.length < 2) continue
      if (topicWord === nicheToken) return true
      if (sharedPrefixLength(topicWord, nicheToken) >= 5) return true
    }
  }
  return false
}

// A promptba mindig bekerülő, niche-fuggetlen "maradj a témánál" szabály —
// azt is megakadályozza, hogy a modell magától, sajat kezdemenyezesre
// keverjen be egy korabbi kontextusból (pl. rendszerprompt) ismert fokuszt.
export const STAY_ON_TOPIC_RULE =
  'A kimenet KIZÁRÓLAG a fenti TÉMÁRÓL szóljon. Ne keverj bele más szakterületet, iparágat vagy fókuszt, ami nem szerepel a TÉMA mezőben — akkor sem, ha az általában a csatorna profiljához kapcsolódna.'
