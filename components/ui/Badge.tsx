import type { ReactNode } from 'react'

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

interface BadgeProps {
  variant?: BadgeVariant
  icon?: ReactNode
  children: ReactNode
  className?: string
}

const VARIANT_STYLES: Record<BadgeVariant, { bg: string; border: string; color: string }> = {
  success: { bg: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.3)', color: '#22C55E' },
  warning: { bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.3)', color: '#F59E0B' },
  danger: { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)', color: '#EF4444' },
  info: { bg: 'rgba(59,130,246,0.1)', border: 'rgba(59,130,246,0.3)', color: '#3B82F6' },
  neutral: { bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.12)', color: '#94A3B8' },
}

// Generikus szemantikus badge (validated/needs_review/warning/stb. állapotokhoz
// és tetszőleges rövid felirathoz). Az `icon` prop egy StatusIcon-t vagy
// bármilyen kész ReactNode-ot fogad, hogy ne kössük a Badge-et egy adott
// ikonrendszerhez.
export default function Badge({ variant = 'neutral', icon, children, className = '' }: BadgeProps) {
  const s = VARIANT_STYLES[variant]
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap ${className}`}
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}
    >
      {icon}
      {children}
    </span>
  )
}
