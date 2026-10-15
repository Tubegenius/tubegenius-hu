// lib/creator-focus/eligibility.ts
// The single rule that decides whether a claim may serve as a FACT. Everything that consumes a profile
// (adapter, transitions, fit assessment) recomputes it from the claim's origin and the channel context; a
// `fact_eligible` flag that arrives with a profile is never an authority.
import { FACT_ORIGINS, type FocusChannelContext, type FocusClaim } from './contract'

export function isFactEligible(claim: Pick<FocusClaim, 'origin' | 'channel_derived'>, channel: Pick<FocusChannelContext, 'context_uncertain'>): boolean {
  if (!FACT_ORIGINS.includes(claim.origin)) return false
  if (claim.channel_derived && channel.context_uncertain) return false
  return true
}
