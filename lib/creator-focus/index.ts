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
