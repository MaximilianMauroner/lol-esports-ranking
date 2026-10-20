import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { formatChartTimestamp, formatChartTooltipTimestamp } from '../src/shared/chartTime.ts'

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

test('chart calendar dates stay on the same day in every timezone', () => {
  for (const timezone of ['America/Los_Angeles', 'UTC', 'Asia/Tokyo']) {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { formatChartTimestamp, formatChartTooltipTimestamp } from './src/shared/chartTime.ts'
      const timestamp = Date.parse('2026-06-01')
      console.log(JSON.stringify([
        formatChartTimestamp(timestamp),
        formatChartTooltipTimestamp([{ payload: { t: timestamp } }]),
      ]))
    `], { cwd: new URL('..', import.meta.url), env: { ...process.env, TZ: timezone }, encoding: 'utf8' })

    assert.deepEqual(JSON.parse(output), ['Jun 1, 2026', 'Jun 1, 2026'], timezone)
  }
})
