import { describe, expect, it } from 'vitest'
import {
  buildCreatorStudioHandoffHref,
  CREATOR_STUDIO_FORMATS,
  resolveCreatorStudioFormat,
  resolveCreatorStudioGoal,
  resolveCreatorStudioLane,
} from '@/lib/creator-studio-presentation'

describe('creator studio presentation', () => {
  it('does not create a handoff without a project title', () => {
    expect(buildCreatorStudioHandoffHref({ title: '   ', lane: 'evidence', format: 'short', goal: 'views' })).toBeNull()
  })

  it('hands only supported video-package values to the existing frontend route', () => {
    const href = buildCreatorStudioHandoffHref({ title: '  Új videóötlet  ', lane: 'entertainment', format: 'short', goal: 'shares' })
    const url = new URL(href!, 'https://willviral.local')

    expect(url.pathname).toBe('/dashboard/video-package')
    expect(url.searchParams.get('topic')).toBe('Új videóötlet')
    expect(url.searchParams.get('platform')).toBe(CREATOR_STUDIO_FORMATS.short.platform)
    expect(url.searchParams.get('video_length')).toBe(CREATOR_STUDIO_FORMATS.short.videoLength)
    expect(url.searchParams.get('goal')).toBe('shares')
    expect(url.searchParams.get('creator_lane')).toBe('entertainment')
    expect(url.searchParams.get('source_context')).toBe('creator_studio')
  })

  it('rejects unknown incoming studio values', () => {
    expect(resolveCreatorStudioFormat('youtube_shorts')).toBe('short')
    expect(resolveCreatorStudioFormat('unknown')).toBeNull()
    expect(resolveCreatorStudioGoal('comments')).toBe('comments')
    expect(resolveCreatorStudioGoal('saves')).toBeNull()
    expect(resolveCreatorStudioLane('evidence')).toBe('evidence')
    expect(resolveCreatorStudioLane('hybrid')).toBeNull()
  })
})
