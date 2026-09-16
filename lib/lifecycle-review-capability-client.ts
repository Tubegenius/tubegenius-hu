export const LIFECYCLE_REVIEWER_CAPABILITY_URL = '/api/admin/semantic-topic-lifecycle-reviews/capability'

export interface LifecycleReviewerCapability {
  canReviewSemanticTopicLifecycle: boolean
}

export function parseLifecycleReviewerCapability(payload: unknown): LifecycleReviewerCapability | null {
  if (!payload || typeof payload !== 'object') return null
  const capability = (payload as { canReviewSemanticTopicLifecycle?: unknown }).canReviewSemanticTopicLifecycle
  if (typeof capability !== 'boolean') return null
  return { canReviewSemanticTopicLifecycle: capability }
}

export async function fetchLifecycleReviewerCapability(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await requestLifecycleJson(LIFECYCLE_REVIEWER_CAPABILITY_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    }, fetcher)
    if (!response.ok || response.status !== 200) return false
    return parseLifecycleReviewerCapability(response.payload)?.canReviewSemanticTopicLifecycle === true
  } catch {
    return false
  }
}
import { requestLifecycleJson } from '@/lib/lifecycle-review-client'
