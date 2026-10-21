import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { LineChart, type ChartSeries } from '../../src/components/LineChart'
import '../../src/index.css'

const seasonSeries = (north: [number, number], south: number): ChartSeries[] => [
  { id: 'north', label: 'North', color: '#3987e5', points: [{ t: 2025, y: north[0] }, { t: 2026, y: north[1] }] },
  { id: 'south', label: 'South', color: '#d95926', points: [{ t: 2026, y: south }] },
]

createRoot(document.getElementById('root')!).render([
  createElement(LineChart, {
    key: 'calendar',
    series: [{
      id: 'alpha',
      label: 'Alpha',
      color: '#123456',
      points: [
        { t: Date.parse('2026-06-01'), y: 1500 },
        { t: Date.parse('2026-06-30'), y: 1600 },
      ],
    }],
  }),
  createElement(LineChart, { key: 'power', yLabel: 'Power', syncId: 'seasons', xAxis: { kind: 'year', inProgress: 2026 }, series: seasonSeries([2300, 2100], 1900) }),
  createElement(LineChart, { key: 'average', yLabel: 'Average', syncId: 'seasons', xAxis: { kind: 'year', inProgress: 2026 }, series: seasonSeries([2140, 1950], 1700) }),
])
