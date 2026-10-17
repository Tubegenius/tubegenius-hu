// lib/creator-focus/index.ts
// Creator Intelligence 2A public surface. Pure; see contract.ts for what the module is and is not.
export * from './contract'
export { adaptProfileRow, PROFILE_COLUMN_PROVENANCE } from './profile-adapter'
export { isFactEligible } from './eligibility'
export { validateFocusProfile } from './profile-validate'
export type { ProfileIssue } from './profile-validate'
export { confirmSuggestion, dismissSuggestion, declareOrCorrectClaim } from './transitions'
export type { TransitionResult, TransitionFailureCode } from './transitions'
export { assessFocusFit } from './fit'
// 2B (local, DB-free core; no store, no table, no route): decision events, fingerprints, read model, command evaluation
export * from './decision-contract'
export { validateDecisionEvents, validateSnapshot } from './decision-events'
export { FINGERPRINT_VERSION, SUPPORTED_FINGERPRINT_VERSIONS, focusSuggestionFingerprint, focusValueFingerprint, isSupportedFingerprintVersion, normalizeDecisionValue } from './fingerprint'
export { applyDecisions, cloneFocusProfile } from './decision-reduce'
export { evaluateDecisionCommand } from './decision-command'
export { sha256Hex } from './sha256'
