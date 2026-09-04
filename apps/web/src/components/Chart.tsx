import { useId } from 'react'

// Lightweight SVG line/area chart. No external dependency — used by Dashboard
// and Node pages. Accepts a flat series of numbers (0..100 semantics) and
// renders a smooth-ish polyline with an optional area fill + gradient.

export function SparkChart({
  data,
  width = '100%',
  height = 120,
  color = 'var(--accent)',
  fill = true,
  labels,
  max = 100,
}: {
  data: number[]
  width?: string | number
  height?: number
  color?: string
  fill?: boolean
  labels?: string[]
  max?: number
}) {
  const gid = useId()
  if (!data.length) return <div className="center" style={{ height, color: 'var(--text-3)' }}>No data</div>

  const w = 320
  const h = height
  const pad = 4
  const step = (w - pad * 2) / Math.max(1, data.length - 1)
  const yFor = (v: number) => h - pad - ((Math.max(0, Math.min(100, v)) / max) * (h - pad * 2))
  const pts = data.map((v, i) => [pad + i * step, yFor(v)] as const)
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ')
  const area = `${line} L${pts[pts.length - 1][0]},${h - pad} L${pad},${h - pad} Z`

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={width} height={height} role="img" preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.30" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {labels && labels.length === data.length && (
        <g fill="var(--text-muted)" fontSize="9" textAnchor="middle">
          {labels.map((l, i) => (
            <text key={i} x={pad + i * step} y={h - 1}>{l}</text>
          ))}
        </g>
      )}
    </svg>
  )
}