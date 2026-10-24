import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { LineChart, type ChartActiveRow } from '../../src/components/LineChart'
import '../../src/index.css'

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
  createElement(LineChart, {
    key: 'span',
    yLabel: 'Span',
    series: [{
      id: 'beta',
      label: 'Beta',
      color: '#199e70',
      points: ['2025-01-13', '2025-06-01', '2025-11-20', '2026-04-15', '2026-10-06'].map((date, index) => ({ t: Date.parse(date), y: 1500 + index * 10 })),
    }],
  }),
])
