import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { monthTicks } from '../src/shared/chartTime.ts'

test('chart calendar dates stay on the same day in every timezone', () => {
  for (const timezone of ['America/Los_Angeles', 'UTC', 'Asia/Tokyo']) {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { formatChartTimestamp } from './src/shared/chartTime.ts'
      const timestamp = Date.parse('2026-06-01')
      console.log(JSON.stringify([
        formatChartTimestamp(timestamp),
        formatChartTimestamp(timestamp, 'month-day'),
      ]))
    `], { cwd: new URL('..', import.meta.url), env: { ...process.env, TZ: timezone }, encoding: 'utf8' })

    assert.deepEqual(JSON.parse(output), ['Jun 1, 2026', 'Jun 1'], timezone)
  }
})


test('long chart axes use UTC month starts across years', () => {
  assert.deepEqual(monthTicks(Date.parse('2025-03-20'), Date.parse('2026-10-06')),
    ['2025-05-01', '2025-09-01', '2026-01-01', '2026-05-01', '2026-09-01'].map(Date.parse))
  assert.deepEqual(monthTicks(Date.parse('2026-01-01'), Date.parse('2026-04-01')),
    ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'].map(Date.parse))
  assert.equal(monthTicks(Date.parse('2026-06-01'), Date.parse('2026-06-30')), undefined)
})
