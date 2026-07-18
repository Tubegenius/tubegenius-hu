import { CheckCircle2, AlertTriangle, TrendingUp, TrendingDown, Bookmark, CreditCard, Lock, Unlock, type LucideIcon } from 'lucide-react'

export type StatusKind =
  | 'validated'
  | 'needs_review'
  | 'warning'
  | 'high_opportunity'
  | 'low_confidence'
  | 'saved'
  | 'paid'
  | 'locked'
  | 'unlocked'

const STATUS_ICON_MAP: Record<StatusKind, { icon: LucideIcon; colorClass: string }> = {
  validated: { icon: CheckCircle2, colorClass: 'text-emerald' },
  needs_review: { icon: AlertTriangle, colorClass: 'text-amber' },
  warning: { icon: AlertTriangle, colorClass: 'text-amber' },
  high_opportunity: { icon: TrendingUp, colorClass: 'text-emerald' },
  low_confidence: { icon: TrendingDown, colorClass: 'text-text-muted' },
  saved: { icon: Bookmark, colorClass: 'text-primary' },
  paid: { icon: CreditCard, colorClass: 'text-secondary' },
  locked: { icon: Lock, colorClass: 'text-text-muted' },
  unlocked: { icon: Unlock, colorClass: 'text-emerald' },
}

interface StatusIconProps {
  kind: StatusKind
  className?: string
}

// Szemantikus státusz-ikonok (validated/needs_review/warning/stb.) egy
// helyről — a meglévő emerald/amber/rose/primary/secondary design-tokenekre
// épülve, hogy a badge-ek és állapotjelzők konzisztensek legyenek.
export default function StatusIcon({ kind, className = 'w-4 h-4' }: StatusIconProps) {
  const entry = STATUS_ICON_MAP[kind]
  const Icon = entry.icon
  return <Icon className={`${entry.colorClass} ${className}`} strokeWidth={2} aria-hidden="true" />
}
