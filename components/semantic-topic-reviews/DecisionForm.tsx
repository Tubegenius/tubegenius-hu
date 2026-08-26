'use client'

import { useRef, useState } from 'react'
import FormField from './FormField'
import ConfirmActionModal from './ConfirmActionModal'
import { validateApprovalFields, validateRejectionFields, resolveIdempotencyKey, type IdempotencyAttempt } from './decisionLogic'
import {
  REJECTION_REASONS,
  REJECTION_REASON_LABELS,
  REVIEW_FIELD_MAX_LENGTHS,
  REVIEW_POLICY_VERSION,
  type DuplicateSearchOutcome,
  type ProposedOutcome,
  type RejectionReason,
  type StructuredDecisionPayload,
  type UncertaintyClassification,
} from './types'

interface DecisionFormProps {
  reviewRequestId: string
  onApprovedOrRejected: (result: { outcome: 'approved' | 'rejected' | 'replayed' }) => void
  onConflict: () => void
}

type DecisionOutcome = 'approved' | 'rejected'

interface FormErrors {
  [key: string]: string | undefined
}

// Kliensoldalon egyszer generált, erős idempotency-key -- retryhoz
// (változatlan payload) ugyanaz marad, bármilyen mezőmódosításhoz viszont új
// generálódik. Lásd a submit() logikáját: a payload JSON-összehasonlítása
// dönti el, hogy retry-e vagy valódi új döntés.
function generateIdempotencyKey(): string {
  return `ui-decision:${crypto.randomUUID()}`
}

