'use client'

import { useCallback, useEffect, useState } from 'react'
import DecisionForm from './DecisionForm'
import ConfirmActionModal from './ConfirmActionModal'
import { availableActionsForStatus } from './statusLogic'
import { asSubjectEntities, asSupportingSpans, type ReviewRequestDetailDTO, type ReviewRequestStatus } from './types'

interface ReviewDetailProps {
  reviewRequestId: string
  onBack: () => void
}

const STATUS_LABELS: Record<ReviewRequestStatus, string> = {
  pending: 'Függőben',
  approved: 'Jóváhagyva',
  rejected: 'Elutasítva',
  expired: 'Lejárt',
  cancelled: 'Visszavonva (cancel)',
  revoked: 'Jóváhagyás visszavonva (revoke)',
  executed: 'Végrehajtva',
}

const STATUS_COLORS: Record<ReviewRequestStatus, string> = {
  pending: '#3B82F6',
  approved: '#22C55E',
  rejected: '#EF4444',
  expired: '#94A3B8',
  cancelled: '#94A3B8',
  revoked: '#F59E0B',
  executed: '#8B5CF6',
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('hu-HU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
  } catch {
    return iso
  }
}

export default function ReviewDetail({ reviewRequestId, onBack }: ReviewDetailProps) {
  const [request, setRequest] = useState<ReviewRequestDetailDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [accessDenied, setAccessDenied] = useState(false)
  const [banner, setBanner] = useState<{ tone: 'success' | 'info'; text: string } | null>(null)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setNotFound(false)
    setAccessDenied(false)
    try {
      const res = await fetch(`/api/admin/semantic-topic-reviews/${reviewRequestId}`, { cache: 'no-store' })
      if (res.status === 403) {
        setAccessDenied(true)
        return
      }
      if (res.status === 404) {
        setNotFound(true)
        return
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof body.error === 'string' ? body.error : 'Nem sikerült betölteni a review requestet.')
        return
      }
      setRequest(body.request as ReviewRequestDetailDTO)
    } catch {
      setError('Hálózati hiba történt a betöltés közben.')
    } finally {
      setLoading(false)
    }
  }, [reviewRequestId])

  useEffect(() => {
    void load()
  }, [load])

  async function handleCancel() {
    setActionLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/admin/semantic-topic-reviews/${reviewRequestId}/cancel`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setActionError(typeof body.error === 'string' ? body.error : 'A visszavonás nem sikerült.')
        return
      }
      setShowCancelConfirm(false)
      setBanner({ tone: 'info', text: 'A kérés visszavonva.' })
      await load()
    } catch {
      setActionError('Hálózati hiba történt.')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleRevoke() {
    setActionLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/admin/semantic-topic-reviews/${reviewRequestId}/revoke`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setActionError(typeof body.error === 'string' ? body.error : 'A jóváhagyás visszavonása nem sikerült.')
        return
      }
      setShowRevokeConfirm(false)
      setBanner({ tone: 'info', text: 'A jóváhagyás visszavonva. Az eredeti approval snapshot megmaradt a naplóban.' })
      await load()
    } catch {
      setActionError('Hálózati hiba történt.')
    } finally {
      setActionLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="card text-center py-16" aria-busy="true" aria-live="polite">
        <div className="inline-block w-8 h-8 border-2 border-t-transparent rounded-full animate-spin motion-reduce:animate-none" style={{ borderColor: '#3B82F6', borderTopColor: 'transparent' }} />
        <p className="text-sm mt-3" style={{ color: '#94A3B8' }}>Review betöltése...</p>
      </div>
    )
  }

  if (accessDenied) {
    return (
      <div className="card text-center py-16">
        <p className="text-3xl mb-3">🔒</p>
        <h2 className="text-lg font-semibold mb-2" style={{ color: '#F8FAFC' }}>Hozzáférés megtagadva</h2>
        <p className="text-sm max-w-md mx-auto mb-4" style={{ color: '#CBD5E1' }}>
          Be vagy jelentkezve, de nem vagy aktív reviewer a Semantic Topic Identity felülvizsgálati workflow-hoz.
        </p>
        <button onClick={onBack} className="btn-secondary">
          ← Vissza
        </button>
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="card text-center py-12">
        <p className="text-3xl mb-3">🔍</p>
        <p className="text-sm mb-4" style={{ color: '#CBD5E1' }}>Ez a review request nem található.</p>
        <button onClick={onBack} className="btn-secondary">
          ← Vissza a listához
        </button>
      </div>
    )
  }

  if (error || !request) {
    return (
      <div className="card text-center py-12">
        <p role="alert" className="text-sm mb-4" style={{ color: '#EF4444' }}>
          {error || 'Ismeretlen hiba történt.'}
        </p>
        <div className="flex gap-3 justify-center">
          <button onClick={() => void load()} className="btn-secondary">
            Újrapróbálás
          </button>
          <button onClick={onBack} className="btn-secondary">
            ← Vissza
          </button>
        </div>
      </div>
    )
  }

  const spans = asSupportingSpans(request.supportingSpans)
  const subjectEntities = asSubjectEntities(request.subjectEntities)
  const decision = request.decision
  const actions = availableActionsForStatus(request.status)

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm" style={{ color: '#94A3B8' }}>
        ← Vissza a listához
      </button>

      {banner && (
        <div role="status" aria-live="polite" className="text-sm px-4 py-3 rounded-lg" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', color: '#93C5FD' }}>
          {banner.text}
        </div>
      )}

      <div className="card">
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold mb-1" style={{ color: '#F8FAFC' }}>
              {request.candidateLabel || '(cím nélküli jelölt)'}
            </h1>
            <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: `${STATUS_COLORS[request.status]}1A`, border: `1px solid ${STATUS_COLORS[request.status]}4D`, color: STATUS_COLORS[request.status] }}>
              {STATUS_LABELS[request.status]}
            </span>
          </div>
          <span className="text-xs" style={{ color: '#64748B' }}>generation {request.generation}</span>
        </div>

        <p className="text-xs mb-4 px-3 py-2 rounded-lg" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#FBBF24' }}>
          ⚠️ A jelölt egy collector cluster kimenete -- <b>ez önmagában nem egy megerősített semantic topic identity</b>, a felülvizsgálat célja pontosan ennek eldöntése.
        </p>

        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4 text-sm">
          <div>
            <dt className="text-xs mb-0.5" style={{ color: '#64748B' }}>Specificity</dt>
            <dd style={{ color: '#F8FAFC' }}>{request.specificity ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs mb-0.5" style={{ color: '#64748B' }}>Content format</dt>
            <dd style={{ color: '#F8FAFC' }}>{request.contentFormat ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs mb-0.5" style={{ color: '#64748B' }}>Model-reported confidence</dt>
            <dd style={{ color: '#F8FAFC' }}>{request.modelReportedConfidence ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs mb-0.5" style={{ color: '#64748B' }}>Kérve</dt>
            <dd style={{ color: '#F8FAFC' }}>{formatDate(request.requestedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs mb-0.5" style={{ color: '#64748B' }}>Lejár</dt>
            <dd style={{ color: '#F8FAFC' }}>{formatDate(request.expiresAt)}</dd>
          </div>
          <div>
            <dt className="text-xs mb-0.5" style={{ color: '#64748B' }}>Nyelv</dt>
            <dd style={{ color: '#F8FAFC' }}>{request.labelLanguage ?? '—'}</dd>
          </div>
        </dl>
        <p className="text-xs mb-4" style={{ color: '#64748B' }}>
          A confidence itt egy <b>model-reported jelzés</b>, nem kalibrált valószínűség -- ne kezeld statisztikai pontosságú számként.
        </p>

        {(request.actionOrEvent || request.location || request.temporalContext || subjectEntities.length > 0) && (
          <div className="mb-4 space-y-1.5 text-sm">
            {request.actionOrEvent && <p style={{ color: '#CBD5E1' }}><span style={{ color: '#64748B' }}>Esemény/cselekvés: </span>{request.actionOrEvent}</p>}
            {request.location && <p style={{ color: '#CBD5E1' }}><span style={{ color: '#64748B' }}>Helyszín: </span>{request.location}</p>}
            {request.temporalContext && <p style={{ color: '#CBD5E1' }}><span style={{ color: '#64748B' }}>Időbeli kontextus: </span>{request.temporalContext}</p>}
            {subjectEntities.length > 0 && (
              <p style={{ color: '#CBD5E1' }}>
                <span style={{ color: '#64748B' }}>Entitások: </span>
                {subjectEntities.join(', ')}
              </p>
            )}
          </div>
        )}

        {spans.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: '#64748B' }}>
              Alátámasztó idézetek
            </p>
            <ul className="space-y-1.5">
              {spans.map((span, i) => (
                <li key={i} className="text-sm px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: '#CBD5E1' }}>
                  <span className="text-xs block mb-0.5" style={{ color: '#64748B' }}>{span.source_field}</span>
                  {/* Sosem dangerouslySetInnerHTML -- reviewer/forrás-szöveg mindig sima szövegként */}
                  {span.quoted_text}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: '#64748B' }}>
            Forrás
          </p>
          <p className="text-sm" style={{ color: '#CBD5E1' }}>
            {request.evidence.title || '(cím nélkül)'} · {request.source.sourceType}
          </p>
          {request.evidence.canonicalUrl && (
            <a href={request.evidence.canonicalUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline break-all" style={{ color: '#3B82F6' }}>
              {request.evidence.canonicalUrl}
            </a>
          )}
          {request.evidence.publishedAt && (
            <p className="text-xs mt-1" style={{ color: '#64748B' }}>Publikálva: {formatDate(request.evidence.publishedAt)}</p>
          )}
        </div>
      </div>

      {actions.canDecide && (
        <DecisionForm
          reviewRequestId={reviewRequestId}
          onApprovedOrRejected={result => {
            setBanner({
              tone: 'success',
              text:
                result.outcome === 'rejected'
                  ? 'Elutasítva -- végleges QUARANTINE döntés létrejött.'
                  : 'Jóváhagyva -- várakozás felügyelt végrehajtásra.',
            })
            void load()
          }}
          onConflict={() => {
            setBanner({ tone: 'info', text: 'A kérés állapota közben megváltozott -- frissítve.' })
            void load()
          }}
        />
      )}

      {actions.canCancel && (
        <div className="card">
          <p className="text-sm mb-3" style={{ color: '#CBD5E1' }}>
            Ha ezt a kérést nem szeretnéd most eldönteni, visszavonhatod (ez <b>nem</b> elutasítás, és nem hoz létre QUARANTINE döntést).
          </p>
          <button onClick={() => setShowCancelConfirm(true)} className="btn-secondary">
            Kérés visszavonása (cancel)
          </button>
        </div>
      )}

      {request.status === 'approved' && (
        <div className="card">
          <p className="text-sm font-semibold mb-1" style={{ color: '#22C55E' }}>
            ✅ Jóváhagyva — várakozás felügyelt végrehajtásra
          </p>
          <p className="text-xs mb-4" style={{ color: '#94A3B8' }}>
            A tényleges topic/tagság csak egy külön, felügyelt végrehajtási lépésben jön létre -- ez a felület nem hajt végre semmit automatikusan.
          </p>
          {decision && <DecisionSummary decision={decision} />}
          {actions.canRevoke && (
            <button onClick={() => setShowRevokeConfirm(true)} className="btn-secondary mt-4">
              Jóváhagyás visszavonása (revoke)
            </button>
          )}
        </div>
      )}

      {(request.status === 'rejected' || request.status === 'expired' || request.status === 'cancelled' || request.status === 'revoked' || request.status === 'executed') && (
        <div className="card">
          <p className="text-sm font-semibold mb-2" style={{ color: STATUS_COLORS[request.status] }}>
            {STATUS_LABELS[request.status]} -- ezen a kérésen már nincs elérhető művelet.
          </p>
          {decision && <DecisionSummary decision={decision} />}
        </div>
      )}

      {actionError && (
        <p role="alert" className="text-sm px-4 py-3 rounded-lg" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#FCA5A5' }}>
          {actionError}
        </p>
      )}

      {showCancelConfirm && (
        <ConfirmActionModal
          titleText="Kérés visszavonása"
          bodyText={'Ez a művelet NEM elutasítás -- nem hoz létre QUARANTINE döntést. A kérés egyszerűen visszavonásra kerül, és a jelölt a jövőben újra felkerülhet a sorba.'}
          confirmLabel="Visszavonom"
          loading={actionLoading}
          onConfirm={() => void handleCancel()}
          onCancel={() => setShowCancelConfirm(false)}
        />
      )}
      {showRevokeConfirm && (
        <ConfirmActionModal
          titleText="Jóváhagyás visszavonása"
          bodyText={'Az eredeti approval snapshot megmarad a naplóban -- ez a művelet csak azt akadályozza meg, hogy a jóváhagyás végrehajtásra kerüljön.'}
          confirmLabel="Visszavonom"
          loading={actionLoading}
          onConfirm={() => void handleRevoke()}
          onCancel={() => setShowRevokeConfirm(false)}
        />
      )}
    </div>
  )
}

function DecisionSummary({ decision }: { decision: NonNullable<ReviewRequestDetailDTO['decision']> }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      {decision.canonicalTopicLabel && (
        <div className="sm:col-span-2">
          <dt className="text-xs mb-0.5" style={{ color: '#64748B' }}>Kanonikus topic-címke</dt>
          <dd style={{ color: '#F8FAFC' }}>{decision.canonicalTopicLabel}</dd>
        </div>
      )}
      {decision.proposedOutcome && (
        <div>
          <dt className="text-xs mb-0.5" style={{ color: '#64748B' }}>Javasolt kimenet</dt>
          <dd style={{ color: '#F8FAFC' }}>{decision.proposedOutcome}</dd>
        </div>
      )}
      {decision.uncertaintyClassification && (
        <div>
          <dt className="text-xs mb-0.5" style={{ color: '#64748B' }}>Bizonytalanság</dt>
          <dd style={{ color: '#F8FAFC' }}>{decision.uncertaintyClassification}</dd>
        </div>
      )}
      {decision.rejectionReason && (
        <div className="sm:col-span-2">
          <dt className="text-xs mb-0.5" style={{ color: '#64748B' }}>Elutasítás oka</dt>
          <dd style={{ color: '#F8FAFC' }}>{decision.rejectionReason}</dd>
        </div>
      )}
      {decision.reviewerRationale && (
        <div className="sm:col-span-2">
          <dt className="text-xs mb-0.5" style={{ color: '#64748B' }}>Reviewer indoklás</dt>
          <dd style={{ color: '#CBD5E1' }}>{decision.reviewerRationale}</dd>
        </div>
      )}
      <div className="sm:col-span-2">
        <dt className="text-xs mb-0.5" style={{ color: '#64748B' }}>Döntés időpontja</dt>
        <dd style={{ color: '#F8FAFC' }}>{formatDate(decision.decidedAt)}</dd>
      </div>
    </dl>
  )
}
