import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { computeDimensionAverages, filterRelevantAudits, hasValidDimensionScores, hasValidOverallScore } from '@/lib/channel-audit'
import { candidateMatchesActiveChannel, candidatesForActiveChannel, isNicheReviewRequired, requiresNicheReview } from '@/lib/channel-scope'

const validScores = { hook_strength: 80, retention_potential: 70, engagement_quality: 60, platform_fit: 90, packaging_quality: 75 }

describe('channel audit evidence methodology', () => {
  it('ignores incomplete and out-of-range dimension records instead of treating fields as zero', () => {
    const result = computeDimensionAverages([
      { final_scores: validScores },
      { final_scores: { ...validScores, hook_strength: 120 } },
      { final_scores: { hook_strength: 20 } },
    ])
    expect(result).toEqual(validScores)
    expect(hasValidDimensionScores({ final_scores: validScores })).toBe(true)
    expect(hasValidDimensionScores({ final_scores: { hook_strength: 20 } })).toBe(false)
  })

  it('fails closed when no audit matches the creator niche', () => {
    const audits = [{ video_title: 'Gitárszóló kezdőknek', topic: 'zene' }]
    expect(filterRelevantAudits(audits, 'otthoni edzés fitnesz')).toEqual([])
  })

  it('accepts only finite 0-100 overall scores', () => {
    expect(hasValidOverallScore({ overall_score: 75 })).toBe(true)
    expect(hasValidOverallScore({ overall_score: Number.NaN })).toBe(false)
    expect(hasValidOverallScore({ overall_score: 101 })).toBe(false)
  })
})

describe('channel-scoped niche state', () => {
  const candidate = (sourceChannelId: string) => ({
    main_category: 'science', specific_focus: 'Biotechnologia', confidence: 0.9,
    rationale: 'A csatorna videoi ezt tamasztjak ala.', source_channel_id: sourceChannelId,
  })

  it('requires review only for a real channel change', () => {
    expect(requiresNicheReview(null, 'channel-a')).toBe(false)
    expect(requiresNicheReview('channel-a', 'channel-a')).toBe(false)
    expect(requiresNicheReview('channel-a', 'channel-b')).toBe(true)
  })

  it('accepts and displays candidates only for the active channel', () => {
    expect(candidateMatchesActiveChannel(candidate('channel-a'), 'channel-b')).toBe(false)
    expect(candidatesForActiveChannel([candidate('channel-a'), candidate('channel-b')], 'channel-b'))
      .toEqual([candidate('channel-b')])
  })

  it('detects a channel switch that happened before the review migration', () => {
    expect(isNicheReviewRequired({ storedReviewFlag: false, validatedForChannelId: null, candidates: [candidate('channel-a')], activeChannelId: 'channel-b' })).toBe(true)
    expect(isNicheReviewRequired({ storedReviewFlag: false, validatedForChannelId: 'channel-b', candidates: [candidate('channel-a')], activeChannelId: 'channel-b' })).toBe(false)
  })
})

describe('channel-scoped audit integration contracts', () => {
  const migration = readFileSync('supabase/migrations/038_channel_scoped_audits.sql', 'utf8')
  const channelAuditRoute = readFileSync('app/api/channel-audit/route.ts', 'utf8')
  const videoAuditRoute = readFileSync('app/api/video-audit/route.ts', 'utf8')
  const profileRoute = readFileSync('app/api/profile/route.ts', 'utf8')
  const reviewRoute = readFileSync('app/api/youtube/resolve-niche-review/route.ts', 'utf8')

  it('keeps legacy audits unassigned and adds only nullable channel scope', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS youtube_channel_id TEXT')
    expect(migration).toContain('niche_needs_review BOOLEAN NOT NULL DEFAULT FALSE')
    expect(migration).not.toMatch(/UPDATE\s+video_audits/i)
  })

  it('stores and reads audits with the active channel id', () => {
    expect(videoAuditRoute).toContain('youtube_channel_id: auditChannelId')
    expect(channelAuditRoute.match(/\.eq\('youtube_channel_id', activeChannelId\)/g)).toHaveLength(2)
    expect(channelAuditRoute).toContain(".is('youtube_channel_id', null)")
  })

  it('blocks review-required generation before AI and credit charging', () => {
    const reviewGate = channelAuditRoute.indexOf('channelProfileRow.niche_needs_review')
    expect(reviewGate).toBeGreaterThan(-1)
    expect(reviewGate).toBeLessThan(channelAuditRoute.indexOf('callAIProvider', reviewGate))
    expect(reviewGate).toBeLessThan(channelAuditRoute.indexOf('chargeFeature', reviewGate))
  })

  it('scopes automatic paid-result reuse while preserving explicit reopen', () => {
    expect(channelAuditRoute).toContain('normalizePaidResultInput({ activeChannelId')
    expect(channelAuditRoute.indexOf('getPaidResultById')).toBeLessThan(channelAuditRoute.indexOf(".eq('youtube_channel_id', activeChannelId)"))
  })

  it('never derives a niche during a normal profile save', () => {
    expect(profileRoute).not.toContain('discoverChannelNiches')
    expect(profileRoute).toContain('/api/youtube/resolve-niche-review')
  })

  it('accepts an explicit candidate only when it belongs to the active channel', () => {
    expect(reviewRoute).toContain('candidateMatchesActiveChannel(candidate, activeChannelId)')
    expect(reviewRoute).toContain('niche_needs_review: false')
  })
})
