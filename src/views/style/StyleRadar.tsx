import type { CSSProperties } from 'react'
import { Castle, Clock, Coins, Crosshair, Crown, Eye, EyeOff, Flame, Shield, Sword, Swords, Target, Users, Wheat, type LucideIcon } from 'lucide-react'
import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer } from 'recharts'
import type { RadarPoint } from 'recharts/types/polar/Radar'
import { Button } from '../../components/ui/button'
import type { StyleMeasure } from '../../domains/style/profile'

type ShapeProps = { points?: RadarPoint[]; measures: StyleMeasure[]; selected: string; series: 'a' | 'b' }

const metricIcons: Record<string, LucideIcon> = {
  goldDiffAt15: Coins,
  csPerMinute: Wheat,
  damagePerMinute: Sword,
  damageGoldShareGap: Target,
  killParticipation: Users,
  deathsPerMinute: Shield,
  wardsPlacedPerMinute: Eye,
  wardsClearedPerMinute: EyeOff,
  fullTeamGoldDiffAt15: Coins,
  teamKillsPerMinute: Crosshair,
  combinedKillsPerMinute: Swords,
  towersPerGame: Castle,
  dragonsPerGame: Flame,
  baronsPerGame: Crown,
  gameMinutes: Clock,
}

export function OpenRadarShape({ points = [], measures, selected, series }: ShapeProps) {
  const present = points.map((point, i) => measures[i]?.percentile != null ? point : null)
  const closed = present.length === measures.length && present.length > 2 && present.every(point => point !== null)
  const path = closed ? `${present.map((p, i) => `${i ? 'L' : 'M'}${p!.x},${p!.y}`).join(' ')} Z`
    : present.flatMap((point, i) => {
      const next = present[(i + 1) % present.length]
      return point && next ? [`M${point.x},${point.y} L${next.x},${next.y}`] : []
    }).join(' ')
  return <g className={`style-shape style-series-${series}`} data-closed={closed}>
    <path d={path} fill={closed ? `var(--style-fill-${series})` : 'none'} />
    {present.map((point, i) => point ? <circle key={measures[i].metric.key} cx={point.x} cy={point.y}
      r={measures[i].metric.key === selected ? 4.5 : 3} className={measures[i].metric.key === selected ? 'style-vertex-selected' : ''} /> : null)}
  </g>
}

