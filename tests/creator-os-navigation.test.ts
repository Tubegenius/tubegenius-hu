import { describe, expect, it } from 'vitest'
import { CREATOR_OS_NAV_ITEMS, creatorOSSectionForPath } from '@/lib/creator-os-navigation'

describe('creator OS navigation', () => {
  it('keeps the primary architecture to five destinations', () => {
    expect(CREATOR_OS_NAV_ITEMS.map(item => item.label)).toEqual([
      'Ma',
      'Felfedezés',
      'Alkotás',
      'Tartalmak',
      'Növekedés',
    ])
  })

  it('maps only active Premium Creator OS routes into the primary sections', () => {
    expect(creatorOSSectionForPath('/dashboard')).toBe('today')
    expect(creatorOSSectionForPath('/dashboard/discover')).toBe('discover')
    expect(creatorOSSectionForPath('/dashboard/create')).toBe('create')
    expect(creatorOSSectionForPath('/dashboard/video-package/123')).toBe('create')
    expect(creatorOSSectionForPath('/dashboard/library')).toBe('library')
    expect(creatorOSSectionForPath('/dashboard/memory')).toBe('library')
    expect(creatorOSSectionForPath('/dashboard/growth')).toBe('growth')
    expect(creatorOSSectionForPath('/dashboard/channel-audit')).toBe('growth')
  })

  it('does not present preserved legacy or reviewer routes as primary Creator OS destinations', () => {
    expect(creatorOSSectionForPath('/dashboard/similar-videos')).toBeNull()
    expect(creatorOSSectionForPath('/dashboard/opportunities')).toBeNull()
    expect(creatorOSSectionForPath('/dashboard/overview')).toBeNull()
    expect(creatorOSSectionForPath('/dashboard/semantic-topic-lifecycle-reviews')).toBeNull()
  })

  it('does not misclassify account routes as a creator workflow section', () => {
    expect(creatorOSSectionForPath('/dashboard/profile')).toBeNull()
    expect(creatorOSSectionForPath('/dashboard/credits')).toBeNull()
  })
})
