// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, minimal
// reviewer UI. Pure, DOM-free status/visibility rules, extracted for the
// same testability reason documented in decisionLogic.ts's header.
import type { ReviewRequestStatus } from './types'

export interface AvailableActions {
  canDecide: boolean
  canCancel: boolean
  canRevoke: boolean
}

// Egyetlen forrás annak eldöntésére, hogy melyik action gomb látszódhat egy
// adott status mellett -- a DB-szerződés (078) tükrözése: csak 'pending'
// dönthető el vagy vonható vissza (cancel), csak 'approved' vonható vissza
// (revoke). Minden más állapot (rejected/expired/cancelled/revoked/executed)
// terminális: egyetlen action sem érhető el.
export function availableActionsForStatus(status: ReviewRequestStatus): AvailableActions {
  return {
    canDecide: status === 'pending',
    canCancel: status === 'pending',
    canRevoke: status === 'approved',
  }
}

export function isPastExpiry(expiresAtIso: string, nowMs: number = Date.now()): boolean {
  const t = new Date(expiresAtIso).getTime()
  if (Number.isNaN(t)) return false
  return t < nowMs
}
