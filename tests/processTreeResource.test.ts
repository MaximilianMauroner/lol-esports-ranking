import assert from 'node:assert/strict'
import test from 'node:test'
import { integrateProcessTreePoints, parseLinuxProcessStat } from '../scripts/process-tree-resource.ts'

function stat(pid: number, parentPid: number, user: number, system: number, start: number, rss: number) {
  const fields = Array.from({ length: 22 }, () => '0')
  fields[0] = String(parentPid)
  fields[10] = String(user)
  fields[11] = String(system)
  fields[18] = String(start)
  fields[20] = String(rss)
  return `${pid} (worker name) S ${fields.join(' ')}`
}

test('Linux stat parser handles process names containing spaces', () => {
  assert.deepEqual(parseLinuxProcessStat(stat(42, 7, 11, 13, 101, 17)), {
    pid: 42,
    parentPid: 7,
    identity: '42:101',
    cpuTicks: 24,
    rssPages: 17,
  })
})

test('process-tree integration trapezoids RSS and retains CPU from exited children', () => {
  const root0 = parseLinuxProcessStat(stat(1, 0, 100, 0, 1, 10))
  const root1 = parseLinuxProcessStat(stat(1, 0, 110, 0, 1, 20))
  const child1 = parseLinuxProcessStat(stat(2, 1, 20, 0, 2, 30))
  const root2 = parseLinuxProcessStat(stat(1, 0, 120, 0, 1, 10))
  const usage = integrateProcessTreePoints([
    { monotonicSeconds: 0, processes: [root0] },
    { monotonicSeconds: 1, processes: [root1, child1] },
    { monotonicSeconds: 2, processes: [root2] },
  ], { clockTicksPerSecond: 100, pageSizeBytes: 1_000, sampleIntervalMs: 20 })
  assert.equal(usage.vcpuSeconds, 0.4)
  assert.equal(usage.rssByteSeconds, 60_000)
  assert.equal(usage.peakRssBytes, 50_000)
  assert.equal(usage.sampleCount, 3)
})

test('process-tree integration does not recount a vanished process identity', () => {
  const root0 = parseLinuxProcessStat(stat(1, 0, 0, 0, 1, 1))
  const child1 = parseLinuxProcessStat(stat(2, 1, 20, 0, 2, 1))
  const child3 = parseLinuxProcessStat(stat(2, 1, 30, 0, 2, 1))
  const usage = integrateProcessTreePoints([
    { monotonicSeconds: 0, processes: [root0] },
    { monotonicSeconds: 1, processes: [root0, child1] },
    { monotonicSeconds: 2, processes: [root0] },
    { monotonicSeconds: 3, processes: [root0, child3] },
  ], { clockTicksPerSecond: 100, pageSizeBytes: 1_000, sampleIntervalMs: 20 })
  assert.equal(usage.vcpuSeconds, 0.3)
  assert.equal(usage.rssByteSeconds, 4_500)
})
