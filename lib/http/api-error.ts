// ============================================================
// WILLVIRAL -- API error contract builders (backend error contract, wave 1)
// ============================================================
// One body shape for the classified failures:
//   { error: <HU message>, code: <machine code>, retryable: boolean, request_id: <id> }
// `code` / `retryable` / `request_id` are ADDITIVE: the existing `error` texts are
// unchanged so current clients and tests keep matching them.
//
//   401 unauthenticated      -> the ONLY logout-capable signal
//   503 auth_unavailable     -> never logout-capable (Retry-After, no-store)
//   409 request_in_progress  -> a real lock conflict
//   503 lock_unavailable     -> the lock service itself failed; returned BEFORE any
//                               provider call or charge, so "no credit charged" is true
import { NextResponse } from 'next/server'
import type { AuthResolution } from '@/lib/auth/resolve-auth'

export type ApiErrorCode = 'unauthenticated' | 'auth_unavailable' | 'request_in_progress' | 'lock_unavailable'

export const UNAUTHENTICATED_MESSAGE = 'Nem vagy bejelentkezve'
export const AUTH_UNAVAILABLE_MESSAGE = 'A szolgáltatás átmenetileg nem érhető el. Próbáld újra egy pillanat múlva.'
export const LOCK_UNAVAILABLE_MESSAGE = 'A művelet most nem indítható biztonságosan. Kredit nem lett levonva. Próbáld újra egy pillanat múlva.'

export function requestIdFrom(request?: Request | null): string {
  const vercelId = request?.headers?.get?.('x-vercel-id')
  if (vercelId) return vercelId
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now()}`
}

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  options: { retryable: boolean; requestId: string; retryAfterSeconds?: number },
): NextResponse {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' }
  if (status === 503 && options.retryAfterSeconds) headers['Retry-After'] = String(options.retryAfterSeconds)
  return NextResponse.json(
    { error: message, code, retryable: options.retryable, request_id: options.requestId },
    { status, headers },
  )
}

export function unauthenticatedResponse(request?: Request | null): NextResponse {
  return apiError(401, 'unauthenticated', UNAUTHENTICATED_MESSAGE, { retryable: false, requestId: requestIdFrom(request) })
}

/** Logs the classified outage (no tokens, no cookies, no user data) and builds the 503. */
export function authUnavailableResponse(
  resolution: Extract<AuthResolution, { kind: 'unavailable' }>,
  route: string,
  request?: Request | null,
): NextResponse {
  const requestId = requestIdFrom(request)
  console.error(`[Auth] unavailable route=${route} cause=${resolution.cause} sdk=${resolution.sdkName ?? '-'} status=${resolution.sdkStatus ?? '-'} code=${resolution.sdkCode ?? '-'} request_id=${requestId}`)
  if (resolution.cause === 'gateway_auth_misconfig') {
    console.error(`[Auth] gateway_auth_misconfig route=${route}: a 401/403 WITHOUT an auth error code came back -- check the Supabase API key / URL of this deployment (not a user session problem) request_id=${requestId}`)
  }
  return apiError(503, 'auth_unavailable', AUTH_UNAVAILABLE_MESSAGE, { retryable: true, requestId, retryAfterSeconds: resolution.retryAfterSeconds })
}

export function lockConflictResponse(message: string, request?: Request | null): NextResponse {
  return apiError(409, 'request_in_progress', message, { retryable: true, requestId: requestIdFrom(request) })
}

export function lockUnavailableResponse(request?: Request | null): NextResponse {
  return apiError(503, 'lock_unavailable', LOCK_UNAVAILABLE_MESSAGE, { retryable: true, requestId: requestIdFrom(request), retryAfterSeconds: 2 })
}
