'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowDown,
  ArrowRight,
  Clock3,
  Filter,
  LogIn,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import type {
  LifecyclePaginationCursor,
  LifecycleReviewListItem,
  LifecycleStatusFilter,
} from '@/lib/semantic-topic/lifecycle-review-types'
import {
  LIFECYCLE_FROM_STATUS_OPTIONS,
  LIFECYCLE_LIST_PAGE_SIZE,
  LIFECYCLE_STATUS_FILTER_OPTIONS,
  LIFECYCLE_STATUS_PRESENTATION,
  LIFECYCLE_TARGET_STATUS_OPTIONS,
  buildLifecycleReviewListUrl,
  deriveLifecycleCursor,
  filterLifecycleTransitions,
  formatLifecycleDate,
  formatLifecycleStaleReason,
  formatLifecycleState,
  lifecycleListError,
  mergeLifecyclePages,
  parseLifecycleReviewListResponse,
  type LifecycleFromFilter,
  type LifecycleTargetFilter,
} from '@/lib/lifecycle-review-presentation'

type QueueStatus = 'loading' | 'ready' | 'error' | 'unauthenticated' | 'forbidden'

const PRIMARY_STATUS_FILTERS: readonly LifecycleStatusFilter[] = ['actionable', 'requested', 'history']

interface QueueError {
  kind: 'not_found' | 'invalid' | 'server' | 'network'
  message: string
}

export interface LifecycleReviewQueueViewProps {
  items: readonly LifecycleReviewListItem[]
  status: QueueStatus
  statusFilter: LifecycleStatusFilter
  fromFilter: LifecycleFromFilter
  targetFilter: LifecycleTargetFilter
  error: QueueError | null
  hasMore: boolean
  loadingMore: boolean
  onStatusFilterChange: (value: LifecycleStatusFilter) => void
  onFromFilterChange: (value: LifecycleFromFilter) => void
  onTargetFilterChange: (value: LifecycleTargetFilter) => void
  onRetry: () => void
  onLoadMore: () => void
}

function LifecycleReviewSkeleton() {
  return (
    <div className="wv-lifecycle-skeleton" aria-label="Lifecycle kérelmek betöltése" role="status">
      <span className="wv-sr-only">Lifecycle kérelmek betöltése</span>
      {[0, 1, 2].map(index => (
        <div key={index} aria-hidden="true">
          <i />
          <span />
          <span />
          <b />
        </div>
      ))}
    </div>
  )
}

function QueueStatePanel({
  status,
  error,
  hasTransitionFilter,
  onRetry,
}: {
  status: Exclude<QueueStatus, 'loading' | 'ready'> | 'empty'
  error: QueueError | null
  hasTransitionFilter?: boolean
  onRetry: () => void
}) {
  const unauthenticated = status === 'unauthenticated'
  const forbidden = status === 'forbidden'
  const empty = status === 'empty'
  const Icon = unauthenticated ? LogIn : forbidden ? ShieldAlert : empty ? Sparkles : RefreshCw
  const title = unauthenticated
    ? 'A munkamenet véget ért'
    : forbidden
      ? 'Reviewer jogosultság szükséges'
      : empty
        ? hasTransitionFilter
          ? 'Nincs találat ezen a betöltött listán'
          : 'A döntési sor most tiszta'
        : 'A lista nem érhető el'
  const description = unauthenticated
    ? 'A lifecycle lista megnyitásához jelentkezz be újra.'
    : forbidden
      ? 'Az aktív reviewer jogosultságot a szerver ellenőrzi. Kérj hozzáférést a platform gazdájától.'
      : empty
        ? hasTransitionFilter
          ? 'Módosítsd az állapotváltási szűrőket, vagy tölts be további elemeket.'
          : 'Nincs a kiválasztott státuszhoz tartozó lifecycle kérelem. Az új kérelmek itt fognak megjelenni.'
        : error?.message || 'Váratlan hiba történt a lista betöltése közben.'

  return (
    <section className={`wv-lifecycle-state is-${status}`} role={status === 'error' ? 'alert' : 'status'}>
      <span aria-hidden="true"><Icon /></span>
      <small>{empty ? 'Felülvizsgálati sor' : 'Biztonságos hozzáférés'}</small>
      <h2>{title}</h2>
      <p>{description}</p>
      {unauthenticated ? (
        <Link href="/auth/login" className="wv-primary-action">Bejelentkezés <ArrowRight aria-hidden="true" /></Link>
      ) : !empty && !forbidden ? (
        <button type="button" className="wv-secondary-action" onClick={onRetry}><RefreshCw aria-hidden="true" /> Újrapróbálás</button>
      ) : null}
    </section>
  )
}

