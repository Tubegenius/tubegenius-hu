'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import CreditConfirmModal from '@/components/CreditConfirmModal'
import LoadingScreen, { LOADING_STEPS } from '@/components/ui/LoadingScreen'
import type { UsageCheckResult } from '@/lib/usage-protection'

type TranscriptSegment = {
  start: number
  end: number
  text: string
}

type TranscriptResult = {
  title: string
  file_name: string
  file_size: number
  language: string
  duration_seconds: number | null
  text: string
  segments: TranscriptSegment[]
  timed_exports_available?: boolean
  word_count: number
  exports: {
    txt: string
    srt: string
    vtt: string
  }
  from_paid_result?: boolean
  paid_result_id?: string | null
  _credits_remaining?: number
}

const COST = 3
const ACCEPTED_FILES = 'audio/*,video/*,.mp3,.wav,.m4a,.webm,.mp4,.mov,.aac,.ogg'

function formatDuration(seconds: number | null | undefined) {
  if (!seconds || !Number.isFinite(seconds)) return 'ismeretlen'
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const minutes = Math.floor(safe / 60)
  const rest = Math.floor(safe % 60)
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function downloadText(filename: string, content: string, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function safeSlug(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'transcript'
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
      }}
      className="btn-secondary text-sm"
    >
      <i className={`ti ${copied ? 'ti-check' : 'ti-copy'} mr-1.5`} />
      {copied ? 'Másolva' : label}
    </button>
  )
}

