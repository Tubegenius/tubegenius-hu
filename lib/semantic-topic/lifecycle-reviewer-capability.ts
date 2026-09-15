// PFM Lifecycle Reviewer Self-Capability v1 -- minimal, request-bound
// reader/HTTP-mapping for the reviewer's OWN
// get_semantic_topic_lifecycle_reviewer_capability() RPC (089).
//
// SECURITY BOUNDARY: getLifecycleReviewerCapability() takes the CALLER'S
// OWN, request-bound user-session Supabase client
// (createServerSupabaseClient()'s return value) as a REQUIRED parameter --
// there is no service-role fallback anywhere in this file, mirroring
// lifecycle-review-reader.ts's own established pattern exactly.
//
// This capability is a UI/navigation signal ONLY -- it never replaces the
// existing list/detail/decision/cancel RPC- and route-level authorization,
// which remains the sole binding security gate for those operations.
//
// Any RPC-level error -- including the RPC's own fail-closed
// "authentication required" exception, which the HTTP route should never
// actually trigger since it always checks auth.getUser() first -- becomes
// a database_error result here. It is NEVER silently coerced to false;
// "I don't know" and "not a reviewer" must stay distinguishable all the
// way to the route, which maps database_error to a redacted 500.
import { NextResponse } from 'next/server'
import {
  toLifecycleDatabaseErrorShape,
  type LifecycleDatabaseErrorShape,
  type LifecycleReviewUserSessionClient,
} from './lifecycle-review-types'
import { jsonNoStore } from './human-review-http-mapping'

const RPC_NAME = 'get_semantic_topic_lifecycle_reviewer_capability'
const GENERIC_INTERNAL_ERROR_MESSAGE = 'Váratlan hiba történt. Próbáld újra.'

export type LifecycleReviewerCapabilityResult =
  | { outcome: 'success'; canReviewSemanticTopicLifecycle: boolean }
  | { outcome: 'database_error'; operation: string; error: LifecycleDatabaseErrorShape }
  | { outcome: 'invalid_rpc_response'; operation: string }

export async function getLifecycleReviewerCapability(
  client: LifecycleReviewUserSessionClient,
): Promise<LifecycleReviewerCapabilityResult> {
  const { data, error } = await (client as any).rpc(RPC_NAME)
  if (error) return { outcome: 'database_error', operation: RPC_NAME, error: toLifecycleDatabaseErrorShape(error) }
  if (typeof data !== 'boolean') return { outcome: 'invalid_rpc_response', operation: RPC_NAME }
  return { outcome: 'success', canReviewSemanticTopicLifecycle: data }
}

export function lifecycleReviewerCapabilityFailureToResponse(
  failure: Exclude<LifecycleReviewerCapabilityResult, { outcome: 'success' }>,
): NextResponse {
  console.error('[lifecycle-reviewer-capability] internal error:', failure)
  return jsonNoStore({ error: GENERIC_INTERNAL_ERROR_MESSAGE }, { status: 500 })
}
