import { NextRequest, NextResponse } from 'next/server'
import { isFactRelevantToTopic } from '@/lib/fact-safety'

interface FactSource {
  title: string
  snippet: string
  url: string
  source_type: 'wikipedia' | 'web'
}

// Wikipedia keresés (magyar + angol)
async function fetchWikipedia(query: string, lang: 'hu' | 'en' = 'hu'): Promise<FactSource | null> {
  try {
    // 1. Keresés a megfelelő cikkre
    const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=1`
    const searchRes = await fetch(searchUrl)
    const searchData = await searchRes.json()

    const firstResult = searchData?.query?.search?.[0]
    if (!firstResult) return null

    const title = firstResult.title

    // 2. Cikk kivonat lekérése
    const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
    const summaryRes = await fetch(summaryUrl)
    if (!summaryRes.ok) return null
    const summaryData = await summaryRes.json()

    return {
      title: summaryData.title,
      snippet: summaryData.extract || '',
      url: summaryData.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      source_type: 'wikipedia',
    }
  } catch (e) {
    console.error('Wikipedia fetch error:', e)
    return null
  }
}

// Serper.dev Google keresés
async function fetchSerper(query: string): Promise<FactSource[]> {
  const apiKey = process.env.SERPER_API_KEY
  if (!apiKey) return []

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, gl: 'hu', hl: 'hu', num: 5 }),
    })

    if (!res.ok) return []
    const data = await res.json()

    const results: FactSource[] = (data.organic || []).slice(0, 4).map((item: { title: string; snippet: string; link: string }) => ({
      title: item.title,
      snippet: item.snippet || '',
      url: item.link,
      source_type: 'web' as const,
    }))

    return results
  } catch (e) {
    console.error('Serper fetch error:', e)
    return []
  }
}

export async function POST(request: NextRequest) {
  try {
    const { topic, language } = await request.json()

    if (!topic) {
      return NextResponse.json({ error: 'Téma megadása kötelező' }, { status: 400 })
    }

    const lang = language === 'hu' ? 'hu' : 'en'

    // Párhuzamos lekérés
    const [wikiResult, serperResults] = await Promise.all([
      fetchWikipedia(topic, lang),
      fetchSerper(topic),
    ])

    // A Wikipedia/Google keresés lazán illeszkedhet — pl. "otthoni edzés
    // kezdőknek"-re egy teljesen kapcsolódás nélküli futballista-életrajzot
    // adott vissza. A relevancia-ellenőrzés nélkül ez "ellenőrzött tényként"
    // kerülne be a videócsomagba, ami a Fact Safety Layer fő ígéretét sérti.
    const sources: FactSource[] = []
    if (wikiResult && isFactRelevantToTopic(topic, wikiResult)) sources.push(wikiResult)
    sources.push(...serperResults.filter(s => isFactRelevantToTopic(topic, s)))

    // Ha semmi nem jött vissza
    if (sources.length === 0) {
      return NextResponse.json({
        topic,
        sources: [],
        fact_block: null,
        has_data: false,
      })
    }

    // Fact block összeállítása — strukturált szöveg Claude számára
    const fact_block = sources.map((s, i) =>
      `[Forrás ${i + 1}: ${s.title}]\n${s.snippet}\nURL: ${s.url}`
    ).join('\n\n')

    return NextResponse.json({
      topic,
      sources,
      fact_block,
      has_data: true,
    })
  } catch (error) {
    console.error('Facts API error:', error)
    return NextResponse.json({ error: 'Tényadatok lekérése sikertelen.' }, { status: 500 })
  }
}
