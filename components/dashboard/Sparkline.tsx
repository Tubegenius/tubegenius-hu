'use client'

// Kis inline sparkline — kizárólag valós, mért idősor adatból rajzol.
// Ha nincs elég adatpont (< 2), semmit nem renderel (nincs kamu görbe).

interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  color?: string
}

export default function Sparkline({ values, width = 64, height = 20, color = '#3B82F6' }: SparklineProps) {
  if (!values || values.length < 2) return null

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const step = width / (values.length - 1)

  const points = values.map((v, i) => {
    const x = i * step
    const y = height - ((v - min) / range) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  const rising = values[values.length - 1] >= values[0]

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block align-middle">
      <polyline
        points={points}
        fill="none"
        stroke={color || (rising ? '#4ADE80' : '#F87171')}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
