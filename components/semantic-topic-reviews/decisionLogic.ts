// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, minimal
// reviewer UI. Pure, DOM-free decision-form logic, deliberately extracted
// out of DecisionForm.tsx into its own module.
//
// WHY this file exists: this repo has no React component-rendering test
// infrastructure (vitest.config.ts runs `environment: 'node'`, and neither
// @testing-library/react nor jsdom is installed) -- and installing new UI
// testing dependencies from the network was out of scope for this gate.
// Extracting the form's validation/idempotency logic into plain, DOM-free
// functions is what makes it possible to unit-test that logic for real
// (see tests/human-review-ui-decision-logic.test.ts) instead of only being
// able to describe it in prose. This is not speculative abstraction --
// every function here is called from exactly one place in DecisionForm.tsx.
import {
  REVIEW_FIELD_MAX_LENGTHS,
  isUuid,
  type DuplicateSearchOutcome,
  type ProposedOutcome,
  type RejectionReason,
  type StructuredDecisionPayload,
  type UncertaintyClassification,
} from './types'

export interface ApprovalFormFields {
  canonicalTopicLabel: string
  topicDefinition: string
  scope: string
  inclusionCriteria: string
  exclusionCriteria: string
  laneNeutralConfirmed: boolean
  evidenceAdequateConfirmed: boolean
  duplicateSearchOutcome: DuplicateSearchOutcome | ''
  proposedOutcome: ProposedOutcome | ''
  targetSemanticTopicId: string
  uncertaintyClassification: UncertaintyClassification | ''
  reviewerRationale: string
  reviewPolicyVersion: number
}

export interface RejectionFormFields {
  rejectionReason: RejectionReason | ''
  reviewerRationale: string
  reviewPolicyVersion: number
}

export type FormValidationErrors = Record<string, string>
export type ValidationResult = { ok: true; payload: StructuredDecisionPayload } | { ok: false; errors: FormValidationErrors }

function isNonEmpty(v: string): boolean {
  return v.trim().length > 0
}

export function validateApprovalFields(f: ApprovalFormFields): ValidationResult {
  const errors: FormValidationErrors = {}

  if (!isNonEmpty(f.canonicalTopicLabel) || f.canonicalTopicLabel.length > REVIEW_FIELD_MAX_LENGTHS.canonicalTopicLabel) {
    errors.canonicalTopicLabel = `Kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.canonicalTopicLabel} karakter`
  }
  if (!isNonEmpty(f.topicDefinition) || f.topicDefinition.length > REVIEW_FIELD_MAX_LENGTHS.topicDefinition) {
    errors.topicDefinition = `Kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.topicDefinition} karakter`
  }
  if (!isNonEmpty(f.scope) || f.scope.length > REVIEW_FIELD_MAX_LENGTHS.scope) {
    errors.scope = `Kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.scope} karakter`
  }
  if (!isNonEmpty(f.inclusionCriteria) || f.inclusionCriteria.length > REVIEW_FIELD_MAX_LENGTHS.inclusionCriteria) {
    errors.inclusionCriteria = `Kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.inclusionCriteria} karakter`
  }
  if (!isNonEmpty(f.exclusionCriteria) || f.exclusionCriteria.length > REVIEW_FIELD_MAX_LENGTHS.exclusionCriteria) {
    errors.exclusionCriteria = `Kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.exclusionCriteria} karakter`
  }
  if (!f.laneNeutralConfirmed) errors.laneNeutralConfirmed = 'Meg kell erősíteni, hogy a téma lane-neutrális'
  if (!f.evidenceAdequateConfirmed) errors.evidenceAdequateConfirmed = 'Meg kell erősíteni, hogy a bizonyíték elegendő'
  if (!f.duplicateSearchOutcome) errors.duplicateSearchOutcome = 'Válassz duplikátum-keresési eredményt'
  if (!f.proposedOutcome) errors.proposedOutcome = 'Válassz: új topic vagy meglévőhöz csatolás'
  if (f.proposedOutcome === 'ATTACH_EXISTING' && !isUuid(f.targetSemanticTopicId)) {
    errors.targetSemanticTopicId = 'Pontos, érvényes UUID szükséges (supervised pilot input)'
  }
  if (!f.uncertaintyClassification) errors.uncertaintyClassification = 'Válassz bizonytalansági besorolást'
  if (!isNonEmpty(f.reviewerRationale) || f.reviewerRationale.length > REVIEW_FIELD_MAX_LENGTHS.reviewerRationale) {
    errors.reviewerRationale = `Kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.reviewerRationale} karakter`
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  return {
    ok: true,
    payload: {
      outcome: 'approved',
      canonicalTopicLabel: f.canonicalTopicLabel,
      topicDefinition: f.topicDefinition,
      scope: f.scope,
      inclusionCriteria: f.inclusionCriteria,
      exclusionCriteria: f.exclusionCriteria,
      laneNeutralConfirmed: true,
      evidenceAdequacy: 'adequate',
      duplicateSearchOutcome: f.duplicateSearchOutcome as DuplicateSearchOutcome,
      proposedOutcome: f.proposedOutcome as ProposedOutcome,
      // CREATE_NEW soha nem küldhet target id-t, még ha a mező történetesen
      // nem lenne üres -- ez a DB-szerződés (077/078) egyik explicit
      // szabálya, itt is tükrözve, nem csak a szerveren.
      targetSemanticTopicId: f.proposedOutcome === 'ATTACH_EXISTING' ? f.targetSemanticTopicId : null,
      uncertaintyClassification: f.uncertaintyClassification as UncertaintyClassification,
      reviewerRationale: f.reviewerRationale,
      reviewPolicyVersion: f.reviewPolicyVersion,
    },
  }
}

export function validateRejectionFields(f: RejectionFormFields): ValidationResult {
  const errors: FormValidationErrors = {}
  if (!f.rejectionReason) errors.rejectionReason = 'Válassz elutasítási okot'
  if (!isNonEmpty(f.reviewerRationale) || f.reviewerRationale.length > REVIEW_FIELD_MAX_LENGTHS.reviewerRationale) {
    errors.reviewerRationale = `Kötelező, legfeljebb ${REVIEW_FIELD_MAX_LENGTHS.reviewerRationale} karakter`
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    payload: {
      outcome: 'rejected',
      rejectionReason: f.rejectionReason as RejectionReason,
      reviewerRationale: f.reviewerRationale,
      reviewPolicyVersion: f.reviewPolicyVersion,
    },
  }
}

export interface IdempotencyAttempt {
  key: string
  payloadJson: string
}

// Retry ugyanazzal a payloaddal -> ugyanaz a kulcs (network timeout után NEM
// generál új kulcsot). Bármilyen mezőmódosítás (== eltérő payloadJson) ->
// friss kulcs. `makeKey` injektálva, hogy a teszt determinisztikus tudjon
// lenni crypto.randomUUID() mockolása nélkül is.
export function resolveIdempotencyKey(previous: IdempotencyAttempt | null, payloadJson: string, makeKey: () => string): IdempotencyAttempt {
  if (previous && previous.payloadJson === payloadJson) return previous
  return { key: makeKey(), payloadJson }
}
