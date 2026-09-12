'use client'

interface LogoProps {
  variant?: 'full' | 'icon' | 'monochrome'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizes = {
  sm: { icon: 24, full: { w: 120, h: 24 } },
  md: { icon: 32, full: { w: 160, h: 32 } },
  lg: { icon: 48, full: { w: 240, h: 48 } },
}

function WIcon({ size = 32 }: { size?: number }) {
  return (
    <svg viewBox="0 0 44 30" width={size} height={size} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M2 5 L10 23 L19 9 L27 19 L41 3" fill="none" stroke="#F2F0E8" strokeWidth="4.5" strokeLinecap="square" strokeLinejoin="miter" />
      <path d="M27 19 L41 3" fill="none" stroke="#49CAD2" strokeWidth="4.5" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  )
}

export default function Logo({ variant = 'full', size = 'md', className }: LogoProps) {
  const s = sizes[size]

  if (variant === 'icon') {
    return (
      <div className={className}>
        <WIcon size={s.icon} />
      </div>
    )
  }

  if (variant === 'monochrome') {
    return (
      <div className={`flex items-center gap-2 ${className || ''}`}>
        <svg viewBox="0 0 44 30" width={s.icon} height={s.icon} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M2 5 L10 23 L19 9 L27 19 L41 3" fill="none" stroke="#F2F0E8" strokeWidth="4.5" strokeLinecap="square" strokeLinejoin="miter" />
        </svg>
        <span className="font-medium tracking-tight" style={{ fontSize: s.icon * 0.55, color: '#F2F0E8' }}>WillViral</span>
      </div>
    )
  }

  return (
    <div className={`flex items-center gap-2.5 ${className || ''}`}>
      <WIcon size={s.icon} />
      <span className="font-medium tracking-tight" style={{ fontSize: s.icon * 0.55, color: '#F2F0E8' }}>WillViral</span>
    </div>
  )
}
