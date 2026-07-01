'use client'

interface ScoreRingProps {
  score: number
  size?: number
  label?: string
  color?: string
}

export default function ScoreRing({ score, size = 56, label, color }: ScoreRingProps) {
  const resolvedColor = color || (score >= 75 ? '#22C55E' : score >= 55 ? '#3B82F6' : score >= 40 ? '#F59E0B' : '#EF4444')
  const radius = (size - 6) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (Math.min(100, Math.max(0, score)) / 100) * circumference
  const center = size / 2

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={center} cy={center} r={radius}
            fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={3}
          />
          <circle
            cx={center} cy={center} r={radius}
            fill="none" stroke={resolvedColor} strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${center} ${center})`}
            style={{ transition: 'stroke-dashoffset 0.6s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-bold" style={{ fontSize: size * 0.3, color: resolvedColor }}>{score}</span>
        </div>
      </div>
      {label && <span className="text-xs font-medium text-text-muted">{label}</span>}
    </div>
  )
}
