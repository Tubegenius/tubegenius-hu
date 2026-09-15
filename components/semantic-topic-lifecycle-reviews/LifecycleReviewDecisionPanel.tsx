'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  LoaderCircle,
  Scale,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react'
import type {
  LifecycleDecisionActionResult,
  LifecycleReasonCode,
  LifecycleReviewDetail,
} from '@/lib/semantic-topic/lifecycle-review-types'
import { LIFECYCLE_STATUS_PRESENTATION, formatLifecycleState } from '@/lib/lifecycle-review-presentation'
import { formatLifecycleReasonCode } from '@/lib/lifecycle-review-detail-presentation'
import {
  LIFECYCLE_CHECKLIST,
  buildLifecycleDecisionBody,
  buildLifecycleDecisionUrl,
  createLifecycleDecisionDraft,
  createLifecycleDecisionIdempotencyKey,
  lifecycleDecisionReasonCodes,
  lifecycleDecisionSubmitError,
  parseLifecycleDecisionResponse,
  validateLifecycleDecision,
  type LifecycleChecklistKey,
  type LifecycleDecisionDraft,
  type LifecycleDecisionOutcome,
  type LifecycleDecisionSubmitError,
  type LifecycleDecisionValidation,
} from '@/lib/lifecycle-review-decision-presentation'

interface LifecycleReviewDecisionPanelProps {
  request: LifecycleReviewDetail
  onRefresh: () => void
}

function checklistValueLabel(value: boolean | null): string {
  if (value === null) return 'Nem vizsgált'
  return value ? 'Megerősítve' : 'Nem teljesül'
}

function resultStatusLabel(value: string): string {
  if (value in LIFECYCLE_STATUS_PRESENTATION) {
    return LIFECYCLE_STATUS_PRESENTATION[value as keyof typeof LIFECYCLE_STATUS_PRESENTATION].label
  }
  return value.replaceAll('_', ' ')
}

