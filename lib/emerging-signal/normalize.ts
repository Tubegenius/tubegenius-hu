// lib/emerging-signal/normalize.ts
// WillViral — Emerging Signal capture, normalizalasi segedfuggvenyek.
//
// A kodbazisban mar letezik harom, majdnem azonos "normalizeForMatch"
// fuggveny (lib/trend-radar.ts, lib/candidate-consistency.ts,
// lib/niche-fit.ts), de EGYIK SEM exportalt — ezert ez a modul
// ujraimplementalja UGYANAZT a bevalt mintat, nem talal ki uj algoritmust.

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0
}

// Determinisztikus canonical URL — protokoll + host (www nelkul, lowercase)
// + path (trailing slash nelkul), query string es fragment nelkul.
// Ervenytelen/nem http(s) URL eseten null — NEM talal ki helyettesito erteket.
export function normalizeCanonicalUrl(rawUrl: string | null | undefined): string | null {
  if (isBlank(rawUrl)) return null
  try {
    const parsed = new URL(rawUrl as string)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const path = parsed.pathname.replace(/\/+$/, '') || '/'
    return `${parsed.protocol}//${host}${path}`
  } catch {
    return null
  }
}

// Web source family (MVP: canonical domain, ld. 051-es migracio fejlece —
// nincs kereszt-domain szindikacio-csoportositas ebben a korben).
export function extractDomain(rawUrl: string | null | undefined): string | null {
  if (isBlank(rawUrl)) return null
  try {
    const parsed = new URL(rawUrl as string)
    return parsed.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

// A Serper `date` mezo szabad szoveg lehet ("2 days ago" stb.) — csak
// szigoruan parse-olhato datumokat fogadunk el. Fuzzy relative-date
// ertelmezes NINCS resze ennek a korenek (nem talalunk ki idobelyeget).
export function safeParseDate(value: string | null | undefined): string | null {
  if (isBlank(value)) return null
  const d = new Date(value as string)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}
