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
])
