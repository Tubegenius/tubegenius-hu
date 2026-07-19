import type { ReactNode } from 'react'

export type TagPillVariant = 'viral' | 'niche' | 'general' | 'platform' | 'neutral'

interface TagPillProps {
  children: ReactNode
  variant?: TagPillVariant
  className?: string
}

// A `general` variant szándékosan azonos színt kap, mint a `neutral`
// fallback (mindkettő #CBD5E1) — ez a jóváhagyott színterv szerinti,
// nem véletlen egyezés.
const VARIANT_STYLES: Record<TagPillVariant, { background: string; border: string; color: string }> = {
  viral: { background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#EF4444' },
  niche: { background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#3B82F6' },
  general: { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' },
  platform: { background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#3B82F6' },
  neutral: { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' },
}

// Tisztán prezentációs tag/hashtag pill — nincs state, effect, fetch,
// storage vagy handler. A children (a hashtag szövege, # jellel együtt,
// ha az már a bemeneti adat része) változtatás nélkül renderelődik.
export default function TagPill({ children, variant = 'neutral', className = '' }: TagPillProps) {
  const s = VARIANT_STYLES[variant]
  return (
    <span
      className={`text-xs px-2.5 py-1 rounded-full font-medium break-words max-w-full ${className}`}
      style={{ background: s.background, border: s.border, color: s.color }}
    >
      {children}
    </span>
  )
}
