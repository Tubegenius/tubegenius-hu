// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, feature
// flag. No generic feature-flag abstraction exists anywhere in this codebase
// (audited: no lib/feature-flags.ts, flags are read inline elsewhere) -- this
// tiny, single-purpose reader follows that same "no abstraction" convention
// while still being independently testable and giving one canonical place to
// document the fail-closed default.
//
// Fail-closed: ANY value other than the literal string 'true' -- missing,
// empty, 'TRUE', '1', 'yes', typo'd -- resolves to disabled. This is
// deliberately stricter than a truthy check.
export function isHumanReviewEnabled(): boolean {
  return process.env.SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED === 'true'
}
