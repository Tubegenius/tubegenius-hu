import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  ctaLabel?: string
  ctaHref?: string
  className?: string
}

// Egységes "még nincs adat" állapot minden tool oldalhoz — erős CTA-val,
// hogy a felhasználó ne egy üres listát lásson, hanem konkrét következő
// lépést.
export default function EmptyState({ icon: Icon, title, description, ctaLabel, ctaHref, className = '' }: EmptyStateProps) {
  return (
    <div className={`card flex flex-col items-center text-center py-10 px-6 ${className}`}>
      {Icon && (
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center mb-4"
          style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)' }}
        >
          <Icon className="w-6 h-6 text-primary" strokeWidth={1.75} aria-hidden="true" />
        </div>
      )}
      <p className="text-sm font-semibold text-text-primary mb-1">{title}</p>
      {description && <p className="text-xs text-text-muted max-w-sm mb-4">{description}</p>}
      {ctaLabel && ctaHref && (
        <Link href={ctaHref} className="btn-primary text-sm px-5 py-2">
          {ctaLabel}
        </Link>
      )}
    </div>
  )
}
