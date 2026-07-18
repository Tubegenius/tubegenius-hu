import { Youtube, Instagram, Facebook } from 'lucide-react'
import type { Platform } from '@/types'

// Nem telepítünk új npm/brand-icon csomagot ehhez — YouTube/Instagram/
// Facebook a már meglévő lucide-react készletből jön, TikTok-hoz nincs
// hivatalos lucide ikon, ott egy egyszerű monogram-badge kerül (nem emoji,
// nem brand-asset).
const PLATFORM_ACCENT: Record<Platform, string> = {
  youtube: '#EF4444',
  instagram: '#DD2A7B',
  tiktok: '#25F4EE',
  facebook: '#1877F2',
}

interface PlatformIconProps {
  platform: Platform
  className?: string
}

export default function PlatformIcon({ platform, className = 'w-4 h-4' }: PlatformIconProps) {
  const color = PLATFORM_ACCENT[platform]

  if (platform === 'youtube') {
    return <Youtube className={className} style={{ color }} strokeWidth={2} aria-hidden="true" />
  }
  if (platform === 'instagram') {
    return <Instagram className={className} style={{ color }} strokeWidth={2} aria-hidden="true" />
  }
  if (platform === 'facebook') {
    return <Facebook className={className} style={{ color }} strokeWidth={2} aria-hidden="true" />
  }

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-bold ${className}`}
      style={{ background: 'rgba(37,244,238,0.14)', color, fontSize: '0.6em', lineHeight: 1 }}
      aria-hidden="true"
    >
      TT
    </span>
  )
}
