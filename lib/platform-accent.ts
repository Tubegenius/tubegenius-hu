import type { Platform } from '@/types'

export interface PlatformAccent {
  solid: string
  soft: string
  border: string
}

// Platform-akcentus színek egy helyről — csak vizuális kiemelés (border/
// glow/ikon), a WillViral alap dark-glass design system nem változik.
const PLATFORM_ACCENTS: Record<Platform, PlatformAccent> = {
  youtube: { solid: '#EF4444', soft: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)' },
  instagram: { solid: '#DD2A7B', soft: 'rgba(221,42,123,0.1)', border: 'rgba(221,42,123,0.3)' },
  tiktok: { solid: '#25F4EE', soft: 'rgba(37,244,238,0.1)', border: 'rgba(37,244,238,0.3)' },
  facebook: { solid: '#1877F2', soft: 'rgba(24,119,242,0.1)', border: 'rgba(24,119,242,0.3)' },
}

export function getPlatformAccent(platform: Platform): PlatformAccent {
  return PLATFORM_ACCENTS[platform]
}
