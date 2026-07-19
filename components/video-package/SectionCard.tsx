import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

interface SectionCardProps {
  title: string
  icon?: LucideIcon
  accent?: string
  action?: ReactNode
  children: ReactNode
}

// Tisztán prezentációs kártya-wrapper — az oldal-lokális `Block` komponens
// promotált, bővített változata. Nincs benne state, fetch, effect vagy
// storage-hívás; a meglévő Block vizuális viselkedését (háttér, border,
// cím-tipográfia) megőrzi, csak egy opcionális ikont és egy jobb felső
// action-slotot ad hozzá.
export default function SectionCard({ title, icon: Icon, accent, action, children }: SectionCardProps) {
  return (
    <div className="rounded-xl p-5" style={{ background: '#0F1420', border: `1px solid ${accent || 'rgba(255,255,255,0.08)'}` }}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon className="w-4 h-4 flex-shrink-0" style={{ color: '#94A3B8' }} aria-hidden="true" />}
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#94A3B8' }}>{title}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}
