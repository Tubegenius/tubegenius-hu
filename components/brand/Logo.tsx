interface LogoProps {
  variant?: 'full' | 'icon' | 'monochrome'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizes = {
  sm: { icon: 24, wordmark: 16 },
  md: { icon: 32, wordmark: 20 },
  lg: { icon: 48, wordmark: 30 },
}

function MomentumMark({ size = 32, monochrome = false }: { size?: number; monochrome?: boolean }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M12 31 L30 73 L49 49 L64 65 L89 22"
        fill="none"
        stroke={monochrome ? 'currentColor' : '#C8F135'}
        strokeWidth="10"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
      {!monochrome && (
        <path
          d="M82.5 33.2 L89 22"
          fill="none"
          stroke="#49CAD2"
          strokeWidth="10"
          strokeLinecap="square"
        />
      )}
    </svg>
  )
}

export default function Logo({ variant = 'full', size = 'md', className }: LogoProps) {
  const s = sizes[size]

  if (variant === 'icon') {
    return (
      <div className={className}>
        <MomentumMark size={s.icon} />
      </div>
    )
  }

  if (variant === 'monochrome') {
    return (
      <div className={`flex items-center gap-2 text-current ${className || ''}`}>
        <MomentumMark size={s.icon} monochrome />
        <span style={{ fontSize: s.wordmark, fontWeight: 500, letterSpacing: '-0.055em', lineHeight: 1 }}>WillViral</span>
      </div>
    )
  }

  return (
    <div className={`flex items-center gap-2 ${className || ''}`}>
      <MomentumMark size={s.icon} />
      <span style={{ fontSize: s.wordmark, fontWeight: 500, letterSpacing: '-0.055em', lineHeight: 1, color: '#F2F0E8' }}>
        Will<span style={{ color: '#C8F135' }}>Viral</span>
      </span>
    </div>
  )
}
