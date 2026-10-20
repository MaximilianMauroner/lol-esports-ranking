import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { LineChart } from '../../src/components/LineChart'
import '../../src/index.css'

createRoot(document.getElementById('root')!).render(createElement(LineChart, {
  persistentTooltip: true,
  series: [{
    id: 'alpha',
    label: 'Alpha',
    color: '#123456',
    points: [
      { t: Date.parse('2026-06-01'), y: 1500 },
      { t: Date.parse('2026-06-30'), y: 1600 },
    ],
  }],
}))
