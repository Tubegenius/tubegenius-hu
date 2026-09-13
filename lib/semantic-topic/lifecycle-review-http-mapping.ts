// PFM Lifecycle Reviewer Read Surface v1 -- shared HTTP-status mapping for
// the two read-only API routes. Mirrors human-review-http-mapping.ts's
// reviewFailureToResponse exactly, narrowed to the outcomes a READ path can
// actually produce -- never a raw Postgres/PostgREST error, error code,
// constraint name, or stack trace reaches the response body. Reuses the
// same jsonNoStore/NO_STORE_HEADERS helper (no reason to duplicate a
// generic, review-unrelated utility).
import type { LifecycleActionFailure, LifecycleReadFailure } from './lifecycle-review-types'
import { jsonNoStore } from './human-review-http-mapping'
import { NextResponse } from 'next/server'

const GENERIC_INTERNAL_ERROR_MESSAGE = 'Váratlan hiba történt. Próbáld újra.'

export function lifecycleReadFailureToResponse(failure: LifecycleReadFailure): NextResponse {
  switch (failure.outcome) {
    case 'unauthenticated':
      return jsonNoStore({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
    case 'not_a_reviewer':
      return jsonNoStore({ error: 'Nincs jogosultságod ehhez a művelethez' }, { status: 403 })
    case 'not_found':
      return jsonNoStore({ error: 'A kért review request nem található' }, { status: 404 })
    case 'invalid_status_filter':
    case 'validation_error':
      return jsonNoStore({ error: 'Érvénytelen bemenet' }, { status: 422 })
    case 'database_error':
    case 'invalid_rpc_response':
      console.error('[lifecycle-review-read] internal error:', failure)
      return jsonNoStore({ error: GENERIC_INTERNAL_ERROR_MESSAGE }, { status: 500 })
    default: {
      const exhaustiveCheck: never = failure
      console.error('[lifecycle-review-read] unmapped failure outcome:', exhaustiveCheck)
      return jsonNoStore({ error: GENERIC_INTERNAL_ERROR_MESSAGE }, { status: 500 })
    }
  }
}

// Mirrors lifecycleReadFailureToResponse's structure exactly, narrowed to
// the outcomes the two WRITE RPCs (decision/cancel) can actually produce.
// 409 groups every "state no longer permits this operation" case
// (not_decidable/not_cancellable/conflict) under one generic message, same
// as the established reviewFailureToResponse precedent in
// human-review-http-mapping.ts.
export function lifecycleActionFailureToResponse(failure: LifecycleActionFailure): NextResponse {
  switch (failure.outcome) {
    case 'unauthenticated':
      return jsonNoStore({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
    case 'not_a_reviewer':
      return jsonNoStore({ error: 'Nincs jogosultságod ehhez a művelethez' }, { status: 403 })
    case 'not_found':
      return jsonNoStore({ error: 'A kért review request nem található' }, { status: 404 })
    case 'expired':
      return jsonNoStore({ error: 'A review request lejárt' }, { status: 410 })
    case 'not_decidable':
    case 'not_cancellable':
    case 'conflict':
      return jsonNoStore({ error: 'A review request állapota nem teszi lehetővé ezt a műveletet' }, { status: 409 })
    case 'validation_error':
      return jsonNoStore({ error: 'Érvénytelen bemenet' }, { status: 422 })
    case 'database_error':
    case 'invalid_rpc_response':
      console.error('[lifecycle-review-action] internal error:', failure)
      return jsonNoStore({ error: GENERIC_INTERNAL_ERROR_MESSAGE }, { status: 500 })
    default: {
      const exhaustiveCheck: never = failure
      console.error('[lifecycle-review-action] unmapped failure outcome:', exhaustiveCheck)
      return jsonNoStore({ error: GENERIC_INTERNAL_ERROR_MESSAGE }, { status: 500 })
    }
  }
}
