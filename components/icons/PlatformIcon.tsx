import { Youtube, Instagram, Facebook } from 'lucide-react'
import type { Platform } from '@/types'
import { getPlatformAccent } from '@/lib/platform-accent'

// Nem telepítünk új npm/brand-icon csomagot ehhez — YouTube/Instagram/
// Facebook a már meglévő lucide-react készletből jön, TikTok-hoz nincs
// hivatalos lucide ikon, ott egy egyszerű monogram-badge kerül (nem emoji,
// nem brand-asset). A színek a közös lib/platform-accent.ts-ből jönnek.
interface PlatformIconProps {
  platform: Platform
  className?: string
}

export default function PlatformIcon({ platform, className = 'w-4 h-4' }: PlatformIconProps) {
  const accent = getPlatformAccent(platform)

  if (platform === 'youtube') {
    return <Youtube className={className} style={{ color: accent.solid }} strokeWidth={2} aria-hidden="true" />
  }
  if (platform === 'instagram') {
    return <Instagram className={className} style={{ color: accent.solid }} strokeWidth={2} aria-hidden="true" />
  }
  if (platform === 'facebook') {
    return <Facebook className={className} style={{ color: accent.solid }} strokeWidth={2} aria-hidden="true" />
  }

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-bold ${className}`}
      style={{ background: accent.soft, color: accent.solid, fontSize: '0.6em', lineHeight: 1 }}
      aria-hidden="true"
    >
      TT
    </span>
  )
}
