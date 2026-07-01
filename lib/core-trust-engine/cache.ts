import { ENGINE_VERSION } from './types'

export function buildCacheKey(params: {
  niche: string
  platform?: string
  region: string
  language?: string
  discovery_mode?: string
  parent_niche?: string
  niche_intent?: string
}): string {
  const {
    niche,
    platform = 'youtube',
    region,
    language = 'hu',
    discovery_mode = 'standard',
    parent_niche = 'root',
    niche_intent = 'specific_topic',
  } = params

  const dateBucket = new Date().toISOString().slice(0, 10)
  return `${ENGINE_VERSION}-${discovery_mode}-${parent_niche}-${niche}-${platform}-${region}-${language}-${niche_intent}-${dateBucket}`
    .toLowerCase()
    .replace(/\s+/g, '-')
}

export function buildTrendCacheKey(params: {
  niche: string
  region: string
  niche_intent: string
  discovery_mode?: string
  parent_niche?: string
}): string {
  const {
    niche,
    region,
    niche_intent,
    discovery_mode = 'standard',
    parent_niche = 'root',
  } = params

  const dateBucket = new Date().toISOString().slice(0, 10)
  return `trend_${ENGINE_VERSION}_${discovery_mode}_${parent_niche}_${niche}_${region}_${niche_intent}_${dateBucket}`
}

export { ENGINE_VERSION }
