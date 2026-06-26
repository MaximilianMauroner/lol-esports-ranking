type SparklineProps = {
  values: number[]
  width?: number
  height?: number
  label: string
}

export function Sparkline({ values, width = 180, height = 42, label }: SparklineProps) {
  if (values.length === 0) {
    return <span className="sparkline-empty">No points</span>
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width : (index / (values.length - 1)) * width
    const y = height - ((value - min) / range) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <polyline points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