function DecisionConfirmation({
  request,
  draft,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  request: LifecycleReviewDetail
  draft: LifecycleDecisionDraft
  submitting: boolean
  error: LifecycleDecisionSubmitError | null
  onClose: () => void
  onConfirm: () => void
}) {
  const initialButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    initialButtonRef.current?.focus()
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
    <div className="wv-lifecycle-decision-overlay" role="presentation">
      <div
        className="wv-lifecycle-decision-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lifecycle-decision-confirm-title"
        aria-describedby="lifecycle-decision-confirm-description"
        onKeyDown={handleKeyDown}
      >
        <header>
          <span aria-hidden="true">{draft.outcome === 'approved' ? <ShieldCheck /> : <XCircle />}</span>
          <div>
            <small>Végleges megerősítés</small>
            <h2 id="lifecycle-decision-confirm-title">
              {draft.outcome === 'approved' ? 'Jóváhagyod' : 'Elutasítod'} ezt a kérelmet?
            </h2>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} aria-label="Megerősítő ablak bezárása"><X /></button>
        </header>

        <p id="lifecycle-decision-confirm-description">
          A beküldés felülvizsgálói döntést rögzít. Nem indít automatikusan életciklus-végrehajtást.
        </p>

        {request.isPotentiallyStale ? (
          <div className="wv-lifecycle-decision-stale"><AlertTriangle aria-hidden="true" /><span><strong>Az élő állapot eltérhet.</strong> A döntés előtt vesd össze a snapshotot a jelenlegi jelekkel.</span></div>
        ) : null}

        <dl>
          <div><dt>Téma</dt><dd>{request.topicCanonicalLabel}</dd></div>
          <div><dt>Állapotváltás</dt><dd>{formatLifecycleState(request.fromStatus)} <ArrowRight aria-hidden="true" /> {formatLifecycleState(request.targetStatus)}</dd></div>
          <div><dt>Döntés</dt><dd>{draft.outcome === 'approved' ? 'Jóváhagyás' : 'Elutasítás'}</dd></div>
          <div><dt>Zárt indok</dt><dd>{draft.reasonCode ? formatLifecycleReasonCode(draft.reasonCode) : '—'}</dd></div>
          <div className="is-wide"><dt>Szakmai indoklás</dt><dd>{draft.reviewerRationale.trim()}</dd></div>
        </dl>

        <div className="wv-lifecycle-decision-confirm-checklist">
          {LIFECYCLE_CHECKLIST.map(item => (
            <span key={item.key} data-value={String(draft[item.key])}>
              {draft[item.key] === true ? <CheckCircle2 aria-hidden="true" /> : draft[item.key] === false ? <XCircle aria-hidden="true" /> : <Scale aria-hidden="true" />}
              <small>{item.label}</small><strong>{checklistValueLabel(draft[item.key])}</strong>
            </span>
          ))}
        </div>

        {error ? <div className="wv-lifecycle-decision-submit-error" role="alert"><AlertTriangle aria-hidden="true" /><span><strong>A döntés nem került rögzítésre.</strong>{error.message}</span></div> : null}

        <footer>
          <button ref={initialButtonRef} type="button" className="wv-secondary-action" onClick={onClose} disabled={submitting}>Vissza az ellenőrzéshez</button>
          <button type="button" className="wv-primary-action" onClick={onConfirm} disabled={submitting}>
            {submitting ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : draft.outcome === 'approved' ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
            {submitting ? 'Biztonságos rögzítés…' : error ? 'Beküldés újra' : 'Döntés véglegesítése'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default function LifecycleReviewDecisionPanel({ request, onRefresh }: LifecycleReviewDecisionPanelProps) {
  const [draft, setDraft] = useState<LifecycleDecisionDraft>(createLifecycleDecisionDraft)
  const [validation, setValidation] = useState<LifecycleDecisionValidation | null>(null)
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<LifecycleDecisionSubmitError | null>(null)
  const [result, setResult] = useState<LifecycleDecisionActionResult | null>(null)
  const attemptKeyRef = useRef<string | null>(null)
  const submittingRef = useRef(false)
  const reviewButtonRef = useRef<HTMLButtonElement>(null)

  const reasonCodes = lifecycleDecisionReasonCodes(draft.outcome, request.targetStatus)
  const coherentApproval = draft.outcome === 'approved' && request.targetStatus === 'coherent'

  useEffect(() => {
    if (!confirmationOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [confirmationOpen])

  function closeConfirmation() {
    if (submitting) return
    setConfirmationOpen(false)
    requestAnimationFrame(() => reviewButtonRef.current?.focus())
  }

  function updateDraft(mutator: (current: LifecycleDecisionDraft) => LifecycleDecisionDraft) {
    attemptKeyRef.current = null
    setSubmitError(null)
    setValidation(null)
    setDraft(mutator)
  }

  function chooseOutcome(outcome: LifecycleDecisionOutcome) {
    updateDraft(current => {
      const available = lifecycleDecisionReasonCodes(outcome, request.targetStatus)
      return { ...current, outcome, reasonCode: available.length === 1 ? available[0] : null }
    })
  }

  function updateChecklist(key: LifecycleChecklistKey, value: string) {
    updateDraft(current => ({ ...current, [key]: value === 'true' ? true : value === 'false' ? false : null }))
  }

  function openConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextValidation = validateLifecycleDecision(draft, request.targetStatus, request.reviewPolicyVersion)
    setValidation(nextValidation)
    if (!nextValidation.valid) return
    if (!attemptKeyRef.current) attemptKeyRef.current = createLifecycleDecisionIdempotencyKey(request.reviewRequestId)
    setConfirmationOpen(true)
  }

  async function submitDecision() {
    if (submittingRef.current) return
    const idempotencyKey = attemptKeyRef.current
    if (!idempotencyKey) return
    const body = buildLifecycleDecisionBody(draft, request.targetStatus, request.reviewPolicyVersion, idempotencyKey)
    if (!body) {
      setConfirmationOpen(false)
      setValidation(validateLifecycleDecision(draft, request.targetStatus, request.reviewPolicyVersion))
      return
    }

    submittingRef.current = true
    setSubmitting(true)
    setSubmitError(null)
    try {
      const response = await fetch(buildLifecycleDecisionUrl(request.reviewRequestId), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify(body),
      })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const serverMessage = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : undefined
        setSubmitError(lifecycleDecisionSubmitError(response.status, serverMessage))
        return
      }
      const parsed = parseLifecycleDecisionResponse(payload)
      if (!parsed || parsed.reviewRequestId !== request.reviewRequestId) {
        setSubmitError({ kind: 'server', message: 'A szerver válasza nem felel meg a döntési szerződésnek. Automatikus újrapróbálás nem indult.' })
        return
      }
      setResult(parsed)
      setConfirmationOpen(false)
    } catch {
      setSubmitError({ kind: 'network', message: 'A hálózati kapcsolat megszakadt. Automatikus újrapróbálás nem indult; ugyanazzal a beküldési kulccsal kézzel újrapróbálhatod.' })
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  if (result) {
    return (
      <section className="wv-lifecycle-decision-success" role="status" aria-live="polite">
        <span aria-hidden="true"><CheckCircle2 /></span>
        <div><small>Döntés rögzítve</small><h2>{result.outcomeKind === 'replayed' ? 'A korábbi beküldés biztonságosan visszaigazolva.' : 'A felülvizsgálói döntés sikeresen rögzítve.'}</h2><p>A szerver állapota: {resultStatusLabel(result.status)}. A végrehajtás ettől külön életciklus-művelet.</p></div>
        <button type="button" className="wv-secondary-action" onClick={onRefresh}>Részletnézet frissítése</button>
      </section>
    )
  }

  return (
    <section className="wv-lifecycle-decision-panel" aria-labelledby="lifecycle-decision-title">
      <header>
        <div><Scale aria-hidden="true" /><span><small>Felülvizsgálói döntés</small><h2 id="lifecycle-decision-title">Mérlegelj, majd rögzíts egyetlen döntést.</h2></span></div>
        <p>A kliens előzetesen ellenőriz; a végső érvényességet mindig a szerver állapítja meg.</p>
      </header>

      {validation?.formError ? <div className="wv-lifecycle-decision-policy-error" role="alert"><AlertTriangle aria-hidden="true" /><span><strong>Szabályzatverzió-ütközés</strong>{validation.formError}</span></div> : null}

      <form onSubmit={openConfirmation} noValidate>
        <fieldset disabled={submitting}>
          <legend>1 · Döntés</legend>
          <div className="wv-lifecycle-outcome-options">
            <label data-selected={draft.outcome === 'approved'}><input type="radio" name="outcome" value="approved" checked={draft.outcome === 'approved'} onChange={() => chooseOutcome('approved')} /><span><ShieldCheck aria-hidden="true" /><strong>Jóváhagyás</strong><small>A javasolt állapotváltás szakmailag megalapozott.</small></span></label>
            <label data-selected={draft.outcome === 'rejected'}><input type="radio" name="outcome" value="rejected" checked={draft.outcome === 'rejected'} onChange={() => chooseOutcome('rejected')} /><span><XCircle aria-hidden="true" /><strong>Elutasítás</strong><small>A kérelem ebben a formában nem fogadható el.</small></span></label>
          </div>
          {validation?.fieldErrors.outcome ? <p className="wv-field-error">{validation.fieldErrors.outcome}</p> : null}
        </fieldset>

        <fieldset disabled={submitting || !draft.outcome}>
          <legend>2 · Zárt döntési indok</legend>
          <label className="wv-lifecycle-decision-field">
            <span>Indokkód</span>
            <select value={draft.reasonCode ?? ''} onChange={event => updateDraft(current => ({ ...current, reasonCode: (event.target.value || null) as LifecycleReasonCode | null }))} aria-invalid={Boolean(validation?.fieldErrors.reasonCode)}>
              <option value="">Válassz indokot</option>
              {reasonCodes.map(code => <option key={code} value={code}>{formatLifecycleReasonCode(code)}</option>)}
            </select>
            {validation?.fieldErrors.reasonCode ? <small className="wv-field-error">{validation.fieldErrors.reasonCode}</small> : null}
          </label>
        </fieldset>

        <fieldset disabled={submitting || !draft.outcome}>
          <legend>3 · Strukturált életciklus-ellenőrző lista {coherentApproval ? <em>Kötelező megerősítés</em> : <em>Szakmai kontextus</em>}</legend>
          <div className="wv-lifecycle-decision-checklist">
            {LIFECYCLE_CHECKLIST.map((item, index) => (
              <label key={item.key} data-value={String(draft[item.key])}>
                <i aria-hidden="true">{String(index + 1).padStart(2, '0')}</i>
                <span><strong>{item.label}</strong><small>{item.description}</small>{validation?.fieldErrors[item.key] ? <em className="wv-field-error">{validation.fieldErrors[item.key]}</em> : null}</span>
                <select value={draft[item.key] === null ? 'null' : String(draft[item.key])} onChange={event => updateChecklist(item.key, event.target.value)} aria-label={`${item.label} eredménye`} aria-invalid={Boolean(validation?.fieldErrors[item.key])}>
                  <option value="null">Nem vizsgált</option><option value="true">Megerősítve</option><option value="false">Nem teljesül</option>
                </select>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset disabled={submitting || !draft.outcome}>
          <legend>4 · Szakmai indoklás</legend>
          <label className="wv-lifecycle-decision-field">
            <span>Felülvizsgálói indoklás</span>
            <textarea rows={5} maxLength={1000} value={draft.reviewerRationale} onChange={event => updateDraft(current => ({ ...current, reviewerRationale: event.target.value }))} aria-invalid={Boolean(validation?.fieldErrors.reviewerRationale)} placeholder="Röviden rögzítsd, mely bizonyítékok és eltérések alapozták meg a döntést." />
            <small className="wv-lifecycle-character-count">{draft.reviewerRationale.length} / 1000 karakter</small>
            {validation?.fieldErrors.reviewerRationale ? <small className="wv-field-error">{validation.fieldErrors.reviewerRationale}</small> : null}
          </label>
        </fieldset>

        <footer>
          <span><ShieldCheck aria-hidden="true" /> Szabályzat v{request.reviewPolicyVersion} · végrehajtás nélkül</span>
          <button ref={reviewButtonRef} type="submit" className="wv-primary-action" disabled={submitting}>Döntés ellenőrzése <ArrowRight aria-hidden="true" /></button>
        </footer>
      </form>

      {confirmationOpen ? <DecisionConfirmation request={request} draft={draft} submitting={submitting} error={submitError} onClose={closeConfirmation} onConfirm={() => void submitDecision()} /> : null}
    </section>
  )
}
