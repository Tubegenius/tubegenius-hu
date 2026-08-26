// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, shared
// HTTP-status mapping for the reviewer admin API routes. One place owning
// the outcome -> status contract so every route (list/get/decision/cancel/
// revoke) maps identically -- never a raw Postgres/PostgREST error, error
// code, constraint name, or stack trace reaches the response body.
import { NextResponse } from 'next/server'
import type { ReviewOperationFailure } from './human-review-types'

const GENERIC_INTERNAL_ERROR_MESSAGE = 'Váratlan hiba történt. Próbáld újra.'

export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const

export function jsonNoStore(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, { status: init?.status ?? 200, headers: NO_STORE_HEADERS })
}

// Shared JSON-body reader for every POST route in this workflow: enforces
// Content-Type: application/json and a byte-size ceiling BEFORE attempting
// to parse, so an oversized or wrong-content-type body never reaches
// JSON.parse (and never reaches a downstream RPC call at all).
export type JsonBodyResult = { ok: true; body: unknown } | { ok: false; reason: 'bad_content_type' | 'too_large' | 'invalid_json' }

export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return { ok: false, reason: 'bad_content_type' }
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, reason: 'too_large' }
  }
  try {
    return { ok: true, body: text.length > 0 ? JSON.parse(text) : {} }
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
}

export function reviewFailureToResponse(failure: ReviewOperationFailure): NextResponse {
  switch (failure.outcome) {
    case 'unauthenticated':
      return jsonNoStore({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
    case 'not_a_reviewer':
      return jsonNoStore({ error: 'Nincs jogosultságod ehhez a művelethez' }, { status: 403 })
    case 'not_found':
      return jsonNoStore({ error: 'A kért review request nem található' }, { status: 404 })
    case 'expired':
      return jsonNoStore({ error: 'A review request lejárt' }, { status: 410 })
    case 'already_decided':
    case 'already_executed':
    case 'not_cancellable':
    case 'not_revocable':
    case 'not_decidable':
    case 'not_executable':
    case 'idempotency_key_reuse':
      return jsonNoStore({ error: 'A review request állapota nem teszi lehetővé ezt a műveletet' }, { status: 409 })
    case 'validation_error':
      return jsonNoStore({ error: 'Érvénytelen bemenet' }, { status: 422 })
    case 'not_eligible':
      // Reviewer routes never trigger this outcome (only the service-layer
      // create call can) -- present as a 409 defensively if it ever does,
      // never as a 500.
      return jsonNoStore({ error: 'A kérés nem alkalmas emberi felülvizsgálatra' }, { status: 409 })
    case 'database_error':
    case 'invalid_rpc_response':
      console.error('[human-review] internal error:', failure)
      return jsonNoStore({ error: GENERIC_INTERNAL_ERROR_MESSAGE }, { status: 500 })
    default: {
      const exhaustiveCheck: never = failure
      console.error('[human-review] unmapped failure outcome:', exhaustiveCheck)
      return jsonNoStore({ error: GENERIC_INTERNAL_ERROR_MESSAGE }, { status: 500 })
    }
  }
}
