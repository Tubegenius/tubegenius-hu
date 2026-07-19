import { Activity, Flame, Package, Lightbulb, PlayCircle, Brain, CreditCard, type LucideIcon } from 'lucide-react'

export type FeatureKey =
  | 'channel-audit'
  | 'viral-score'
  | 'video-package'
  | 'opportunity'
  | 'similar-videos'
  | 'memory'
  | 'credits'

const FEATURE_ICON_MAP: Record<FeatureKey, LucideIcon> = {
  'channel-audit': Activity,
  'viral-score': Flame,
  'video-package': Package,
  opportunity: Lightbulb,
  'similar-videos': PlayCircle,
  memory: Brain,
  credits: CreditCard,
}

interface FeatureIconProps {
  feature: FeatureKey
  className?: string
}

// Nagy feature-kártyák ikonjai egy helyről (Channel Audit, Viral Score,
// Video Package, Opportunity, Similar Videos, Creator Memory) — a
// prémiumosított tool oldalak (5. kör) ezt fogják használni.
export default function FeatureIcon({ feature, className = 'w-6 h-6' }: FeatureIconProps) {
  const Icon = FEATURE_ICON_MAP[feature]
  return <Icon className={className} strokeWidth={1.75} aria-hidden="true" />
}
