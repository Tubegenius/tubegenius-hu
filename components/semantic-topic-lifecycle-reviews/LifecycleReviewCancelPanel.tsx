'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AlertTriangle, Ban, ChevronDown, LoaderCircle, RotateCcw, ShieldAlert, X } from 'lucide-react'
import {
  LIFECYCLE_CANCEL_REASON_CODES,
  type LifecycleCancelActionResult,
  type LifecycleCancelReasonCode,
  type LifecycleReviewDetail,
} from '@/lib/semantic-topic/lifecycle-review-types'
import { formatLifecycleCancelReason } from '@/lib/lifecycle-review-detail-presentation'
import { requestLifecycleJson } from '@/lib/lifecycle-review-client'
import {
  buildLifecycleCancelBody,
  buildLifecycleCancelUrl,
  createLifecycleCancelDraft,
  createLifecycleCancelIdempotencyKey,
  isLifecycleRequestCancellable,
  lifecycleCancelSubmitError,
  parseLifecycleCancelResponse,
  validateLifecycleCancel,
  type LifecycleCancelDraft,
  type LifecycleCancelSubmitError,
  type LifecycleCancelValidation,
} from '@/lib/lifecycle-review-cancel-presentation'

interface LifecycleReviewCancelPanelProps {
  request: LifecycleReviewDetail
  onCancelled: (result: LifecycleCancelActionResult) => void
}

