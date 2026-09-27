// Client-safe (no server imports) failure-classification for the
// evidence-snapshot write call (POST /api/opportunity/evidence-snapshot).
// Extracted into its own pure function so both app/dashboard/opportunities/
// page.tsx card components (TopicCard, DiscoveryLaneCard) share IDENTICAL
// behaviour, and so the policy itself is unit-testable without a DOM/RTL
// environment (this project's vitest config runs environment: 'node').
//
// Policy: an auth/ownership failure (401/403) must NEVER lead to an
// auto-navigate that implies evidence was attached -- it is 'blocked', a
// dead end until the user retries. Any other failure (404 resolution miss,
// 500, network error) offers an explicit "Folytatás bizonyíték nélkül"
// choice -- 'degradable'. A successful response (2xx) is handled by the
// caller directly, this function is only for the failure branch.
export type EvidenceSnapshotFailureKind = 'blocked' | 'degradable'

export function classifyEvidenceSnapshotFailure(status: number): EvidenceSnapshotFailureKind {
  return status === 401 || status === 403 ? 'blocked' : 'degradable'
}
