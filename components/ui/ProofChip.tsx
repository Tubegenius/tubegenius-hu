import { PlayCircle, Target, Globe, type LucideIcon } from 'lucide-react'

export type ProofSourceType = 'similar_video' | 'competitor' | 'web_source'
export type ProofStrength = 'strong' | 'medium' | 'weak' | 'rejected'

const SOURCE_ICON: Record<ProofSourceType, LucideIcon> = {
  similar_video: PlayCircle,
  competitor: Target,
  web_source: Globe,
}

const STRENGTH_COLOR: Record<ProofStrength, string> = {
  strong: '#22C55E',
  medium: '#3B82F6',
  weak: '#94A3B8',
  rejected: '#EF4444',
}

interface ProofChipProps {
  sourceType: ProofSourceType
  label: string
  strength?: ProofStrength
  className?: string
}

// Kis chip egy-egy bizonyíték-jelhez (hasonló videó / competitor / web
// forrás) — a jel erőssége (strong/medium/weak/rejected) színkóddal
// jelenik meg, hogy a Command Center és a tool oldalak egységesen
// mutassák, MENNYIRE erős egy bizonyíték, nem csak hogy van-e.
export default function ProofChip({ sourceType, label, strength = 'medium', className = '' }: ProofChipProps) {
  const Icon = SOURCE_ICON[sourceType]
  const color = STRENGTH_COLOR[strength]
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium max-w-full ${className}`}
      style={{ background: `${color}1A`, border: `1px solid ${color}4D`, color }}
    >
      <Icon className="w-3.5 h-3.5 flex-shrink-0" strokeWidth={2} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  )
}
