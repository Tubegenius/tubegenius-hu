import { describe, expect, it } from 'vitest'
import { CREATOR_PROFILE_LANE_GUIDE, creatorProfileMarketLabel, deriveCreatorProfileFocus } from '@/lib/creator-profile-presentation'

describe('Creator profile presentation', () => {
  it('prioritizes an unresolved niche decision over a filled focus', () => {
    expect(deriveCreatorProfileFocus({ specificFocus: 'AI-alapú diagnosztika', nicheNeedsReview: true }).kind).toBe('niche_review')
  })

  it('does not invent a completeness score', () => {
    const focus = deriveCreatorProfileFocus({ specificFocus: '', nicheNeedsReview: false })
    expect(focus.kind).toBe('needs_focus')
    expect(focus.description).toContain('egyetlen kötelező')
  })

  it('uses the supplied concrete focus as the ready profile core', () => {
    expect(deriveCreatorProfileFocus({ specificFocus: '  Űrtávcsöves felfedezések  ', nicheNeedsReview: false })).toMatchObject({ kind: 'ready', title: 'Űrtávcsöves felfedezések' })
  })

  it('keeps the two creator lanes semantically distinct', () => {
    expect(CREATOR_PROFILE_LANE_GUIDE.evidence.signals).toContain('Forráskapu')
    expect(CREATOR_PROFILE_LANE_GUIDE.entertainment.signals).toContain('Jelenetritmus')
    expect(CREATOR_PROFILE_LANE_GUIDE.evidence.role).not.toBe(CREATOR_PROFILE_LANE_GUIDE.entertainment.role)
  })

  it('states the coupled market and language without extra inference', () => {
    expect(creatorProfileMarketLabel('HU', 'hu')).toBe('Magyar piac · hu')
    expect(creatorProfileMarketLabel('US', 'en')).toBe('Globális · en')
  })
})
