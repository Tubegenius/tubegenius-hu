import type { CreatorLane } from '@/lib/creator-lane-presentation'

export type CreatorStudioFormatId = 'short' | 'long'
export type CreatorStudioGoalId = 'views' | 'comments' | 'shares'

export const CREATOR_STUDIO_FORMATS = {
  short: {
    label: 'Rövid videó',
    platform: 'youtube_shorts',
    videoLength: '60sec',
    creditCost: 2,
    detail: 'YouTube Shorts · legfeljebb 60 mp',
  },
  long: {
    label: 'Hosszú videó',
    platform: 'youtube_long',
    videoLength: '6-10min',
    creditCost: 6,
    detail: 'YouTube · 6–10 perc',
  },
} as const

export const CREATOR_STUDIO_GOALS: Record<CreatorStudioGoalId, string> = {
  views: 'Nézettség',
  comments: 'Komment',
  shares: 'Megosztás',
}

interface CreatorStudioHandoffInput {
  title: string
  lane: CreatorLane
  format: CreatorStudioFormatId
  goal: CreatorStudioGoalId
}

export function buildCreatorStudioHandoffHref(input: CreatorStudioHandoffInput): string | null {
  const title = input.title.trim()
  if (!title) return null

  const format = CREATOR_STUDIO_FORMATS[input.format]
  const params = new URLSearchParams({
    topic: title,
    platform: format.platform,
    video_length: format.videoLength,
    goal: input.goal,
    creator_lane: input.lane,
    source_context: 'creator_studio',
  })

  return `/dashboard/video-package?${params.toString()}`
}

export function resolveCreatorStudioFormat(platform: string | null): CreatorStudioFormatId | null {
  if (platform === CREATOR_STUDIO_FORMATS.short.platform) return 'short'
  if (platform === CREATOR_STUDIO_FORMATS.long.platform) return 'long'
  return null
}

export function resolveCreatorStudioGoal(goal: string | null): CreatorStudioGoalId | null {
  return goal === 'views' || goal === 'comments' || goal === 'shares' ? goal : null
}

export function resolveCreatorStudioLane(lane: string | null): CreatorLane | null {
  return lane === 'evidence' || lane === 'entertainment' ? lane : null
}