export function LifecycleReviewQueueView({
  items,
  status,
  statusFilter,
  fromFilter,
  targetFilter,
  error,
  hasMore,
  loadingMore,
  onStatusFilterChange,
  onFromFilterChange,
  onTargetFilterChange,
  onRetry,
  onLoadMore,
}: LifecycleReviewQueueViewProps) {
  const visibleItems = useMemo(
    () => filterLifecycleTransitions(items, fromFilter, targetFilter),
    [fromFilter, items, targetFilter],
  )
  const hasTransitionFilter = fromFilter !== 'all' || targetFilter !== 'all'
  const primaryStatusOptions = LIFECYCLE_STATUS_FILTER_OPTIONS.filter(option => PRIMARY_STATUS_FILTERS.includes(option.value))
  const secondaryStatusOptions = LIFECYCLE_STATUS_FILTER_OPTIONS.filter(option => !PRIMARY_STATUS_FILTERS.includes(option.value))
  const secondaryStatusSelected = secondaryStatusOptions.some(option => option.value === statusFilter)

  return (
    <div className="wv-lifecycle-page">
      <header className="wv-lifecycle-intro">
        <div>
          <span className="wv-eyebrow"><ShieldCheck aria-hidden="true" /> Lifecycle reviewer</span>
          <h1>Változások, amelyek emberi döntést kérnek.</h1>
        </div>
        <aside aria-label="Felület állapota">
          <span aria-hidden="true" />
          <div><small>Biztonságos ellenőrzés</small><strong>Olvasási mód · nincs automatikus művelet</strong></div>
        </aside>
      </header>

      <section className="wv-lifecycle-filter-panel" aria-labelledby="lifecycle-filter-title">
        <header>
          <div>
            <Filter aria-hidden="true" />
            <span><small>Döntési fókusz</small><strong id="lifecycle-filter-title">Fókuszált felülvizsgálati sor</strong></span>
          </div>
          <p>A státusz a teljes szerveroldali listát, az állapotváltás a már betöltött kérelmeket szűri.</p>
        </header>

        <div className="wv-lifecycle-status-tabs" role="group" aria-label="Kérelem státusza">
          {primaryStatusOptions.map(option => (
            <button
              key={option.value}
              type="button"
              aria-pressed={statusFilter === option.value}
              className={statusFilter === option.value ? 'is-active' : undefined}
              onClick={() => onStatusFilterChange(option.value)}
            >
              {option.label}
            </button>
          ))}
          <label className={secondaryStatusSelected ? 'wv-lifecycle-status-more is-active' : 'wv-lifecycle-status-more'}>
            <span>Más státusz</span>
            <select
              aria-label="További kérelemstátuszok"
              value={secondaryStatusSelected ? statusFilter : ''}
              onChange={event => {
                if (event.target.value) onStatusFilterChange(event.target.value as LifecycleStatusFilter)
              }}
            >
              <option value="">Válassz státuszt</option>
              {secondaryStatusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>

        <div className="wv-lifecycle-transition-filters">
          <label>
            <span>Kiinduló állapot</span>
            <select value={fromFilter} onChange={event => onFromFilterChange(event.target.value as LifecycleFromFilter)}>
              <option value="all">Minden kiinduló állapot</option>
              {LIFECYCLE_FROM_STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <ArrowRight aria-hidden="true" />
          <label>
            <span>Célállapot</span>
            <select value={targetFilter} onChange={event => onTargetFilterChange(event.target.value as LifecycleTargetFilter)}>
              <option value="all">Minden célállapot</option>
              {LIFECYCLE_TARGET_STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <output aria-live="polite">
            <small>Betöltve / látható</small>
            <strong>{items.length} / {visibleItems.length}</strong>
          </output>
        </div>
      </section>

      {status === 'loading' ? <LifecycleReviewSkeleton /> : null}
      {status === 'unauthenticated' ? <QueueStatePanel status="unauthenticated" error={error} onRetry={onRetry} /> : null}
      {status === 'forbidden' ? <QueueStatePanel status="forbidden" error={error} onRetry={onRetry} /> : null}
      {status === 'error' ? <QueueStatePanel status="error" error={error} onRetry={onRetry} /> : null}

      {status === 'ready' && visibleItems.length === 0 ? (
        <QueueStatePanel status="empty" error={null} hasTransitionFilter={hasTransitionFilter} onRetry={onRetry} />
      ) : null}

      {status === 'ready' && visibleItems.length > 0 ? (
        <section className="wv-lifecycle-results" aria-labelledby="lifecycle-results-title">
          <header>
            <div><small>Felülvizsgálati sor</small><h2 id="lifecycle-results-title">Lifecycle kérelmek</h2></div>
            <span>{visibleItems.length} látható</span>
          </header>
          <div className="wv-lifecycle-list">
            {visibleItems.map((item, index) => {
              const statusPresentation = LIFECYCLE_STATUS_PRESENTATION[item.requestStatus]
              return (
                <Link
                  key={item.reviewRequestId}
                  href={`/dashboard/semantic-topic-lifecycle-reviews/${item.reviewRequestId}`}
                  className="wv-lifecycle-card"
                  style={{ animationDelay: `${Math.min(index, 5) * 45}ms` }}
                  aria-label={`${item.topicCanonicalLabel} lifecycle kérelmének megnyitása`}
                >
                  <div className="wv-lifecycle-card-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</div>
                  <div className="wv-lifecycle-card-main">
                    <header>
                      <span className="wv-lifecycle-badge" data-tone={statusPresentation.tone}>{statusPresentation.label}</span>
                      <span>Generáció {item.generation}</span>
                    </header>
                    <h3>{item.topicCanonicalLabel}</h3>
                    <p title={item.semanticTopicId}>Téma · {item.semanticTopicId}</p>
                  </div>
                  <div className="wv-lifecycle-transition" aria-label={`${formatLifecycleState(item.fromStatus)} állapotból ${formatLifecycleState(item.targetStatus)} állapotba`}>
                    <span><small>Innen</small><strong>{formatLifecycleState(item.fromStatus)}</strong></span>
                    <ArrowRight aria-hidden="true" />
                    <span><small>Ide</small><strong>{formatLifecycleState(item.targetStatus)}</strong></span>
                  </div>
                  <dl className="wv-lifecycle-card-time">
                    <div><dt><Clock3 aria-hidden="true" /> Kérve</dt><dd>{formatLifecycleDate(item.requestedAt)}</dd></div>
                    <div><dt>Lejárat</dt><dd>{formatLifecycleDate(item.expiresAt)}</dd></div>
                  </dl>
                  {item.staleReasonCode ? (
                    <p className="wv-lifecycle-stale-note">
                      <span>Elavulási jelzés</span>
                      <strong>{formatLifecycleStaleReason(item.staleReasonCode)}</strong>
                      <code aria-label={`Technikai kód: ${item.staleReasonCode}`}>{item.staleReasonCode}</code>
                    </p>
                  ) : null}
                </Link>
              )
            })}
          </div>
          {error ? (
            <div className="wv-lifecycle-inline-error" role="alert">
              <ShieldAlert aria-hidden="true" />
              <span><strong>A további oldal nem töltődött be.</strong><small>{error.message}</small></span>
            </div>
          ) : null}
          {hasMore ? (
            <footer>
              <button type="button" className="wv-secondary-action" onClick={onLoadMore} disabled={loadingMore} aria-busy={loadingMore}>
                {loadingMore ? <RefreshCw className="is-spinning" aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
                {loadingMore ? 'Betöltés…' : 'További kérelmek'}
              </button>
              <span>Keyset folytatás az utolsó kérelemtől</span>
            </footer>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

export default function LifecycleReviewQueue() {
  const [items, setItems] = useState<LifecycleReviewListItem[]>([])
  const [status, setStatus] = useState<QueueStatus>('loading')
  const [statusFilter, setStatusFilter] = useState<LifecycleStatusFilter>('actionable')
  const [fromFilter, setFromFilter] = useState<LifecycleFromFilter>('all')
  const [targetFilter, setTargetFilter] = useState<LifecycleTargetFilter>('all')
  const [nextCursor, setNextCursor] = useState<LifecyclePaginationCursor | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<QueueError | null>(null)
  const [reloadVersion, setReloadVersion] = useState(0)
  const activeStatusFilterRef = useRef<LifecycleStatusFilter>(statusFilter)

  const fetchPage = useCallback(async (
    filter: LifecycleStatusFilter,
    cursor: LifecyclePaginationCursor | null,
    append: boolean,
    signal?: AbortSignal,
  ) => {
    if (append) setLoadingMore(true)
    else {
      setStatus('loading')
      setItems([])
      setNextCursor(null)
    }
    setError(null)

    try {
      const response = await fetch(buildLifecycleReviewListUrl(filter, LIFECYCLE_LIST_PAGE_SIZE, cursor), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      })
      const payload: unknown = await response.json().catch(() => null)
      if (filter !== activeStatusFilterRef.current) return
      if (!response.ok) {
        const serverMessage = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : undefined
        const mapped = lifecycleListError(response.status, serverMessage)
        if (mapped.kind === 'unauthenticated' || mapped.kind === 'forbidden') {
          setStatus(mapped.kind)
          return
        }
        setError(mapped)
        if (!append) setStatus('error')
        return
      }

      const requests = parseLifecycleReviewListResponse(payload)
      if (!requests) {
        setError({ kind: 'server', message: 'A szerver válasza nem felel meg a lifecycle lista szerződésének.' })
        if (!append) setStatus('error')
        return
      }
      setItems(current => append ? mergeLifecyclePages(current, requests) : requests)
      setNextCursor(deriveLifecycleCursor(requests, LIFECYCLE_LIST_PAGE_SIZE))
      setStatus('ready')
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      if (filter !== activeStatusFilterRef.current) return
      setError({ kind: 'network', message: 'A hálózati kapcsolat megszakadt. Automatikus újrapróbálás nem indult.' })
      if (!append) setStatus('error')
    } finally {
      if (append) setLoadingMore(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void fetchPage(statusFilter, null, false, controller.signal)
    return () => controller.abort()
  }, [fetchPage, reloadVersion, statusFilter])

  return (
    <LifecycleReviewQueueView
      items={items}
      status={status}
      statusFilter={statusFilter}
      fromFilter={fromFilter}
      targetFilter={targetFilter}
      error={error}
      hasMore={nextCursor !== null}
      loadingMore={loadingMore}
      onStatusFilterChange={value => {
        activeStatusFilterRef.current = value
        setStatusFilter(value)
      }}
      onFromFilterChange={setFromFilter}
      onTargetFilterChange={setTargetFilter}
      onRetry={() => setReloadVersion(version => version + 1)}
      onLoadMore={() => {
        if (!nextCursor || loadingMore) return
        void fetchPage(statusFilter, nextCursor, true)
      }}
    />
  )
}