export function StyleRadar({ measures, compare, selected, onSelect, name, compareName }: {
  measures: StyleMeasure[]; compare?: StyleMeasure[]; selected: string; onSelect: (key: string) => void; name: string; compareName?: string
}) {
  const axes = measures.filter(m => m.metric.axis)
  const comparisons = compare?.filter(m => m.metric.axis)
  const hasPrimaryPercentiles = axes.some(m => m.percentile !== null)
  const hasPlot = hasPrimaryPercentiles || comparisons?.some(m => m.percentile !== null)
  const data = axes.map((m, i) => ({ key: m.metric.key, primary: m.percentile, comparison: comparisons?.[i].percentile ?? null }))
  const summary = (label: string, rows: StyleMeasure[]) => `${label}. ${rows.map(m => `${m.metric.label}, ${m.percentile === null ? 'no percentile' : `${m.percentile} percentile`}`).join('. ')}`
  return <div className={`style-radar${hasPrimaryPercentiles ? '' : ' style-radar-unavailable'}`} role="group" aria-label={`${summary(name, axes)}${comparisons ? `. ${summary(compareName!, comparisons)}` : ''}`}>
    {!hasPrimaryPercentiles ? <p className="style-radar-empty">No percentile shape is available for {name}. Raw values are in All measures, below the selected measure.</p> : null}
    <div className="style-plot">
    {hasPlot ? <div className="style-radar-canvas">
    <svg className="style-bands" viewBox="0 0 100 100" aria-hidden="true">
      {[1, 0.75, 0.5, 0.25].map((fraction, band) => <polygon key={fraction} points={axes.map((_, i) => {
        const angle = -Math.PI / 2 + i * Math.PI * 2 / axes.length
        return `${50 + 35 * fraction * Math.cos(angle)},${50 + 35 * fraction * Math.sin(angle)}`
      }).join(' ')} className={`style-band-${band % 2}${fraction === 0.5 ? ' style-ring-median' : ''}`} />)}
    </svg>
    <div className="style-chart" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} cx="50%" cy="50%" outerRadius="70%" accessibilityLayer={false}>
          <PolarGrid gridType="polygon" radialLines={false} stroke="var(--line-strong)" fill="none" />
          <PolarAngleAxis dataKey="key" tick={false} axisLine={false} />
          <PolarRadiusAxis domain={[0, 100]} ticks={[25, 50, 75, 100]} tick={false} axisLine={false} />
          {comparisons ? <Radar dataKey="comparison" isAnimationActive={false} activeDot={false}
            shape={<OpenRadarShape measures={comparisons} selected={selected} series="b" />} /> : null}
          <Radar dataKey="primary" isAnimationActive={false} activeDot={false}
            shape={<OpenRadarShape measures={axes} selected={selected} series="a" />} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
    <svg className="style-spokes" viewBox="0 0 100 100" aria-hidden="true">
      {axes.map((m, i) => {
        const angle = -Math.PI / 2 + i * Math.PI * 2 / axes.length
        return <line key={m.metric.key} x1="50" y1="50" x2={50 + 35 * Math.cos(angle)} y2={50 + 35 * Math.sin(angle)}
          className={`${m.percentile === null ? 'style-spoke-missing' : ''} ${selected === m.metric.key ? 'style-spoke-selected' : ''}`} />
      })}
    </svg>
    {axes.map((m, i) => {
      const angle = -Math.PI / 2 + i * Math.PI * 2 / axes.length
      const x = Math.cos(angle), y = Math.sin(angle)
      const Icon = metricIcons[m.metric.key]
      const labelPosition = Math.abs(x) < 0.25 && y < 0 ? 'style-axis-short-side' : y < -0.25 ? 'style-axis-short-above' : ''
      return <span key={m.metric.key} className="style-axis-symbol" aria-hidden="true" data-selected={selected === m.metric.key}
        style={{ left: `${50 + 43 * x}%`, top: `${50 + 43 * y}%` }}>
        <Icon size={18} />
        <span className={`style-axis-caption ${labelPosition}`}>
          <span className="style-axis-short">{m.metric.short ?? m.metric.label}</span>
          <span className="style-axis-percentiles"><span className="style-text-a">{m.percentile ?? 'n/a'}</span>
            {comparisons ? <><span>/</span><span className="style-text-b">{comparisons[i].percentile ?? 'n/a'}</span></> : null}</span>
        </span>
      </span>
    })}
    </div> : null}
    <div className="style-axis-controls">
    {axes.map((m, i) => {
      const angle = -Math.PI / 2 + i * Math.PI * 2 / axes.length
      const x = Math.cos(angle), y = Math.sin(angle)
      const align = x > 0.25 ? 'start' : x < -0.25 ? 'end' : 'center'
      const Icon = metricIcons[m.metric.key]
      return <Button key={m.metric.key} variant="ghost" className={`style-axis style-ray-label style-align-${align}${m.percentile === null ? ' style-axis-unavailable' : ''}`} aria-pressed={selected === m.metric.key}
        data-selected={selected === m.metric.key}
        aria-controls="style-inspector" aria-label={`${m.metric.label}. ${m.percentile === null ? 'No percentile' : `${m.percentile} percentile`}`}
        style={{ '--style-axis-x': `${50 + 33 * x}%`, '--style-axis-y': `${50 + 33 * y}%`,
          '--style-axis-transform': `translate(${x > 0.25 ? '0' : x < -0.25 ? '-100%' : '-50%'}, ${y < -0.6 ? '-100%' : y > 0.6 ? '0' : '-50%'})` } as CSSProperties}
        onClick={() => onSelect(m.metric.key)}>
        <span className="style-axis-full"><Icon className="style-axis-icon" size={16} aria-hidden="true" /><span>{m.metric.label}</span></span>
        <span className="style-axis-values"><span className={m.percentile === null ? 'style-text-a style-ray-status' : 'style-text-a'}>{m.percentile ?? (m.status === 'missing' ? 'No data' : m.status === 'small-cohort' ? 'Small cohort' : 'Too few games')}</span>
          {comparisons ? <span className="style-text-b">{comparisons[i].percentile ?? 'n/a'}</span> : null}</span>
      </Button>
    })}
    </div>
    </div>
  </div>
}
