const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/

export function extractYouTubeVideoId(input: string): string | null {
  const value = input.trim()
  if (VIDEO_ID_PATTERN.test(value)) return value
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0]
      return id && VIDEO_ID_PATTERN.test(id) ? id : null
    }
    if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') return null
    const pathParts = url.pathname.split('/').filter(Boolean)
    const id = url.pathname === '/watch' ? url.searchParams.get('v') : (['shorts', 'embed', 'live'].includes(pathParts[0]) ? pathParts[1] : null)
    return id && VIDEO_ID_PATTERN.test(id) ? id : null
  } catch {
    return null
  }
}
