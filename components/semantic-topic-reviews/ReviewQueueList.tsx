'use client'

import { useCallback, useEffect, useState } from 'react'
import { isPastExpiry } from './statusLogic'
import type { ReviewRequestSummaryDTO } from './types'

interface ReviewQueueListProps {
  onOpen: (reviewRequestId: string) => void
}

const PAGE_SIZE = 20

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('hu-HU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
  } catch {
    return iso
  }
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function ReviewListCard({ item, onOpen }: { item: ReviewRequestSummaryDTO; onOpen: (id: string) => void }) {
  const isExpired = isPastExpiry(item.expiresAt)

  return (
    <div className="card-hover" role="button" tabIndex={0} onClick={() => onOpen(item.reviewRequestId)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item.reviewRequestId) } }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            {isExpired && (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', color: '#FBBF24' }}>
                ⏳ Lejárt, várja az automatikus takarítást
              </span>
            )}
            {item.specificity && <span className="text-xs" style={{ color: '#94A3B8' }}>{item.specificity}</span>}
            {item.contentFormat && <span className="text-xs" style={{ color: '#94A3B8' }}>· {item.contentFormat}</span>}
          </div>
          <h3 className="font-medium text-sm leading-snug mb-1.5" style={{ color: '#F8FAFC' }}>
            {item.candidateLabel || '(cím nélküli jelölt)'}
          </h3>
          <p className="text-xs mb-2" style={{ color: '#64748B' }}>
            {item.evidence.title || item.source.sourceType} · {item.source.sourceFamilyKey}
          </p>
          <div className="flex gap-3 flex-wrap text-xs" style={{ color: '#94A3B8' }}>
            <span>AI-becsült signal: {item.modelReportedConfidence ?? '—'}</span>
            <span>Kérve: {formatDate(item.requestedAt)}</span>
            <span>Lejár: {formatDate(item.expiresAt)}</span>
            <span style={{ color: '#64748B' }}>#{shortId(item.reviewRequestId)} · gen {item.generation}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onOpen(item.reviewRequestId) }}
          className="btn-secondary text-xs flex-shrink-0"
        >
          Megnyitás →
        </button>
      </div>
    </div>
  )
}

export default function ReviewQueueList({ onOpen }: ReviewQueueListProps) {
  const [items, setItems] = useState<ReviewRequestSummaryDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accessDenied, setAccessDenied] = useState(false)
  const [hasMore, setHasMore] = useState(false)

  const fetchPage = useCallback(async (after: { id: string; requestedAt: string } | null): Promise<{ items: ReviewRequestSummaryDTO[]; ok: boolean }> => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (after) {
      params.set('after_id', after.id)
      params.set('after_requested_at', after.requestedAt)
    }
    const res = await fetch(`/api/admin/semantic-topic-reviews?${params.toString()}`, { cache: 'no-store' })
    if (res.status === 403) {
      setAccessDenied(true)
      return { items: [], ok: false }
    }
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(typeof body.error === 'string' ? body.error : 'Nem sikerült betölteni a listát.')
      return { items: [], ok: false }
    }
    return { items: (body.requests as ReviewRequestSummaryDTO[]) || [], ok: true }
  }, [])

  const loadFirstPage = useCallback(async () => {
    setLoading(true)
    setError(null)
    setAccessDenied(false)
    try {
      const { items: page, ok } = await fetchPage(null)
      if (!ok) return
      setItems(page)
      setHasMore(page.length === PAGE_SIZE)
    } catch {
      setError('Hálózati hiba történt a lista betöltése közben.')
    } finally {
      setLoading(false)
    }
  }, [fetchPage])

  useEffect(() => {
    void loadFirstPage()
  }, [loadFirstPage])

  async function loadMore() {
    const last = items[items.length - 1]
    if (!last) return
    setLoadingMore(true)
    try {
      const { items: page, ok } = await fetchPage({ id: last.reviewRequestId, requestedAt: last.requestedAt })
      if (!ok) return
      setItems(prev => [...prev, ...page])
      setHasMore(page.length === PAGE_SIZE)
    } catch {
      setError('Hálózati hiba történt a további tételek betöltése közben.')
    } finally {
      setLoadingMore(false)
    }
  }

  if (accessDenied) {
    return (
      <div className="card text-center py-16">
        <p className="text-3xl mb-3">🔒</p>
        <h2 className="text-lg font-semibold mb-2" style={{ color: '#F8FAFC' }}>Hozzáférés megtagadva</h2>
        <p className="text-sm max-w-md mx-auto" style={{ color: '#CBD5E1' }}>
          Be vagy jelentkezve, de nem vagy aktív reviewer a Semantic Topic Identity felülvizsgálati workflow-hoz. Ha úgy gondolod, hogy hozzáféréssel kellene rendelkezned, keresd a csapatot.
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-live="polite">
        {[0, 1, 2].map(i => (
          <div key={i} className="card" style={{ minHeight: 96 }}>
            <div className="h-4 w-1/3 rounded mb-3 motion-safe:animate-pulse" style={{ background: 'rgba(255,255,255,0.06)' }} />
            <div className="h-3 w-2/3 rounded motion-safe:animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="card text-center py-12">
        <p role="alert" className="text-sm mb-4" style={{ color: '#EF4444' }}>{error}</p>
        <button onClick={() => void loadFirstPage()} className="btn-secondary">
          Újrapróbálás
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm" style={{ color: '#94A3B8' }}>{items.length} függőben lévő kérés</p>
        <button onClick={() => void loadFirstPage()} className="btn-ghost text-xs">
          ⟳ Frissítés
        </button>
      </div>

      {items.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-3xl mb-3">🗂️</p>
          <p style={{ color: '#CBD5E1' }}>Jelenleg nincs függőben lévő review kérés.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(item => (
            <ReviewListCard key={item.reviewRequestId} item={item} onOpen={onOpen} />
          ))}
        </div>
      )}

      {hasMore && (
        <div className="text-center mt-4">
          <button onClick={() => void loadMore()} disabled={loadingMore} className="btn-secondary">
            {loadingMore ? 'Betöltés...' : 'További betöltése'}
          </button>
        </div>
      )}
    </div>
  )
}
