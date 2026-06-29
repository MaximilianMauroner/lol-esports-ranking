import assert from 'node:assert/strict'
import test from 'node:test'
import { formatChartTimestamp, formatChartTooltipTimestamp } from '../src/lib/chartTime.ts'

test('chart timestamp formatting tolerates non-date labels', () => {
  assert.equal(formatChartTimestamp('Karmine Corp'), 'Unknown date')
  assert.equal(formatChartTooltipTimestamp([{ payload: { name: 'Karmine Corp' } }]), 'Unknown date')
})

test('chart tooltip timestamp formatting reads the x-axis value from payload', () => {
  assert.equal(
    formatChartTooltipTimestamp([{ payload: { t: Date.UTC(2026, 5, 7) } }]),
    'Jun 7, 2026',
  )
})
