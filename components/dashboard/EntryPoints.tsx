'use client'

import Link from 'next/link'
import type { CreatorProfile } from '@/types'

interface EntryPointsProps {
  profile: CreatorProfile | null
}

const entryPoints = [
  {
    emoji: '🚀',
    question: 'Mit csináljak ma?',
    description: 'Megmutatjuk a legjobb lehetőségeket a te nichéd alapján.',
    cta: 'Lehetőségek megmutatása',
    href: '/dashboard/opportunities',
    accent: 'violet',
    gradient: 'from-violet/10 to-transparent',
    border: 'hover:border-violet/40',
  },
  {
    emoji: '📈',
    question: 'Megéri ez a téma?',
    description: 'Validáld az ötletedet valós YouTube adatok alapján.',
    cta: 'Téma validálása',
    href: '/dashboard/viral-score',
    accent: 'emerald',
    gradient: 'from-emerald/10 to-transparent',
    border: 'hover:border-emerald/40',
  },
  {
    emoji: '🎬',
    question: 'Elemezzünk egy videót.',
    description: 'Töltsd be a linket és megmutatjuk miért ment ekkorát.',
    cta: 'Videó elemzése',
    href: '/dashboard/script-extractor',
    accent: 'amber',
    gradient: 'from-amber/10 to-transparent',
    border: 'hover:border-amber/40',
  },
]

export default function EntryPoints({ profile }: EntryPointsProps) {
  return (
    <div>
      <p className="section-label mb-3">Hol tartasz most?</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {entryPoints.map(ep => (
          <Link
            key={ep.href}
            href={ep.href}
            className={`card-hover group flex flex-col gap-3 bg-gradient-to-b ${ep.gradient} ${ep.border} transition-all duration-200`}
          >
            <span className="text-2xl">{ep.emoji}</span>
            <div>
              <h3 className="font-semibold text-text-primary mb-1 leading-snug">
                {ep.question}
              </h3>
              <p className="text-text-muted text-xs leading-relaxed">
                {ep.description}
              </p>
            </div>
            <span className={`text-xs font-medium mt-auto pt-2 border-t border-border text-text-muted group-hover:text-${ep.accent} transition-colors`}>
              {ep.cta} →
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
