import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

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