export default function DecisionForm({ reviewRequestId, onApprovedOrRejected, onConflict }: DecisionFormProps) {
  const [outcome, setOutcome] = useState<DecisionOutcome | null>(null)

  // Approved mezők
  const [canonicalTopicLabel, setCanonicalTopicLabel] = useState('')
  const [topicDefinition, setTopicDefinition] = useState('')
  const [scope, setScope] = useState('')
  const [inclusionCriteria, setInclusionCriteria] = useState('')
  const [exclusionCriteria, setExclusionCriteria] = useState('')
  const [laneNeutralConfirmed, setLaneNeutralConfirmed] = useState(false)
  const [evidenceAdequateConfirmed, setEvidenceAdequateConfirmed] = useState(false)
  const [duplicateSearchOutcome, setDuplicateSearchOutcome] = useState<DuplicateSearchOutcome | ''>('')
  const [proposedOutcome, setProposedOutcome] = useState<ProposedOutcome | ''>('')
  const [targetSemanticTopicId, setTargetSemanticTopicId] = useState('')
  const [uncertaintyClassification, setUncertaintyClassification] = useState<UncertaintyClassification | ''>('')
  const [approvalRationale, setApprovalRationale] = useState('')

  // Rejected mezők
  const [rejectionReason, setRejectionReason] = useState<RejectionReason | ''>('')
  const [rejectionRationale, setRejectionRationale] = useState('')
  const [showRejectConfirm, setShowRejectConfirm] = useState(false)

  const [errors, setErrors] = useState<FormErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const firstErrorRef = useRef<HTMLDivElement>(null)

  const lastAttemptRef = useRef<IdempotencyAttempt | null>(null)

  function selectOutcome(next: DecisionOutcome) {
    if (outcome === next) return
    setOutcome(next)
    setErrors({})
    setServerError(null)
    // Conditional mezők reset -- a másik ág mezői ne maradjanak a payloadban.
    if (next === 'approved') {
      setRejectionReason('')
      setRejectionRationale('')
    } else {
      setCanonicalTopicLabel('')
      setTopicDefinition('')
      setScope('')
      setInclusionCriteria('')
      setExclusionCriteria('')
      setLaneNeutralConfirmed(false)
      setEvidenceAdequateConfirmed(false)
      setDuplicateSearchOutcome('')
      setProposedOutcome('')
      setTargetSemanticTopicId('')
      setUncertaintyClassification('')
      setApprovalRationale('')
    }
  }

  function selectProposedOutcome(next: ProposedOutcome) {
    setProposedOutcome(next)
    if (next === 'CREATE_NEW') setTargetSemanticTopicId('')
  }

  function buildPayload(): { ok: true; payload: StructuredDecisionPayload } | { ok: false; errors: FormErrors } {
    if (outcome === 'rejected') {
      return validateRejectionFields({ rejectionReason, reviewerRationale: rejectionRationale, reviewPolicyVersion: REVIEW_POLICY_VERSION })
    }
    return validateApprovalFields({
      canonicalTopicLabel,
      topicDefinition,
      scope,
      inclusionCriteria,
      exclusionCriteria,
      laneNeutralConfirmed,
      evidenceAdequateConfirmed,
      duplicateSearchOutcome,
      proposedOutcome,
      targetSemanticTopicId,
      uncertaintyClassification,
      reviewerRationale: approvalRationale,
      reviewPolicyVersion: REVIEW_POLICY_VERSION,
    })
  }

  async function submit(payload: StructuredDecisionPayload) {
    const payloadJson = JSON.stringify(payload)
    // Retry ugyanazzal a payloaddal -> ugyanaz a kulcs. Bármilyen módosítás
    // -> friss kulcs. Ez pontosan a decision idempotency szerződés -- lásd
    // decisionLogic.ts:resolveIdempotencyKey és annak dedikált tesztjeit.
    const attempt = resolveIdempotencyKey(lastAttemptRef.current, payloadJson, generateIdempotencyKey)
    const key = attempt.key
    lastAttemptRef.current = attempt

    setSubmitting(true)
    setServerError(null)
    try {
      const res = await fetch(`/api/admin/semantic-topic-reviews/${reviewRequestId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: payloadJson,
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        // success/replayed egyaránt sikeres felhasználói végállapot.
        onApprovedOrRejected({ outcome: (body.result as 'approved' | 'rejected' | 'replayed') ?? 'approved' })
        return
      }
      if (res.status === 409) {
        onConflict()
        return
      }
      setServerError(typeof body.error === 'string' ? body.error : 'Váratlan hiba történt a döntés mentésekor.')
    } catch {
      setServerError('Hálózati hiba történt. A megegyező adatokkal újrapróbálható, anélkül hogy duplikált döntés jönne létre.')
    } finally {
      setSubmitting(false)
    }
  }

  function handleSubmitClick() {
    if (!outcome) {
      setErrors({ outcome: 'Válassz: jóváhagyás vagy elutasítás' })
      return
    }
    const result = buildPayload()
    if (!result.ok) {
      setErrors(result.errors)
      requestAnimationFrame(() => firstErrorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
      return
    }
    setErrors({})
    if (outcome === 'rejected') {
      setShowRejectConfirm(true)
      return
    }
    void submit(result.payload)
  }

  function confirmRejectAndSubmit() {
    const result = buildPayload()
    setShowRejectConfirm(false)
    if (result.ok) void submit(result.payload)
  }

  const firstErrorKey = Object.keys(errors)[0]

  return (
    <div className="card">
      <h2 className="text-lg font-semibold mb-1" style={{ color: '#F8FAFC' }}>
        Strukturált döntés
      </h2>
      <p className="text-xs mb-4" style={{ color: '#94A3B8' }}>
        A jóváhagyás önmagában nem hajt végre semmit -- csak elutasítás esetén jön létre azonnal végleges (QUARANTINE) döntés.
      </p>

      <div role="radiogroup" aria-label="Döntés típusa" className="flex gap-3 mb-5">
        <button
          type="button"
          role="radio"
          aria-checked={outcome === 'approved'}
          onClick={() => selectOutcome('approved')}
          disabled={submitting}
          className="flex-1 py-3 rounded-lg text-sm font-semibold transition-all"
          style={{
            background: outcome === 'approved' ? 'rgba(34,197,94,0.12)' : '#121826',
            border: outcome === 'approved' ? '1px solid rgba(34,197,94,0.4)' : '1px solid rgba(255,255,255,0.08)',
            color: outcome === 'approved' ? '#22C55E' : '#CBD5E1',
          }}
        >
          ✅ Jóváhagyás
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={outcome === 'rejected'}
          onClick={() => selectOutcome('rejected')}
          disabled={submitting}
          className="flex-1 py-3 rounded-lg text-sm font-semibold transition-all"
          style={{
            background: outcome === 'rejected' ? 'rgba(239,68,68,0.12)' : '#121826',
            border: outcome === 'rejected' ? '1px solid rgba(239,68,68,0.4)' : '1px solid rgba(255,255,255,0.08)',
            color: outcome === 'rejected' ? '#EF4444' : '#CBD5E1',
          }}
        >
          ⛔ Elutasítás
        </button>
      </div>
      {errors.outcome && (
        <p role="alert" className="text-xs mb-4" style={{ color: '#EF4444' }}>
          {errors.outcome}
        </p>
      )}

      {outcome === 'approved' && (
        <fieldset disabled={submitting} className="space-y-4">
          <legend className="sr-only">Jóváhagyási adatok</legend>
          <div ref={firstErrorKey === 'canonicalTopicLabel' ? firstErrorRef : undefined}>
            <FormField label="Kanonikus topic-címke" value={canonicalTopicLabel} onChange={setCanonicalTopicLabel} maxLength={REVIEW_FIELD_MAX_LENGTHS.canonicalTopicLabel} required error={errors.canonicalTopicLabel} />
          </div>
          <div ref={firstErrorKey === 'topicDefinition' ? firstErrorRef : undefined}>
            <FormField label="Topic definíció" value={topicDefinition} onChange={setTopicDefinition} maxLength={REVIEW_FIELD_MAX_LENGTHS.topicDefinition} multiline required error={errors.topicDefinition} />
          </div>
          <div ref={firstErrorKey === 'scope' ? firstErrorRef : undefined}>
            <FormField label="Hatókör (scope)" value={scope} onChange={setScope} maxLength={REVIEW_FIELD_MAX_LENGTHS.scope} multiline required error={errors.scope} />
          </div>
          <div ref={firstErrorKey === 'inclusionCriteria' ? firstErrorRef : undefined}>
            <FormField label="Befoglalási kritériumok" value={inclusionCriteria} onChange={setInclusionCriteria} maxLength={REVIEW_FIELD_MAX_LENGTHS.inclusionCriteria} multiline required error={errors.inclusionCriteria} />
          </div>
          <div ref={firstErrorKey === 'exclusionCriteria' ? firstErrorRef : undefined}>
            <FormField label="Kizárási kritériumok" value={exclusionCriteria} onChange={setExclusionCriteria} maxLength={REVIEW_FIELD_MAX_LENGTHS.exclusionCriteria} multiline required error={errors.exclusionCriteria} />
          </div>

          <label className="flex items-start gap-2.5 text-sm" style={{ color: '#CBD5E1' }}>
            <input type="checkbox" checked={laneNeutralConfirmed} onChange={e => setLaneNeutralConfirmed(e.target.checked)} className="mt-0.5" aria-describedby={errors.laneNeutralConfirmed ? 'lane-neutral-error' : undefined} />
            <span>Megerősítem, hogy ez a topic lane-neutrális (nem sérti a lane-szeparációt).</span>
          </label>
          {errors.laneNeutralConfirmed && <p id="lane-neutral-error" role="alert" className="text-xs" style={{ color: '#EF4444' }}>{errors.laneNeutralConfirmed}</p>}

          <label className="flex items-start gap-2.5 text-sm" style={{ color: '#CBD5E1' }}>
            <input type="checkbox" checked={evidenceAdequateConfirmed} onChange={e => setEvidenceAdequateConfirmed(e.target.checked)} className="mt-0.5" aria-describedby={errors.evidenceAdequateConfirmed ? 'evidence-adequate-error' : undefined} />
            <span>Megerősítem, hogy a bizonyíték elegendő (adequate) a magabiztos döntéshez.</span>
          </label>
          {errors.evidenceAdequateConfirmed && <p id="evidence-adequate-error" role="alert" className="text-xs" style={{ color: '#EF4444' }}>{errors.evidenceAdequateConfirmed}</p>}

          <div>
            <label htmlFor="duplicate-search-outcome" className="text-sm font-medium block mb-1.5" style={{ color: '#CBD5E1' }}>
              Duplikátum-keresés eredménye <span style={{ color: '#EF4444' }}>*</span>
            </label>
            <select
              id="duplicate-search-outcome"
              className="input"
              value={duplicateSearchOutcome}
              onChange={e => setDuplicateSearchOutcome(e.target.value as DuplicateSearchOutcome)}
              aria-describedby={errors.duplicateSearchOutcome ? 'duplicate-search-error' : undefined}
            >
              <option value="">Válassz...</option>
              <option value="no_duplicate_found">Nem található duplikátum</option>
              <option value="possible_duplicate_reviewed_and_distinct">Lehetséges duplikátum, ellenőrizve, megkülönböztethető</option>
            </select>
            {errors.duplicateSearchOutcome && <p id="duplicate-search-error" role="alert" className="text-xs mt-1.5" style={{ color: '#EF4444' }}>{errors.duplicateSearchOutcome}</p>}
          </div>

          <div>
            <span className="text-sm font-medium block mb-1.5" style={{ color: '#CBD5E1' }}>
              Javasolt kimenet <span style={{ color: '#EF4444' }}>*</span>
            </span>
            <div role="radiogroup" aria-label="Javasolt kimenet" className="flex gap-3">
              <button type="button" role="radio" aria-checked={proposedOutcome === 'CREATE_NEW'} onClick={() => selectProposedOutcome('CREATE_NEW')}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium transition-all"
                style={{ background: proposedOutcome === 'CREATE_NEW' ? 'rgba(59,130,246,0.1)' : '#121826', border: proposedOutcome === 'CREATE_NEW' ? '1px solid rgba(59,130,246,0.4)' : '1px solid rgba(255,255,255,0.08)', color: proposedOutcome === 'CREATE_NEW' ? '#3B82F6' : '#CBD5E1' }}>
                🆕 Új topic létrehozása
              </button>
              <button type="button" role="radio" aria-checked={proposedOutcome === 'ATTACH_EXISTING'} onClick={() => selectProposedOutcome('ATTACH_EXISTING')}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium transition-all"
                style={{ background: proposedOutcome === 'ATTACH_EXISTING' ? 'rgba(59,130,246,0.1)' : '#121826', border: proposedOutcome === 'ATTACH_EXISTING' ? '1px solid rgba(59,130,246,0.4)' : '1px solid rgba(255,255,255,0.08)', color: proposedOutcome === 'ATTACH_EXISTING' ? '#3B82F6' : '#CBD5E1' }}>
                🔗 Meglévő topichoz csatolás
              </button>
            </div>
            {errors.proposedOutcome && <p role="alert" className="text-xs mt-1.5" style={{ color: '#EF4444' }}>{errors.proposedOutcome}</p>}

            {proposedOutcome === 'CREATE_NEW' && (
              <p className="text-xs mt-2 px-3 py-2 rounded-lg" style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)', color: '#93C5FD' }}>
                Jóváhagyás után egy új, önálló (candidate_singleton) topic jön létre -- de csak a külön, felügyelt végrehajtási lépésben, nem automatikusan.
              </p>
            )}
            {proposedOutcome === 'ATTACH_EXISTING' && (
              <div className="mt-2">
                <p className="text-xs mb-2 px-3 py-2 rounded-lg" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#FBBF24' }}>
                  ⚠️ Felügyelt pilot input: jelenleg nincs topic-kereső felület, ezért a cél topic pontos UUID-jét kell megadni. Ez egy dokumentált UX-hiány -- a végleges verzióban egy topic-választó lesz. A végrehajtáskor a rendszer újra ellenőrzi a cél topic életciklus-állapotát.
                </p>
                <FormField label="Cél semantic topic UUID" value={targetSemanticTopicId} onChange={setTargetSemanticTopicId} maxLength={36} error={errors.targetSemanticTopicId} placeholder="pl. 3fa85f64-5717-4562-b3fc-2c963f66afa6" />
              </div>
            )}
          </div>

          <div>
            <label htmlFor="uncertainty-classification" className="text-sm font-medium block mb-1.5" style={{ color: '#CBD5E1' }}>
              Bizonytalansági besorolás <span style={{ color: '#EF4444' }}>*</span>
            </label>
            <select
              id="uncertainty-classification"
              className="input"
              value={uncertaintyClassification}
              onChange={e => setUncertaintyClassification(e.target.value as UncertaintyClassification)}
              aria-describedby={errors.uncertaintyClassification ? 'uncertainty-error' : undefined}
            >
              <option value="">Válassz...</option>
              <option value="low">Alacsony</option>
              <option value="medium">Közepes</option>
              <option value="high">Magas</option>
            </select>
            {errors.uncertaintyClassification && <p id="uncertainty-error" role="alert" className="text-xs mt-1.5" style={{ color: '#EF4444' }}>{errors.uncertaintyClassification}</p>}
          </div>

          <div ref={firstErrorKey === 'approvalRationale' ? firstErrorRef : undefined}>
            <FormField label="Reviewer indoklás" value={approvalRationale} onChange={setApprovalRationale} maxLength={REVIEW_FIELD_MAX_LENGTHS.reviewerRationale} multiline required error={errors.approvalRationale} />
          </div>
        </fieldset>
      )}

      {outcome === 'rejected' && (
        <fieldset disabled={submitting} className="space-y-4">
          <legend className="sr-only">Elutasítási adatok</legend>
          <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#FCA5A5' }}>
            ⚠️ Az elutasítás <b>végleges</b>: azonnal egy append-only QUARANTINE assignment decision jön létre ezen a futáson, ami többé nem visszavonható.
          </p>
          <div>
            <label htmlFor="rejection-reason" className="text-sm font-medium block mb-1.5" style={{ color: '#CBD5E1' }}>
              Elutasítás oka <span style={{ color: '#EF4444' }}>*</span>
            </label>
            <select
              id="rejection-reason"
              className="input"
              value={rejectionReason}
              onChange={e => setRejectionReason(e.target.value as RejectionReason)}
              aria-describedby={errors.rejectionReason ? 'rejection-reason-error' : undefined}
            >
              <option value="">Válassz...</option>
              {REJECTION_REASONS.map(reason => (
                <option key={reason} value={reason}>
                  {REJECTION_REASON_LABELS[reason]}
                </option>
              ))}
            </select>
            {errors.rejectionReason && <p id="rejection-reason-error" role="alert" className="text-xs mt-1.5" style={{ color: '#EF4444' }}>{errors.rejectionReason}</p>}
          </div>
          <div ref={firstErrorKey === 'rejectionRationale' ? firstErrorRef : undefined}>
            <FormField label="Reviewer indoklás" value={rejectionRationale} onChange={setRejectionRationale} maxLength={REVIEW_FIELD_MAX_LENGTHS.reviewerRationale} multiline required error={errors.rejectionRationale} />
          </div>
        </fieldset>
      )}

      {serverError && (
        <p role="alert" aria-live="assertive" className="text-sm mt-4 px-3 py-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#FCA5A5' }}>
          {serverError}
        </p>
      )}

      {outcome && (
        <button type="button" onClick={handleSubmitClick} disabled={submitting} className="btn-primary w-full mt-5">
          {submitting ? 'Mentés...' : outcome === 'approved' ? 'Jóváhagyás mentése' : 'Elutasítás mentése'}
        </button>
      )}

      {showRejectConfirm && (
        <ConfirmActionModal
          titleText="Biztosan elutasítod?"
          bodyText="Ez a döntés végleges: azonnal létrejön egy append-only QUARANTINE assignment decision, ami nem vonható vissza."
          confirmLabel="Igen, elutasítom"
          tone="danger"
          loading={submitting}
          onConfirm={confirmRejectAndSubmit}
          onCancel={() => setShowRejectConfirm(false)}
        />
      )}
    </div>
  )
}
