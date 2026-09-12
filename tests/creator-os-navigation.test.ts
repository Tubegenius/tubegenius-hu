import { describe, expect, it } from 'vitest'
import { CREATOR_OS_NAV_ITEMS, creatorOSSectionForPath } from '@/lib/creator-os-navigation'

describe('creator OS navigation', () => {
  it('keeps the primary architecture to five destinations', () => {
    expect(CREATOR_OS_NAV_ITEMS.map(item => item.label)).toEqual([
      'Ma',
      'Felfedezés',
      'Alkotás',
      'Könyvtár',
      'Növekedés',
    ])
  })

  it('maps legacy tool routes into the new creator-centered sections', () => {
    expect(creatorOSSectionForPath('/dashboard')).toBe('today')
    expect(creatorOSSectionForPath('/dashboard/similar-videos')).toBe('discover')
    expect(creatorOSSectionForPath('/dashboard/create')).toBe('create')
    expect(creatorOSSectionForPath('/dashboard/video-package/123')).toBe('create')
    expect(creatorOSSectionForPath('/dashboard/library')).toBe('library')
    expect(creatorOSSectionForPath('/dashboard/memory')).toBe('library')
    expect(creatorOSSectionForPath('/dashboard/growth')).toBe('growth')
    expect(creatorOSSectionForPath('/dashboard/channel-audit')).toBe('growth')
  })

  it('does not misclassify account routes as a creator workflow section', () => {
    expect(creatorOSSectionForPath('/dashboard/profile')).toBeNull()
    expect(creatorOSSectionForPath('/dashboard/credits')).toBeNull()
  })
})