function CancelConfirmation({
  request,
  draft,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  request: LifecycleReviewDetail
  draft: LifecycleCancelDraft
  submitting: boolean
  error: LifecycleCancelSubmitError | null
  onClose: () => void
  onConfirm: () => void
}) {
  const initialButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    initialButtonRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !submitting) onClose()
    if (event.key !== 'Tab') return
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])'))
    if (!controls.length) return
    const first = controls[0]
    const last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first && last) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="wv-lifecycle-cancel-overlay" role="presentation">
      <div
        className="wv-lifecycle-cancel-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lifecycle-cancel-confirm-title"
        aria-describedby="lifecycle-cancel-confirm-description"
        onKeyDown={handleKeyDown}
      >
        <header>
          <span aria-hidden="true"><ShieldAlert /></span>
          <div><small>Végleges megerősítés</small><h2 id="lifecycle-cancel-confirm-title">Biztosan visszavonod a kérelmet?</h2></div>
          <button type="button" onClick={onClose} disabled={submitting} aria-label="Visszavonási ablak bezárása"><X /></button>
        </header>
        <p id="lifecycle-cancel-confirm-description">
          Ez lezárja az életciklus-felülvizsgálati kérelmet. A művelet nem változtatja meg közvetlenül a téma életciklus-állapotát.
        </p>
        <dl>
          <div><dt>Téma</dt><dd>{request.topicCanonicalLabel}</dd></div>
          <div><dt>Jelenlegi kérelemstátusz</dt><dd>{request.requestStatus === 'approved' ? 'Jóváhagyott' : 'Döntésre vár'}</dd></div>
          <div className="is-wide"><dt>Visszavonás oka</dt><dd>{draft.cancelReasonCode ? formatLifecycleCancelReason(draft.cancelReasonCode) : '—'}</dd></div>
          <div className="is-wide"><dt>Szakmai indoklás</dt><dd>{draft.cancelRationale.trim()}</dd></div>
        </dl>
        <div className="wv-lifecycle-cancel-impact"><Ban aria-hidden="true" /><span><strong>A kérelem véglegesen lezárul.</strong> Új felülvizsgálathoz később új kérelmet kell létrehozni.</span></div>
        {error ? <div className="wv-lifecycle-cancel-error" role="alert"><AlertTriangle aria-hidden="true" /><span><strong>A visszavonás nem történt meg.</strong>{error.message}</span></div> : null}
        <footer>
          <button ref={initialButtonRef} type="button" className="wv-secondary-action" onClick={onClose} disabled={submitting}>Mégsem, vissza</button>
          <button type="button" className="wv-danger-action" onClick={onConfirm} disabled={submitting}>
            {submitting ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Ban aria-hidden="true" />}
            {submitting ? 'Biztonságos visszavonás…' : error ? 'Visszavonás újrapróbálása' : 'Kérelem visszavonása'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default function LifecycleReviewCancelPanel({ request, onCancelled }: LifecycleReviewCancelPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<LifecycleCancelDraft>(createLifecycleCancelDraft)
  const [validation, setValidation] = useState<LifecycleCancelValidation | null>(null)
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<LifecycleCancelSubmitError | null>(null)
  const attemptKeyRef = useRef<string | null>(null)
  const submittingRef = useRef(false)
  const reviewButtonRef = useRef<HTMLButtonElement>(null)

  if (!isLifecycleRequestCancellable(request.requestStatus)) return null

  function updateDraft(mutator: (current: LifecycleCancelDraft) => LifecycleCancelDraft) {
    attemptKeyRef.current = null
    setValidation(null)
    setSubmitError(null)
    setDraft(mutator)
  }

  function openConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextValidation = validateLifecycleCancel(draft)
    setValidation(nextValidation)
    if (!nextValidation.valid) return
    if (!attemptKeyRef.current) attemptKeyRef.current = createLifecycleCancelIdempotencyKey(request.reviewRequestId)
    setConfirmationOpen(true)
  }

  function closeConfirmation() {
    if (submitting) return
    setConfirmationOpen(false)
    requestAnimationFrame(() => reviewButtonRef.current?.focus())
  }

  async function submitCancellation() {
    if (submittingRef.current) return
    const idempotencyKey = attemptKeyRef.current
    if (!idempotencyKey) return
    const body = buildLifecycleCancelBody(draft, idempotencyKey)
    if (!body) {
      setConfirmationOpen(false)
      setValidation(validateLifecycleCancel(draft))
      return
    }

    submittingRef.current = true
    setSubmitting(true)
    setSubmitError(null)
    try {
      const response = await requestLifecycleJson(buildLifecycleCancelUrl(request.reviewRequestId), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = response.payload
      if (!response.ok) {
        const serverMessage = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : undefined
        setSubmitError(lifecycleCancelSubmitError(response.status, serverMessage))
        return
      }
      const parsed = parseLifecycleCancelResponse(payload)
      if (!parsed || parsed.reviewRequestId !== request.reviewRequestId) {
        setSubmitError({ kind: 'server', message: 'A szerver válasza nem felel meg a visszavonási szerződésnek. Automatikus újrapróbálás nem indult.' })
        return
      }
      setConfirmationOpen(false)
      onCancelled(parsed)
    } catch {
      setSubmitError({ kind: 'network', message: 'A hálózati kapcsolat megszakadt. Automatikus újrapróbálás nem indult; ugyanazzal a beküldési kulccsal kézzel újrapróbálhatod.' })
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <section className="wv-lifecycle-cancel-panel" aria-labelledby="lifecycle-cancel-title">
      <header>
        <span aria-hidden="true"><RotateCcw /></span>
        <div><small>Kérelemkezelés</small><h2 id="lifecycle-cancel-title">Az életciklus-felülvizsgálati kérelem visszavonása</h2><p>Csak akkor használd, ha ezt a konkrét felülvizsgálati folyamatot le kell zárni.</p></div>
        <button type="button" className="wv-lifecycle-cancel-expand" aria-expanded={expanded} aria-controls="lifecycle-cancel-form" onClick={() => setExpanded(value => !value)}>
          {expanded ? 'Panel bezárása' : 'Visszavonás megnyitása'} <ChevronDown aria-hidden="true" />
        </button>
      </header>

      {expanded ? (
        <form id="lifecycle-cancel-form" onSubmit={openConfirmation} noValidate>
          <div className="wv-lifecycle-cancel-fields">
            <label className="wv-lifecycle-decision-field">
              <span>Zárt visszavonási indok</span>
              <select value={draft.cancelReasonCode ?? ''} onChange={event => updateDraft(current => ({ ...current, cancelReasonCode: (event.target.value || null) as LifecycleCancelReasonCode | null }))} aria-invalid={Boolean(validation?.fieldErrors.cancelReasonCode)}>
                <option value="">Válassz indokot</option>
                {LIFECYCLE_CANCEL_REASON_CODES.map(code => <option key={code} value={code}>{formatLifecycleCancelReason(code)}</option>)}
              </select>
              {validation?.fieldErrors.cancelReasonCode ? <small className="wv-field-error">{validation.fieldErrors.cancelReasonCode}</small> : null}
            </label>
            <label className="wv-lifecycle-decision-field">
              <span>Felülvizsgálói indoklás</span>
              <textarea rows={4} maxLength={1000} value={draft.cancelRationale} onChange={event => updateDraft(current => ({ ...current, cancelRationale: event.target.value }))} aria-invalid={Boolean(validation?.fieldErrors.cancelRationale)} placeholder="Rögzítsd röviden, miért kell ezt a kérelmet lezárni." />
              <small className="wv-lifecycle-character-count">{draft.cancelRationale.length} / 1000 karakter</small>
              {validation?.fieldErrors.cancelRationale ? <small className="wv-field-error">{validation.fieldErrors.cancelRationale}</small> : null}
            </label>
          </div>
          <footer><span><ShieldAlert aria-hidden="true" /> Nincs optimista státuszváltás</span><button ref={reviewButtonRef} type="submit" className="wv-danger-outline-action" disabled={submitting}>Visszavonás ellenőrzése</button></footer>
        </form>
      ) : null}

      {confirmationOpen ? <CancelConfirmation request={request} draft={draft} submitting={submitting} error={submitError} onClose={closeConfirmation} onConfirm={() => void submitCancellation()} /> : null}
    </section>
  )
}
