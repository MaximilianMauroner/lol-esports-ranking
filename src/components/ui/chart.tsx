import * as React from 'react'
import * as RechartsPrimitive from 'recharts'
import { cn } from '../../lib/utils'

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode
    color?: string
  }
>

type ChartContextValue = {
  config: ChartConfig
}

const ChartContext = React.createContext<ChartContextValue | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)
  if (!context) {
    throw new Error('useChart must be used within a ChartContainer')
  }
  return context
}

function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']
}) {
  const uniqueId = React.useId()
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, '')}`

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          'flex h-full w-full min-w-0 justify-center text-xs text-[var(--muted)] [&_.recharts-cartesian-axis-tick_text]:fill-[var(--faint)] [&_.recharts-cartesian-grid_line]:stroke-[var(--line)] [&_.recharts-curve.recharts-tooltip-cursor]:stroke-[var(--line-strong)]',
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={1}
          initialDimension={{ width: 1, height: 1 }}
        >
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colorEntries = Object.entries(config).filter(([, item]) => item.color)
  if (colorEntries.length === 0) return null

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
[data-chart="${id}"] {
${colorEntries.map(([key, item]) => `  --color-${key}: ${item.color};`).join('\n')}
}
`,
      }}
    />
  )
}

type TooltipPayloadItem = {
  color?: string
  dataKey?: string | number
  name?: string | number
  value?: unknown
}

function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
  className,
}: React.ComponentProps<'div'> & {
  active?: boolean
  payload?: TooltipPayloadItem[]
  label?: unknown
  labelFormatter?: (label: unknown) => React.ReactNode
  valueFormatter?: (value: unknown, name: string) => React.ReactNode
}) {
  const { config } = useChart()
  const entries = (payload ?? []).filter((entry) => entry.value !== null && entry.value !== undefined)

  if (!active || entries.length === 0) return null

  return (
    <div className={cn('chart__tooltip', className)}>
      {label !== undefined ? <b>{labelFormatter ? labelFormatter(label) : String(label)}</b> : null}
      {entries.map((entry) => {
        const key = String(entry.dataKey ?? entry.name ?? '')
        const item = config[key]
        const name = item?.label ?? entry.name ?? key
        const color = item?.color ?? entry.color ?? `var(--color-${key})`
        return (
          <span key={key}>
            <i style={{ background: color }} aria-hidden="true" />
            {name}
            <strong>{valueFormatter ? valueFormatter(entry.value, key) : String(entry.value)}</strong>
          </span>
        )
      })}
    </div>
  )
}

export { ChartContainer, ChartTooltipContent }
