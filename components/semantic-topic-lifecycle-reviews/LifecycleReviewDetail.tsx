'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Database,
  Fingerprint,
  GitCompareArrows,
  History,
  Layers3,
  LogIn,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react'
import type {
  LifecycleEvidenceVector,
  LifecycleReviewDetail,
  LifecycleStalenessSignals,
} from '@/lib/semantic-topic/lifecycle-review-types'
import {
  LIFECYCLE_STATUS_PRESENTATION,
  formatLifecycleDate,
  formatLifecycleStaleReason,
  formatLifecycleState,
} from '@/lib/lifecycle-review-presentation'
import {
  buildLifecycleReviewDetailUrl,
  compactLifecycleDigest,
  formatLifecycleActor,
  formatLifecycleCancelReason,
  formatLifecycleEvent,
  formatLifecycleReasonCode,
  formatLifecycleStatusLabel,
  lifecycleDetailError,
  parseLifecycleReviewDetailResponse,
  type LifecycleDetailError,
} from '@/lib/lifecycle-review-detail-presentation'

type DetailStatus = 'loading' | 'ready' | 'error' | 'unauthenticated' | 'forbidden' | 'not_found'

interface LifecycleReviewDetailViewProps {
  request: LifecycleReviewDetail | null
  status: DetailStatus
  error: LifecycleDetailError | { kind: 'network'; message: string } | null
  onRetry: () => void
}

const STALENESS_SIGNAL_LABELS: Record<keyof LifecycleStalenessSignals, string> = {
  topicStatusChanged: 'Témaállapot',
  topicVersionChanged: 'Témaverzió',
  evidenceVectorChanged: 'Bizonyítéki összkép',
  mechanicalRequirementsLost: 'Mechanikai feltételek',
}

function booleanLabel(value: boolean | null): string {
  if (value === null) return 'Nincs rögzítve'
  return value ? 'Megerősítve' : 'Nem erősítették meg'
}

function DetailSkeleton() {
  return (
    <div className="wv-lifecycle-detail-skeleton" role="status" aria-label="Lifecycle kérelem betöltése">
      <span className="wv-sr-only">Lifecycle kérelem betöltése</span>
      <div aria-hidden="true"><i /><strong /><span /></div>
      <div aria-hidden="true"><i /><strong /><span /><span /></div>
      <div aria-hidden="true"><i /><strong /><span /><span /></div>
    </div>
  )
}

function DetailStatePanel({ status, error, onRetry }: Pick<LifecycleReviewDetailViewProps, 'status' | 'error' | 'onRetry'>) {
  const unauthenticated = status === 'unauthenticated'
  const forbidden = status === 'forbidden'
  const notFound = status === 'not_found'
  const Icon = unauthenticated ? LogIn : forbidden ? ShieldAlert : notFound ? CircleDashed : RefreshCw
  const title = unauthenticated
    ? 'A munkamenet véget ért'
    : forbidden
      ? 'Felülvizsgálói jogosultság szükséges'
      : notFound
        ? 'A kérelem nem található'
        : 'A részletek nem érhetők el'

  return (
    <section className={`wv-lifecycle-detail-state is-${status}`} role={status === 'error' ? 'alert' : 'status'}>
      <span aria-hidden="true"><Icon /></span>
      <small>Biztonságos hozzáférés</small>
      <h1>{title}</h1>
      <p>{error?.message || 'Váratlan hiba történt az életciklus-kérelem betöltése közben.'}</p>
      {unauthenticated ? (
        <Link href="/auth/login" className="wv-primary-action">Bejelentkezés <ArrowRight aria-hidden="true" /></Link>
      ) : !forbidden && !notFound ? (
        <button type="button" className="wv-secondary-action" onClick={onRetry}><RefreshCw aria-hidden="true" /> Újrapróbálás</button>
      ) : null}
      <Link href="/dashboard/semantic-topic-lifecycle-reviews" className="wv-lifecycle-back-link"><ArrowLeft aria-hidden="true" /> Vissza a kérelmekhez</Link>
    </section>
  )
}

