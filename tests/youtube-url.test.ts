import { describe, expect, it } from 'vitest'
import { extractYouTubeVideoId } from '@/lib/youtube-url'

describe('YouTube URL canonicalization', () => {
  const id = 'dQw4w9WgXcQ'
  it.each([
    `https://www.youtube.com/watch?v=${id}&t=12`,
    `https://youtu.be/${id}?si=test`,
    `https://youtube.com/shorts/${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtube.com/live/${id}`,
    id,
  ])('extracts the same video identity from %s', input => expect(extractYouTubeVideoId(input)).toBe(id))

  it('rejects lookalike and non-YouTube hosts', () => {
    expect(extractYouTubeVideoId(`https://youtube.com.example/watch?v=${id}`)).toBeNull()
    expect(extractYouTubeVideoId('https://youtube.com/watch?v=too-short')).toBeNull()
  })
})
