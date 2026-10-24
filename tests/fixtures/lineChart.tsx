import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { LineChart, type ChartActiveRow, type ChartSeries } from '../../src/components/LineChart'
import '../../src/index.css'

const seasonSeries = (north: [number, number], south: number): ChartSeries[] => [
  { id: 'north', label: 'North', color: '#3987e5', points: [{ t: 2025, y: north[0] }, { t: 2026, y: north[1] }] },
  { id: 'south', label: 'South', color: '#d95926', points: [{ t: 2026, y: south }] },
]

const describeRow = (active: ChartActiveRow) =>
  `Row ${new Date(active.t).toISOString().slice(0, 10)}: ${active.points.map(({ series, point }) => `${series.label} ${point.y}`).join(', ')}`

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
    details: (active) => createElement('p', null, describeRow(active)),
  }),
  createElement(LineChart, { key: 'power', yLabel: 'Power', syncId: 'seasons', xAxis: { kind: 'year', seasons: [2025, 2026], inProgress: 2026 }, series: seasonSeries([2300, 2100], 1900) }),
  createElement(LineChart, { key: 'average', yLabel: 'Average', syncId: 'seasons', xAxis: { kind: 'year', seasons: [2025, 2026], inProgress: 2026 }, series: seasonSeries([2140, 1950], 1700) }),
  createElement(LineChart, {
    key: 'gap',
    yLabel: 'Gap',
    xAxis: { kind: 'year', seasons: [2023, 2024, 2025, 2026], inProgress: 2026 },
    series: [{ id: 'west', label: 'West', color: '#199e70', points: [{ t: 2023, y: 10 }, { t: 2025, y: 20 }, { t: 2026, y: 30 }] }],
  }),
  createElement(LineChart, {
    key: 'empty',
    yLabel: 'Pending',
    xAxis: { kind: 'year', seasons: [2024, 2025, 2026], inProgress: 2026 },
    series: [
      { id: 'east', label: 'East', color: '#c98500', points: [{ t: 2024, y: 40 }, { t: 2025, y: 50 }] },
      { id: 'north', label: 'North', color: '#3987e5', points: [{ t: 2025, y: 45 }] },
    ],
  }),
])
