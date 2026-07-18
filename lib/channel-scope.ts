import type { NicheCandidate } from '@/types'

export function requiresNicheReview(previousChannelId: string | null, nextChannelId: string | null): boolean {
  return Boolean(previousChannelId && nextChannelId && previousChannelId !== nextChannelId)
}

export function candidateMatchesActiveChannel(
  candidate: Pick<NicheCandidate, 'source_channel_id'>,
  activeChannelId: string | null,
): boolean {
  return Boolean(activeChannelId && candidate.source_channel_id === activeChannelId)
}

export function candidatesForActiveChannel(
  candidates: NicheCandidate[] | null | undefined,
  activeChannelId: string | null,
): NicheCandidate[] {
  if (!Array.isArray(candidates) || !activeChannelId) return []
  return candidates.filter(candidate => candidateMatchesActiveChannel(candidate, activeChannelId))
}

export function isNicheReviewRequired(params: {
  storedReviewFlag: boolean
  validatedForChannelId: string | null
  candidates: NicheCandidate[] | null | undefined
  activeChannelId: string | null
}): boolean {
  if (params.storedReviewFlag) return true
  if (!params.activeChannelId || params.validatedForChannelId === params.activeChannelId) return false
  if (!Array.isArray(params.candidates) || params.candidates.length === 0) return false
  return candidatesForActiveChannel(params.candidates, params.activeChannelId).length === 0
}
