'use client'

import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'
import type { UsageCheckResult } from '@/lib/usage-protection'

interface ExtractResult {
  video_id: string
  title: string
  channel: string
  hook: string
  structure: Array<{ timestamp: string; label: string; content: string; type: string }>
  key_points: string[]
  success_factors: string
  estimated_duration: string
  word_count: number
  stats: { view_count: number; like_count: number; comment_count: number }
  metadata_only: boolean
  transcript_available?: boolean
  transcript_source?: 'transcript' | 'metadata'
  raw_transcript?: string | null
  from_paid_result?: boolean
  paid_result_id?: string | null
  _credits_remaining?: number
}

const sectionTypeColor: Record<string, string> = {
  hook: 'border-violet/40 bg-violet/5',
  intro: 'border-violet/30 bg-violet/5',
  main: 'border-border bg-surface-2',
  cta: 'border-emerald/30 bg-emerald/5',
  outro: 'border-border bg-surface-2',
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${copied ? 'text-emerald bg-emerald/10 border-emerald/20' : 'text-text-muted bg-surface-2 border-border hover:text-text-secondary'}`}>
      {copied ? '✓ Másolva' : label}
    </button>
  )
}

const CACHE_PREFIX = 'willviral_script_extract_'
const LAST_URL_KEY = 'willviral_script_extract_last_url'

export default function ScriptExtractorPage() {
  const searchParams = useSearchParams()
  const [url, setUrl] = useState(searchParams.get('url') || '')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ExtractResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const pendingActionRef = useRef<(() => void) | null>(null)
  const inspirationMode = searchParams.get('mode') === 'inspiration'
  const sourceContext = searchParams.get('source_context') || null

  useEffect(() => {
    // A "Legutóbbi történeted" panelről érkező, perzisztens megvett eredmény —
    // kredit nélkül, kredit-megerősítés nélkül tölti vissza a mentett kinyerést.
    const paidResultId = searchParams.get('paidResultId')
    if (paidResultId) {
      fetch(`/api/script-extract?paidResultId=${paidResultId}`)
        .then(r => r.json())
        .then(data => {
          if (data.error) { setError(data.error); return }
          setUrl(`https://youtube.com/watch?v=${data.video_id}`)
          setResult(data)
        })
        .catch(() => setError('Hiba a betöltés során'))
      return
    }

    let urlParam = searchParams.get('url')

    // Ha nincs URL paraméter (pl. "vissza" navigáció paraméter nélküli URL-re),
    // próbáljuk betölteni az utoljára elemzett videó eredményét a sessionStorage-ból.
    if (!urlParam) {
      urlParam = sessionStorage.getItem(LAST_URL_KEY)
      if (!urlParam) return
    }

    setUrl(urlParam)

    // Cache ellenőrzés — ne generáljon újra vissza-navigáláskor
    const cacheKey = CACHE_PREFIX + urlParam
    const cachedRaw = sessionStorage.getItem(cacheKey)
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw)
        setResult(cached)
        return // nincs új API hívás
      } catch {}
    }

    // Csak akkor indítsunk új generálást, ha az URL explicit paraméterből jött
    // (ne generáljon automatikusan, ha csak az "utolsó URL" emlékből töltöttünk be, de nincs cache hozzá)
    if (searchParams.get('url')) {
      checkCreditsBeforeAction(3, 'Script Extractor', () => handleExtractUrl(urlParam!))
    }
  }, [])

  async function checkCreditsBeforeAction(cost: number, featureName: string, onConfirm: () => void) {
    try {
      const res = await fetch('/api/credits')
      const credits = await res.json()
      const balance = credits.balance ?? 0

      if (balance < cost) {
        setCreditCheck({
          feature: featureName,
          cost,
          currency: 'credit',
          currentCredits: Math.round(balance),
          remainingCreditsAfterRun: balance,
          requiresConfirmation: true,
          canRun: false,
          reason: 'insufficient_credits',
          message: `Nincs elég kredited. ${cost} kredit szükséges, neked ${Math.round(balance)} van.`,
        })
        return
      }

      pendingActionRef.current = onConfirm
      setCreditCheck({
        feature: featureName,
        cost,
        currency: 'credit',
        currentCredits: Math.round(balance),
        remainingCreditsAfterRun: Math.round(balance - cost),
        requiresConfirmation: true,
        canRun: true,
        message: `Ez a művelet ${cost} kreditbe kerül.`,
      })
    } catch {
      onConfirm()
    }
  }

  async function handleExtractUrl(u: string) {
    setLoading(true); setError(null); setResult(null)
    try {
      const res = await fetch('/api/script-extract', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: u }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error); return }
      setResult(data)
      // Eredmény cache-elése URL szerint — vissza-navigáláskor instant betöltés
      sessionStorage.setItem(CACHE_PREFIX + u, JSON.stringify(data))
      if (data.video_id) {
        sessionStorage.setItem(CACHE_PREFIX + `https://youtube.com/watch?v=${data.video_id}`, JSON.stringify(data))
      }
      sessionStorage.setItem(LAST_URL_KEY, u)
    } catch { setError('Kapcsolati hiba.') }
    finally { setLoading(false) }
  }

  async function handleExtract(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim()) return
    checkCreditsBeforeAction(3, 'Script Extractor', () => handleExtractUrl(url))
  }

  function formatNum(n: number) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
    return n.toString()
  }

  const fullText = result ? `HOOK:\n${result.hook}\n\nKULCSPONTOK:\n${result.key_points.join('\n')}\n\nSTRUKTÚRA:\n${result.structure.map(s => `[${s.timestamp}] ${s.label}: ${s.content}`).join('\n')}` : ''

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary mb-1">Script Extractor</h1>
        <p className="text-text-secondary text-sm">Miért ment ekkorát? Elemezzük a videó struktúráját.</p>
      </div>

      <div className="card mb-6">
        <form onSubmit={handleExtract} className="flex gap-3">
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..." className="input flex-1" disabled={loading} />
          <button type="submit" disabled={loading || !url.trim()} className="btn-primary px-6 whitespace-nowrap">
            {loading ? 'Elemzés...' : 'Elemzés'}
          </button>
        </form>
        <p className="text-text-muted text-xs mt-3 flex items-start gap-1.5">
          <span>ℹ️</span>
          <span>Az elemzés a videó elérhető adatai alapján készül — ha van felirat, abból, ha nincs, cím/leírás/statisztika alapján becsléssel.</span>
        </p>
        {inspirationMode && (
          <div className="mt-3 rounded-lg px-3 py-2 text-xs flex items-start gap-2" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)', color: '#A78BFA' }}>
            <span>💡</span>
            <span>Inspiráció mód: a struktúrát, ritmust és hook-típust elemezzük referenciaként — az új videód saját, eredeti szöveg lesz, nem másolat.</span>
          </div>
        )}
      </div>

      {error && <div className="bg-rose/10 border border-rose/20 rounded-xl px-5 py-4 text-rose text-sm mb-6">{error}</div>}

      {loading && (
        <div className="card">
          <LoadingScreen steps={LOADING_STEPS.scriptExtract} />
        </div>
      )}

      {result && !loading && (
        <div className="space-y-5 animate-slide-up">
          {result.from_paid_result && (
            <div className="rounded-xl border border-emerald/20 bg-emerald/10 px-4 py-3 text-sm text-emerald">
              Mentett eredmény, kredit nélkül megnyitva.
            </div>
          )}

          {/* Video header */}
          <div className="card">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-red-500/20 flex items-center justify-center flex-shrink-0">
                <span className="text-red-400 text-lg">▶</span>
              </div>
              <div className="flex-1">
                <h2 className="font-semibold text-text-primary leading-snug mb-0.5">{result.title}</h2>
                <p className="text-text-muted text-sm">{result.channel}</p>
              </div>
            </div>
            <div className="mt-3 text-xs flex items-center gap-1.5" style={{ color: result.transcript_available ? '#22C55E' : '#F59E0B' }}>
              <span>{result.transcript_available ? '✓' : 'ℹ️'}</span>
              <span>{result.transcript_available ? 'Transcript elérhető — pontos struktúraelemzés készült.' : 'Transcript nem elérhető — az elemzés cím, leírás, statisztika és forrásellenőrzés alapján készült.'}</span>
            </div>
            <div className="flex gap-4 mt-4 pt-4 border-t border-border flex-wrap">
              {[
                { label: 'Megtekintés', value: formatNum(result.stats.view_count), icon: '👁' },
                { label: 'Like', value: formatNum(result.stats.like_count), icon: '👍' },
                { label: 'Komment', value: formatNum(result.stats.comment_count), icon: '💬' },
                { label: 'Becsült hossz', value: result.estimated_duration, icon: '⏱' },
              ].map(stat => (
                <div key={stat.label}>
                  <p className="text-text-muted text-xs">{stat.icon} {stat.label}</p>
                  <p className="text-text-primary font-medium text-sm">{stat.value}</p>
                </div>
              ))}
            </div>
            {/* Akciók */}
            <div className="flex gap-2 mt-4 pt-4 border-t border-border flex-wrap">
              <a href={`https://youtube.com/watch?v=${result.video_id}`} target="_blank" rel="noopener noreferrer"
                className="btn-secondary text-sm">▶ Videó megnyitása</a>
              <CopyButton text={`https://youtube.com/watch?v=${result.video_id}`} label="📋 Link másolása" />
              <CopyButton text={fullText} label="📋 Elemzés másolása" />
              <a href={`/dashboard/viral-score?topic=${encodeURIComponent(result.title)}`}
                className="btn-secondary text-sm">📈 Virális esély</a>
            </div>
          </div>

          {/* Hook */}
          <div className="card border-violet/30">
            <p className="section-label mb-2">🎣 Hook</p>
            <p className="text-text-primary text-sm leading-relaxed">{result.hook}</p>
          </div>

          {/* Struktúra */}
          <div>
            <p className="section-label mb-3">Struktúra</p>
            <div className="space-y-2">
              {result.structure.map((section, i) => (
                <div key={i} className={`border rounded-xl p-4 ${sectionTypeColor[section.type] || 'border-border bg-surface-2'}`}>
                  <div className="flex items-center gap-3 mb-1.5">
                    <span className="text-xs font-mono text-text-muted">{section.timestamp}</span>
                    <span className="text-sm font-medium text-text-primary">{section.label}</span>
                  </div>
                  <p className="text-text-secondary text-sm leading-relaxed">{section.content}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Kulcspontok */}
          <div className="card">
            <p className="section-label mb-3">Kulcspontok</p>
            <ul className="space-y-2">
              {result.key_points.map((point, i) => (
                <li key={i} className="flex items-start gap-3 text-sm text-text-secondary">
                  <span className="text-violet mt-0.5 flex-shrink-0">→</span>{point}
                </li>
              ))}
            </ul>
          </div>

          {/* Siker titka */}
          <div className="card bg-emerald/5 border-emerald/20">
            <p className="section-label mb-2 text-emerald">✨ Miért ment ekkorát</p>
            <p className="text-text-secondary text-sm leading-relaxed">{result.success_factors}</p>
          </div>

          {/* CTA - Saját verzió */}
          <div className="card bg-violet/5 border-violet/30 text-center py-6">
            <p className="text-lg font-semibold text-text-primary mb-1">Készíts saját verziót</p>
            <p className="text-text-muted text-sm mb-4">
              {inspirationMode
                ? 'A struktúra és ritmus inspirálja az új videót — a tartalom saját, fact-checkelt szöveg lesz.'
                : 'Tanulj ebből a videóból és generálj saját videócsomagot — fact-checkelt, saját szöveggel.'}
            </p>
            <a href={`/dashboard/video-package?topic=${encodeURIComponent(result.title)}&source_video_id=${encodeURIComponent(result.video_id)}&source_video_url=${encodeURIComponent(`https://youtube.com/watch?v=${result.video_id}`)}&source_context=${encodeURIComponent(sourceContext || 'script_extractor')}&mode=source_video`}
              className="btn-primary inline-block">
              🚀 Saját verzió készítése →
            </a>
          </div>
        </div>
      )}

      {creditCheck && (
        <CreditConfirmModal
          check={creditCheck}
          onConfirm={() => { const action = pendingActionRef.current; setCreditCheck(null); pendingActionRef.current = null; action?.() }}
          onCancel={() => { setCreditCheck(null); pendingActionRef.current = null }}
          loading={loading}
        />
      )}
    </div>
  )
}
