import type { StyleMeasure, StyleMetric } from '../../domains/style/profile'

export function formatStyleValue(metric: StyleMetric, value: number | null) {
  if (value === null) return 'Not recorded'
  const signed = (n: number, digits: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  switch (metric.format) {
    case 'gold': return signed(Math.round(value), 0)
    case 'cs': return signed(value, 1)
    case 'share': return `${(value * 100).toFixed(1)}%`
    case 'points': return `${signed(value * 100, 1)} pp`
    case 'rate3': return value.toFixed(3)
    case 'int': return Math.round(value).toLocaleString('en-US')
    case 'minutes': return `${value.toFixed(1)} min`
    default: return value.toFixed(2)
  }
}
export function ordinal(value: number) {
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[value % 10] ?? 'th')
  return `${value}${suffix}`
}
export function measureStatus(measure: StyleMeasure) {
  switch (measure.status) {
    case 'missing': return 'Not recorded'
    case 'few-games': return 'Under 20 games'
    case 'few-metric-games': return 'Under 20 games with this value'
    case 'small-cohort': return 'Fewer than 2 eligible peers'
    case 'ok': return `${ordinal(measure.percentile)} percentile`
  }
}
export function profileReading(measures: StyleMeasure[], compare?: StyleMeasure[], compareName?: string) {
  const ranked = measures.filter(m => m.metric.axis && m.percentile !== null).sort((a, b) => b.percentile! - a.percentile!)
  if (!ranked.length) return 'No percentile is available. Select a measure to see its value, coverage and sample limit.'
  const high = ranked.filter(m => m.percentile! >= 75).slice(0, 2)
  const low = ranked.filter(m => m.percentile! <= 25).slice(-2).reverse()
  const list = (rows: StyleMeasure[]) => rows.map(m => `${m.metric.label.toLowerCase()} (${ordinal(m.percentile!)})`).join(' and ')
  const parts = []
  if (high.length) parts.push(`Furthest out are ${list(high)}.`)
  if (low.length) parts.push(`Closest to the centre are ${list(low)}.`)
  if (!parts.length) parts.push('All measured axes are within the middle half of their peers.')
  if (compare) {
    const gaps = measures.flatMap(m => {
      const c = compare.find(c => c.metric.key === m.metric.key)
      return m.metric.axis && m.percentile !== null && c?.percentile != null ? [{ measure: m, gap: m.percentile - c.percentile }] : []
    }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 2)
    if (gaps.length) parts.push(`Largest gaps to ${compareName} are ${gaps.map(g => `${g.measure.metric.label.toLowerCase()} (${g.gap > 0 ? '+' : '−'}${Math.abs(g.gap)} points)`).join(' and ')}.`)
  }
  return parts.join(' ')
}
