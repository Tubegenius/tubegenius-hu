import type { CSSProperties, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

interface SectionCardProps {
  title: string
  icon?: LucideIcon
  accent?: string
  action?: ReactNode
  wide?: boolean
  children: ReactNode
}

// Tisztán prezentációs kártya-wrapper — az oldal-lokális `Block` komponens
// promotált, bővített változata. Nincs benne state, fetch, effect vagy
// storage-hívás; a meglévő Block vizuális viselkedését (háttér, border,
// cím-tipográfia) megőrzi, csak egy opcionális ikont és egy jobb felső
// action-slotot ad hozzá.
export default function SectionCard({ title, icon: Icon, accent, action, wide = false, children }: SectionCardProps) {
  return (
    <article
      className={`wv-package-section${wide ? ' is-wide' : ''}`}
      style={{ '--package-section-accent': accent || 'rgba(73,202,210,0.24)' } as CSSProperties}
    >
      <header className="wv-package-section-head">
        <div>
          {Icon && <Icon aria-hidden="true" />}
          <p>{title}</p>
        </div>
        {action}
      </header>
      <div className="wv-package-section-body">{children}</div>
    </article>
  )
}
