'use client'

import { ReactNode } from 'react'

interface PremiumCardProps {
  children: ReactNode
  className?: string
  hover?: boolean
  glow?: boolean
  accent?: 'blue' | 'purple' | 'green' | 'amber'
}

const accentColors = {
  blue: 'rgba(59,130,246,0.15)',
  purple: 'rgba(139,92,246,0.15)',
  green: 'rgba(34,197,94,0.15)',
  amber: 'rgba(245,158,11,0.15)',
}

export default function PremiumCard({ children, className = '', hover = false, glow = false, accent }: PremiumCardProps) {
  const baseStyle: React.CSSProperties = {
    background: '#0F1420',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 14,
    ...(glow && { boxShadow: `0 0 24px ${accent ? accentColors[accent] : 'rgba(59,130,246,0.08)'}` }),
  }

  const hoverClass = hover
    ? 'transition-all duration-200 cursor-pointer hover:-translate-y-px'
    : ''

  return (
    <div
      className={`p-5 ${hoverClass} ${className}`}
      style={baseStyle}
      onMouseEnter={hover ? (e) => {
        const el = e.currentTarget
        el.style.borderColor = accent ? accentColors[accent] : 'rgba(59,130,246,0.15)'
        el.style.boxShadow = `0 4px 24px rgba(0,0,0,0.3), 0 0 20px ${accent ? accentColors[accent] : 'rgba(59,130,246,0.1)'}`
      } : undefined}
      onMouseLeave={hover ? (e) => {
        const el = e.currentTarget
        el.style.borderColor = 'rgba(255,255,255,0.06)'
        el.style.boxShadow = glow ? `0 0 24px ${accent ? accentColors[accent] : 'rgba(59,130,246,0.08)'}` : 'none'
      } : undefined}
    >
      {children}
    </div>
  )
}
