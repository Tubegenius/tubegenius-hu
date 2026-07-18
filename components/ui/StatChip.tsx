import type { LucideIcon } from 'lucide-react'

interface StatChipProps {
  icon?: LucideIcon
  value: string | number
  label: string
  accentColor?: string
  className?: string
}

// Lebegő stat-pill (ikon + érték + felirat), pl. Command Centeren
// "3 aktív ötlet" vagy "194 kredit". Az accentColor tetszőleges hex/rgba
// szín lehet (platform-akcentushoz lib/platform-accent.ts-ből, vagy
// szemantikus szín a Badge-hez hasonlóan).
export default function StatChip({ icon: Icon, value, label, accentColor = '#3B82F6', className = '' }: StatChipProps) {
  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl ${className}`}
      style={{ background: `${accentColor}14`, border: `1px solid ${accentColor}33` }}
    >
      {Icon && <Icon className="w-4 h-4 flex-shrink-0" style={{ color: accentColor }} strokeWidth={2} aria-hidden="true" />}
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-semibold" style={{ color: accentColor }}>{value}</span>
        <span className="text-xs text-text-muted">{label}</span>
      </div>
    </div>
  )
}
