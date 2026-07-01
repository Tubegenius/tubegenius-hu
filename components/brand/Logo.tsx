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
    <svg viewBox="0 0 512 512" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="wg-i" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3B82F6"/>
          <stop offset="100%" stopColor="#8B5CF6"/>
        </linearGradient>
        <linearGradient id="wh-i" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.6"/>
          <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="96" fill="#080B12"/>
      <path d="M128 160 L192 352 L256 220 L320 352 L384 160" fill="none" stroke="url(#wg-i)" strokeWidth="36" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M320 352 L384 160" fill="none" stroke="url(#wh-i)" strokeWidth="36" strokeLinecap="round"/>
      <circle cx="384" cy="155" r="8" fill="#22D3EE" opacity="0.9"/>
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
        <svg viewBox="0 0 512 512" width={s.icon} height={s.icon} xmlns="http://www.w3.org/2000/svg">
          <path d="M128 160 L192 352 L256 220 L320 352 L384 160" fill="none" stroke="#F8FAFC" strokeWidth="36" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="font-bold tracking-tight" style={{ fontSize: s.icon * 0.55, color: '#F8FAFC' }}>WillViral</span>
      </div>
    )
  }

  return (
    <div className={`flex items-center gap-2.5 ${className || ''}`}>
      <WIcon size={s.icon} />
      <span className="font-bold tracking-tight" style={{ fontSize: s.icon * 0.55 }}>
        <span style={{ color: '#F8FAFC' }}>Will</span>
        <span style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Viral</span>
      </span>
    </div>
  )
}
