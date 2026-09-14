import type {
  LifecycleFromStatus,
  LifecyclePaginationCursor,
  LifecycleRequestStatus,
  LifecycleReviewListItem,
  LifecycleStatusFilter,
  LifecycleTargetStatus,
} from '@/lib/semantic-topic/lifecycle-review-types'

export const LIFECYCLE_LIST_PAGE_SIZE = 20

export const LIFECYCLE_STATUS_FILTER_OPTIONS: readonly {
  value: LifecycleStatusFilter
  label: string
}[] = [
  { value: 'actionable', label: 'Teendők' },
  { value: 'requested', label: 'Kért' },
  { value: 'approved', label: 'Jóváhagyott' },
  { value: 'rejected', label: 'Elutasított' },
  { value: 'executed', label: 'Végrehajtott' },
  { value: 'stale', label: 'Elavult' },
  { value: 'expired', label: 'Lejárt' },
  { value: 'cancelled', label: 'Visszavont' },
  { value: 'history', label: 'Előzmények' },
]

export const LIFECYCLE_FROM_STATUS_OPTIONS: readonly {
  value: LifecycleFromStatus
  label: string
}[] = [
  { value: 'corroborating', label: 'Megerősítés alatt' },
  { value: 'ambiguous', label: 'Nem egyértelmű' },
]

export const LIFECYCLE_TARGET_STATUS_OPTIONS: readonly {
  value: LifecycleTargetStatus
  label: string
}[] = [
  { value: 'coherent', label: 'Koherens' },
  { value: 'ambiguous', label: 'Nem egyértelmű' },
  { value: 'corroborating', label: 'Megerősítés alatt' },
]

export const LIFECYCLE_STATUS_PRESENTATION: Record<LifecycleRequestStatus, {
  label: string
  tone: 'lime' | 'cyan' | 'coral' | 'amber' | 'muted'
}> = {
  requested: { label: 'Döntésre vár', tone: 'lime' },
  approved: { label: 'Jóváhagyott', tone: 'cyan' },
  rejected: { label: 'Elutasított', tone: 'coral' },
  expired: { label: 'Lejárt', tone: 'amber' },
  cancelled: { label: 'Visszavont', tone: 'muted' },
  executed: { label: 'Végrehajtott', tone: 'lime' },
  stale: { label: 'Elavult', tone: 'amber' },
}

const REQUEST_STATUSES = new Set<LifecycleRequestStatus>([
  'requested',
  'approved',
  'rejected',
  'expired',
  'cancelled',
  'executed',
  'stale',
])
const FROM_STATUSES = new Set<LifecycleFromStatus>(['corroborating', 'ambiguous'])
const TARGET_STATUSES = new Set<LifecycleTargetStatus>(['coherent', 'ambiguous', 'corroborating'])

export type LifecycleFromFilter = 'all' | LifecycleFromStatus
export type LifecycleTargetFilter = 'all' | LifecycleTargetStatus

export function buildLifecycleReviewListUrl(
  status: LifecycleStatusFilter,
  limit: number,
  cursor: LifecyclePaginationCursor | null,
): string {
  const params = new URLSearchParams({ status, limit: String(limit) })
  if (cursor?.afterRequestedAt && cursor.afterId) {
    params.set('after_requested_at', cursor.afterRequestedAt)
    params.set('after_id', cursor.afterId)
  }
  return `/api/admin/semantic-topic-lifecycle-reviews?${params.toString()}`
}

export function deriveLifecycleCursor(
  page: readonly LifecycleReviewListItem[],
  pageSize: number,
): LifecyclePaginationCursor | null {
  if (page.length < pageSize) return null
  const last = page.at(-1)
  if (!last) return null
  return { afterRequestedAt: last.requestedAt, afterId: last.reviewRequestId }
}

export function mergeLifecyclePages(
  current: readonly LifecycleReviewListItem[],
  incoming: readonly LifecycleReviewListItem[],
): LifecycleReviewListItem[] {
  const seen = new Set(current.map(item => item.reviewRequestId))
  return [...current, ...incoming.filter(item => !seen.has(item.reviewRequestId))]
}

export function filterLifecycleTransitions(
  items: readonly LifecycleReviewListItem[],
  fromStatus: LifecycleFromFilter,
  targetStatus: LifecycleTargetFilter,
): LifecycleReviewListItem[] {
  return items.filter(item => (
    (fromStatus === 'all' || item.fromStatus === fromStatus)
    && (targetStatus === 'all' || item.targetStatus === targetStatus)
  ))
}

export function formatLifecycleState(status: LifecycleFromStatus | LifecycleTargetStatus): string {
  if (status === 'coherent') return 'Koherens'
  if (status === 'ambiguous') return 'Nem egyértelmű'
  return 'Megerősítés alatt'
}

export function formatLifecycleDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Ismeretlen időpont'
  return new Intl.DateTimeFormat('hu-HU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function parseLifecycleReviewListResponse(payload: unknown): LifecycleReviewListItem[] | null {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { requests?: unknown }).requests)) return null

  const requests = (payload as { requests: unknown[] }).requests
  if (!requests.every(isLifecycleReviewListItem)) return null
  return requests
}

function isLifecycleReviewListItem(value: unknown): value is LifecycleReviewListItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.reviewRequestId === 'string'
    && typeof item.generation === 'number'
    && typeof item.semanticTopicId === 'string'
    && typeof item.topicCanonicalLabel === 'string'
    && typeof item.fromStatus === 'string'
    && FROM_STATUSES.has(item.fromStatus as LifecycleFromStatus)
    && typeof item.targetStatus === 'string'
    && TARGET_STATUSES.has(item.targetStatus as LifecycleTargetStatus)
    && typeof item.requestStatus === 'string'
    && REQUEST_STATUSES.has(item.requestStatus as LifecycleRequestStatus)
    && typeof item.requestedAt === 'string'
    && typeof item.expiresAt === 'string'
    && (item.decidedAt === null || typeof item.decidedAt === 'string')
    && (item.staleReasonCode === null || typeof item.staleReasonCode === 'string')
  )
}

export type LifecycleListError =
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'server'; message: string }

export function lifecycleListError(status: number, serverMessage?: string): LifecycleListError {
  if (status === 401) return { kind: 'unauthenticated', message: 'A munkamenet lejárt. Jelentkezz be újra a lista folytatásához.' }
  if (status === 403) return { kind: 'forbidden', message: 'Ehhez a reviewer felülethez nincs aktív jogosultságod.' }
  if (status === 404) return { kind: 'not_found', message: 'A lifecycle reviewer lista nem érhető el.' }
  if (status === 422) return { kind: 'invalid', message: serverMessage || 'A lista szűrői nem érvényesek.' }
  return { kind: 'server', message: 'A reviewer lista most nem tölthető be. Próbáld újra kézzel.' }
}