function EvidencePanel({
  title,
  label,
  vector,
  digest,
  meta,
  mechanicalRequirements,
}: {
  title: string
  label: string
  vector: LifecycleEvidenceVector
  digest: string
  meta: string
  mechanicalRequirements?: boolean
}) {
  const metrics = [
    ['Aktív tagság', vector.activeMembershipCount],
    ['Elfogadható tagság', vector.eligibleMembershipCount],
    ['Különálló forrás', vector.eligibleDistinctSourceIdentityCount],
    ['Ismeretlen forrás', vector.unknownSourceCount],
    ['Szindikáció miatt kizárt', vector.syndicationExcludedCount],
    ['Manuálisan megerősített', vector.manualReviewConfirmedSourceCount],
  ] as const
  const integrity: ReadonlyArray<readonly [string, boolean]> = [
    ['Bizonyíték-azonosság teljes', vector.evidenceIdentityComplete],
    ['Forrásazonosság ismert', vector.sourceIdentityKnown],
    ['Indoklási bontás teljes', vector.assignmentReasonBreakdownComplete],
    ...(mechanicalRequirements === undefined ? [] : [['Mechanikai feltételek teljesülnek', mechanicalRequirements] as const]),
  ]

  return (
    <article className="wv-lifecycle-evidence-panel">
      <header>
        <span aria-hidden="true"><Database /></span>
        <div><small>{label}</small><h2>{title}</h2><p>{meta}</p></div>
      </header>
      <div className="wv-lifecycle-evidence-metrics">
        {metrics.map(([metric, value]) => <div key={metric}><span>{metric}</span><strong>{value}</strong></div>)}
      </div>
      <div className="wv-lifecycle-integrity-list">
        {integrity.map(([item, passed]) => (
          <div key={item} data-passed={passed}>
            {passed ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
            <span>{item}</span>
          </div>
        ))}
      </div>
      <dl className="wv-lifecycle-evidence-meta">
        <div><dt>Formula</dt><dd>{vector.formulaVersion}</dd></div>
        <div><dt>Integritás</dt><dd>{vector.inputIntegrityStatus}</dd></div>
        <div><dt>Konfidencia</dt><dd>{vector.confidenceDiagnostics.min ?? '—'}–{vector.confidenceDiagnostics.max ?? '—'} · {vector.confidenceDiagnostics.count} jel</dd></div>
        <div><dt>Vektorazonosító</dt><dd title={digest}><code>{compactLifecycleDigest(digest)}</code></dd></div>
      </dl>
    </article>
  )
}

function ExistingOutcome({ request }: { request: LifecycleReviewDetail }) {
  if (!request.decision && !request.cancellation && !request.execution) return null
  return (
    <section className="wv-lifecycle-outcomes" aria-labelledby="lifecycle-outcomes-title">
      <header><small>Rögzített eredmény</small><h2 id="lifecycle-outcomes-title">A kérelem lezárt adatai</h2></header>
      <div>
        {request.decision ? (
          <article>
            <span aria-hidden="true"><ShieldCheck /></span>
            <div>
              <small>{request.requestStatus === 'rejected' ? 'Elutasítási döntés' : 'Felülvizsgálói döntés'}</small>
              <h3>{formatLifecycleReasonCode(request.decision.reasonCode)}</h3>
              <p>{request.decision.reviewerRationale}</p>
              <dl>
                <div><dt>Azonos szemantikai identitás</dt><dd>{booleanLabel(request.decision.sameSemanticIdentityConfirmed)}</dd></div>
                <div><dt>Nincs lényegi identitáskonfliktus</dt><dd>{booleanLabel(request.decision.noMaterialIdentityConflict)}</dd></div>
                <div><dt>Definíció és scope illeszkedik</dt><dd>{booleanLabel(request.decision.canonicalDefinitionScopeFitConfirmed)}</dd></div>
                <div><dt>Provenance kapcsolat ellenőrizve</dt><dd>{booleanLabel(request.decision.provenanceRelationshipReviewed)}</dd></div>
              </dl>
              <footer>{formatLifecycleDate(request.decision.decidedAt)} · {request.decision.reviewerRoleSnapshot}{request.decision.decidedByCurrentReviewer ? ' · Te rögzítetted' : ''}</footer>
            </div>
          </article>
        ) : null}
        {request.cancellation ? (
          <article>
            <span aria-hidden="true"><X /></span>
            <div>
              <small>Visszavonás</small>
              <h3>{formatLifecycleCancelReason(request.cancellation.cancelReasonCode)}</h3>
              <p>{request.cancellation.cancelRationale}</p>
              <footer>{formatLifecycleDate(request.cancellation.cancelledAt)}{request.cancellation.cancelledByCurrentReviewer ? ' · Te rögzítetted' : ''}</footer>
            </div>
          </article>
        ) : null}
        {request.execution ? (
          <article>
            <span aria-hidden="true"><Check /></span>
            <div><small>Végrehajtás</small><h3>Az életciklus-állapotváltás végrehajtva</h3><footer>{formatLifecycleDate(request.execution.executedAt)}</footer></div>
          </article>
        ) : null}
      </div>
    </section>
  )
}

export function LifecycleReviewDetailView({ request, status, error, onRetry }: LifecycleReviewDetailViewProps) {
  if (status === 'loading') return <DetailSkeleton />
  if (status !== 'ready' || !request) return <DetailStatePanel status={status} error={error} onRetry={onRetry} />

  const statusPresentation = LIFECYCLE_STATUS_PRESENTATION[request.requestStatus]
  const signals = Object.entries(request.stalenessSignals) as [keyof LifecycleStalenessSignals, boolean][]

  return (
    <div className="wv-lifecycle-detail-page">
      <Link href="/dashboard/semantic-topic-lifecycle-reviews" className="wv-lifecycle-back-link"><ArrowLeft aria-hidden="true" /> Vissza a kérelmekhez</Link>

      <header className="wv-lifecycle-detail-hero">
        <div>
          <span className="wv-lifecycle-badge" data-tone={statusPresentation.tone}>{statusPresentation.label}</span>
          <small>Generáció {request.generation} · Szabályzat v{request.reviewPolicyVersion}</small>
          <h1>{request.topicCanonicalLabel}</h1>
          <p title={request.semanticTopicId}>Téma · {request.semanticTopicId}</p>
        </div>
        <aside aria-label={`${formatLifecycleState(request.fromStatus)} állapotból ${formatLifecycleState(request.targetStatus)} állapotba`}>
          <span><small>Kiinduló állapot</small><strong>{formatLifecycleState(request.fromStatus)}</strong></span>
          <ArrowRight aria-hidden="true" />
          <span><small>Célállapot</small><strong>{formatLifecycleState(request.targetStatus)}</strong></span>
        </aside>
      </header>

      {request.isPotentiallyStale ? (
        <section className="wv-lifecycle-stale-alert" role="alert">
          <span aria-hidden="true"><AlertTriangle /></span>
          <div>
            <small>Frissességi figyelmeztetés</small>
            <h2>A rögzített és a jelenlegi állapot eltérhet.</h2>
            <p>Ez diagnosztikai jelzés, nem végleges életciklus-döntés, és önmagában nem indít műveletet.</p>
          </div>
          <strong>{request.staleReasonCode ? formatLifecycleStaleReason(request.staleReasonCode) : 'Új ellenőrzés szükséges'}</strong>
        </section>
      ) : null}

      <section className="wv-lifecycle-detail-facts" aria-label="Kérelem összefoglaló">
        <div><Clock3 aria-hidden="true" /><span><small>Kérelem ideje</small><strong>{formatLifecycleDate(request.requestedAt)}</strong></span></div>
        <div><History aria-hidden="true" /><span><small>Lejárat</small><strong>{formatLifecycleDate(request.expiresAt)}</strong></span></div>
        <div><Layers3 aria-hidden="true" /><span><small>Várt státuszverzió</small><strong>v{request.snapshot.expectedStatusVersion}</strong></span></div>
        <div><Fingerprint aria-hidden="true" /><span><small>Snapshot ideje</small><strong>{formatLifecycleDate(request.snapshot.capturedAt)}</strong></span></div>
      </section>

      <section className="wv-lifecycle-compare" aria-labelledby="lifecycle-compare-title">
        <header>
          <div><GitCompareArrows aria-hidden="true" /><span><small>Bizonyítéki összevetés</small><h2 id="lifecycle-compare-title">Akkor és most</h2></span></div>
          <p>A snapshot változatlan döntési alap; az élő nézet csak a jelenlegi helyzetet mutatja.</p>
        </header>
        <div>
          <EvidencePanel
            label="Rögzített pillanatkép"
            title="A kérelem létrehozásakor"
            vector={request.snapshot.evidenceVector}
            digest={request.snapshot.digest}
            meta={`${formatLifecycleState(request.snapshot.fromLifecycleStatus)} · ${formatLifecycleDate(request.snapshot.capturedAt)}`}
          />
          <EvidencePanel
            label="Jelenlegi állapot"
            title="Élő diagnosztikai nézet"
            vector={request.live.evidenceVector}
            digest={request.live.vectorDigest}
            meta={`${formatLifecycleStatusLabel(request.live.lifecycleStatus)} · státuszverzió ${request.live.statusVersion}`}
            mechanicalRequirements={request.live.mechanicalRequirementsCurrentlyMet}
          />
        </div>
      </section>

      <section className="wv-lifecycle-staleness-grid" aria-labelledby="lifecycle-signals-title">
        <header><small>Eltérésfigyelő</small><h2 id="lifecycle-signals-title">Frissességi jelek</h2></header>
        <div>
          {signals.map(([signal, active]) => (
            <article key={signal} data-active={active}>
              {active ? <AlertTriangle aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
              <span><small>{active ? 'Eltérés észlelve' : 'Nincs eltérés'}</small><strong>{STALENESS_SIGNAL_LABELS[signal]}</strong></span>
            </article>
          ))}
        </div>
      </section>

      <ExistingOutcome request={request} />

      <section className="wv-lifecycle-timeline" aria-labelledby="lifecycle-timeline-title">
        <header><small>Audit-idővonal</small><h2 id="lifecycle-timeline-title">A kérelem története</h2></header>
        {request.transitionHistory.length ? (
          <ol>
            {request.transitionHistory.map((entry, index) => (
              <li key={`${entry.eventType}-${entry.createdAt}-${index}`} data-event={entry.eventType}>
                <span aria-hidden="true" />
                <div><small>{formatLifecycleDate(entry.createdAt)}</small><strong>{formatLifecycleEvent(entry.eventType)}</strong><p>{formatLifecycleActor(entry.actorKind)}</p></div>
              </li>
            ))}
          </ol>
        ) : <p className="wv-lifecycle-timeline-empty">Ehhez a kérelemhez még nincs megjeleníthető audit-esemény.</p>}
      </section>
    </div>
  )
}

export default function LifecycleReviewDetail({ reviewRequestId }: { reviewRequestId: string }) {
  const [request, setRequest] = useState<LifecycleReviewDetail | null>(null)
  const [status, setStatus] = useState<DetailStatus>('loading')
  const [error, setError] = useState<LifecycleReviewDetailViewProps['error']>(null)
  const [reloadVersion, setReloadVersion] = useState(0)

  const load = useCallback(async (signal: AbortSignal) => {
    setStatus('loading')
    setRequest(null)
    setError(null)
    try {
      const response = await fetch(buildLifecycleReviewDetailUrl(reviewRequestId), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const serverMessage = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : undefined
        const mapped = lifecycleDetailError(response.status, serverMessage)
        setError(mapped)
        setStatus(mapped.kind === 'not_found' ? 'not_found' : mapped.kind === 'unauthenticated' || mapped.kind === 'forbidden' ? mapped.kind : 'error')
        return
      }
      const parsed = parseLifecycleReviewDetailResponse(payload)
      if (!parsed) {
        setError({ kind: 'server', message: 'A szerver válasza nem felel meg az életciklus-részlet szerződésének.' })
        setStatus('error')
        return
      }
      setRequest(parsed)
      setStatus('ready')
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError({ kind: 'network', message: 'A hálózati kapcsolat megszakadt. Automatikus újrapróbálás nem indult.' })
      setStatus('error')
    }
  }, [reviewRequestId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, reloadVersion])

  return <LifecycleReviewDetailView request={request} status={status} error={error} onRetry={() => setReloadVersion(value => value + 1)} />
}