export default function TranscriptPage() {
  const searchParams = useSearchParams()
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [language, setLanguage] = useState('hu')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TranscriptResult | null>(null)
  const [creditCheck, setCreditCheck] = useState<UsageCheckResult | null>(null)
  const pendingActionRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const paidResultId = searchParams.get('paidResultId')
    if (!paidResultId) return

    setLoading(true)
    fetch(`/api/transcript?paidResultId=${paidResultId}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          setError(data.error)
          return
        }
        setResult(data)
        setTitle(data.title || '')
      })
      .catch(() => setError('Nem sikerült betölteni a mentett transcriptet.'))
      .finally(() => setLoading(false))
  }, [searchParams])

  async function checkCreditsBeforeAction(onConfirm: () => void) {
    try {
      const res = await fetch('/api/credits')
      const credits = await res.json()
      const balance = credits.balance ?? 0

      if (balance < COST) {
        setCreditCheck({
          feature: 'Auto Transcript',
          cost: COST,
          currency: 'credit',
          currentCredits: Math.round(balance),
          remainingCreditsAfterRun: balance,
          requiresConfirmation: true,
          canRun: false,
          reason: 'insufficient_credits',
          message: `Nincs elég kredited. ${COST} kredit szükséges, neked ${Math.round(balance)} van.`,
        })
        return
      }

      pendingActionRef.current = onConfirm
      setCreditCheck({
        feature: 'Auto Transcript',
        cost: COST,
        currency: 'credit',
        currentCredits: Math.round(balance),
        remainingCreditsAfterRun: Math.round(balance - COST),
        requiresConfirmation: true,
        canRun: true,
        message: `Ez a művelet ${COST} kreditbe kerül.`,
      })
    } catch {
      onConfirm()
    }
  }

  async function runTranscript() {
    if (!file) return
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const body = new FormData()
      body.append('file', file)
      body.append('language', language)
      if (title.trim()) body.append('title', title.trim())

      const res = await fetch('/api/transcript', { method: 'POST', body })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Nem sikerült transcriptet készíteni.')
        return
      }
      setResult(data)
      if (!title.trim()) setTitle(data.title || file.name)
    } catch {
      setError('Kapcsolati hiba transcript készítés közben.')
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) {
      setError('Válassz ki egy hang- vagy videófájlt.')
      return
    }
    checkCreditsBeforeAction(runTranscript)
  }

  const baseName = safeSlug(result?.title || result?.file_name || 'transcript')
  const topicForNextStep = result?.title || result?.text.slice(0, 120) || ''

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.25)' }}>
            <i className="ti ti-microphone text-lg" style={{ color: '#22D3EE' }} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Auto Transcript</h1>
            <p className="text-sm text-text-secondary">Hangból szöveg, időkóddal, exporttal és következő gyártási lépéssel.</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
        <div className="space-y-5">
          <div className="card">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2 block">Fájl</label>
                <label className="block rounded-xl border border-dashed border-border bg-surface-2 p-5 cursor-pointer hover:border-cyan/40 transition-all">
                  <input
                    type="file"
                    accept={ACCEPTED_FILES}
                    className="hidden"
                    onChange={e => {
                      const selected = e.target.files?.[0] || null
                      setFile(selected)
                      if (selected && !title.trim()) setTitle(selected.name.replace(/\.[^.]+$/, ''))
                    }}
                    disabled={loading}
                  />
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'rgba(6,182,212,0.12)' }}>
                      <i className="ti ti-upload" style={{ color: '#22D3EE' }} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">{file ? file.name : 'Hang vagy videó feltöltése'}</p>
                      <p className="text-xs text-text-muted">{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : 'MP3, WAV, M4A, WEBM, MP4, MOV'}</p>
                    </div>
                  </div>
                </label>
              </div>

              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2 block">Cím</label>
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="pl. Mai TikTok narráció"
                  className="input w-full"
                  disabled={loading}
                  maxLength={200}
                />
              </div>

              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2 block">Nyelv</label>
                <select value={language} onChange={e => setLanguage(e.target.value)} className="input w-full" disabled={loading}>
                  <option value="hu">Magyar</option>
                  <option value="en">Angol</option>
                  <option value="auto">Automatikus</option>
                </select>
              </div>

              <button type="submit" disabled={loading || !file} className="btn-primary w-full">
                {loading ? 'Transcript készül...' : `Transcript készítése (${COST} kredit)`}
              </button>
            </form>
            <p className="text-xs text-text-muted leading-relaxed mt-4">
              A feltöltött fájl külső beszédfelismeréssel készül. A mentett eredményt később kredit nélkül nyithatod meg.
            </p>
          </div>

          {result && (
            <div className="card">
              <p className="section-label mb-3">Következő lépés</p>
              <div className="space-y-2">
                <Link href={`/dashboard/viral-score?topic=${encodeURIComponent(topicForNextStep)}`} className="btn-secondary w-full justify-center">
                  <i className="ti ti-chart-bar mr-1.5" />
                  Virális esély
                </Link>
                <Link
                  href={`/dashboard/video-package?topic=${encodeURIComponent(topicForNextStep)}&source_context=${encodeURIComponent('auto_transcript')}&mode=${encodeURIComponent('transcript')}`}
                  className="btn-primary w-full justify-center"
                >
                  <i className="ti ti-package mr-1.5" />
                  Videócsomag készítése
                </Link>
              </div>
            </div>
          )}
        </div>

        <div>
          {error && (
            <div className="bg-rose/10 border border-rose/20 rounded-xl px-5 py-4 text-rose text-sm mb-5">{error}</div>
          )}

          {loading && (
            <div className="card">
              <LoadingScreen steps={LOADING_STEPS.transcript} message="A hanganyag hosszától és tisztaságától függően ez eltarthat egy rövid ideig." />
            </div>
          )}

          {!loading && !result && (
            <div className="card min-h-[420px] flex items-center justify-center text-center">
              <div>
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: 'rgba(6,182,212,0.10)' }}>
                  <i className="ti ti-wave-sine text-2xl" style={{ color: '#22D3EE' }} />
                </div>
                <p className="text-lg font-semibold text-text-primary mb-1">Készíts leiratot a saját anyagodból</p>
                <p className="text-sm text-text-muted max-w-md">A transcript után azonnal kapsz másolható szöveget, feliratfájlt és gyártási továbblépést.</p>
              </div>
            </div>
          )}

          {result && !loading && (
            <div className="space-y-5 animate-slide-up">
              {result.from_paid_result && (
                <div className="rounded-xl border border-emerald/20 bg-emerald/10 px-4 py-3 text-sm text-emerald">
                  Mentett transcript, kredit nélkül megnyitva.
                </div>
              )}

              <div className="card">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="section-label mb-2">Eredmény</p>
                    <h2 className="text-xl font-semibold text-text-primary truncate">{result.title}</h2>
                    <p className="text-sm text-text-muted mt-1">{result.file_name}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-2xl font-bold text-text-primary">{result.word_count}</p>
                    <p className="text-xs text-text-muted">szó</p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3 mt-5">
                  <div className="rounded-xl p-3 bg-surface-2 border border-border">
                    <p className="text-xs text-text-muted">Hossz</p>
                    <p className="text-sm font-semibold text-text-primary">{formatDuration(result.duration_seconds)}</p>
                  </div>
                  <div className="rounded-xl p-3 bg-surface-2 border border-border">
                    <p className="text-xs text-text-muted">Nyelv</p>
                    <p className="text-sm font-semibold text-text-primary uppercase">{result.language}</p>
                  </div>
                  <div className="rounded-xl p-3 bg-surface-2 border border-border">
                    <p className="text-xs text-text-muted">Szegmens</p>
                    <p className="text-sm font-semibold text-text-primary">{result.segments.length}</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 mt-5 pt-5 border-t border-border">
                  <CopyButton text={result.text} label="Szöveg másolása" />
                  <button type="button" onClick={() => downloadText(`${baseName}.txt`, result.exports.txt)} className="btn-secondary text-sm">
                    <i className="ti ti-download mr-1.5" />
                    TXT
                  </button>
                  <button type="button" onClick={() => downloadText(`${baseName}.srt`, result.exports.srt)} disabled={!result.exports.srt} className="btn-secondary text-sm disabled:opacity-40 disabled:cursor-not-allowed" title={!result.exports.srt ? 'Nem érkezett megbízható időbélyeg.' : undefined}>
                    <i className="ti ti-download mr-1.5" />
                    SRT
                  </button>
                  <button type="button" onClick={() => downloadText(`${baseName}.vtt`, result.exports.vtt, 'text/vtt;charset=utf-8')} disabled={!result.exports.vtt} className="btn-secondary text-sm disabled:opacity-40 disabled:cursor-not-allowed" title={!result.exports.vtt ? 'Nem érkezett megbízható időbélyeg.' : undefined}>
                    <i className="ti ti-download mr-1.5" />
                    VTT
                  </button>
                </div>
              </div>

              <div className="card">
                <p className="section-label mb-3">Teljes szöveg</p>
                <div className="rounded-xl bg-surface-2 border border-border p-4 max-h-[360px] overflow-y-auto">
                  <p className="text-sm leading-relaxed text-text-secondary whitespace-pre-wrap">{result.text}</p>
                </div>
              </div>

              {result.segments.length > 0 && (
                <div className="card">
                  <p className="section-label mb-3">Időkódos leirat</p>
                  <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                    {result.segments.map((segment, index) => (
                      <div key={`${segment.start}-${index}`} className="rounded-xl border border-border bg-surface-2 p-3">
                        <div className="text-xs font-mono text-text-muted mb-1">
                          {formatTime(segment.start)} - {formatTime(segment.end)}
                        </div>
                        <p className="text-sm text-text-secondary leading-relaxed">{segment.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {creditCheck && (
        <CreditConfirmModal
          check={creditCheck}
          onConfirm={() => {
            const action = pendingActionRef.current
            setCreditCheck(null)
            pendingActionRef.current = null
            action?.()
          }}
          onCancel={() => {
            setCreditCheck(null)
            pendingActionRef.current = null
          }}
          loading={loading}
        />
      )}
    </div>
  )
}
