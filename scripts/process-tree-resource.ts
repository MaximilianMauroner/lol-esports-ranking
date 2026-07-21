import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type LinuxProcessStat = {
  pid: number
  parentPid: number
  identity: string
  cpuTicks: number
  rssPages: number
}

export type ProcessTreePoint = {
  monotonicSeconds: number
  processes: LinuxProcessStat[]
}

export type IntegratedProcessTreeUsage = {
  durationSeconds: number
  vcpuSeconds: number
  rssByteSeconds: number
  peakRssBytes: number
  sampleCount: number
  sampleIntervalMs: number
  platform: 'linux-proc'
}

export function parseLinuxProcessStat(contents: string): LinuxProcessStat {
  const closingParen = contents.lastIndexOf(')')
  const openingParen = contents.indexOf('(')
  if (openingParen < 1 || closingParen <= openingParen) throw new Error('Invalid /proc stat record')
  const pid = Number(contents.slice(0, openingParen).trim())
  const fields = contents.slice(closingParen + 2).trim().split(/\s+/)
  const parentPid = Number(fields[1])
  const userTicks = Number(fields[11])
  const systemTicks = Number(fields[12])
  const startTicks = fields[19]
  const rssPages = Number(fields[21])
  if (![pid, parentPid, userTicks, systemTicks, rssPages].every(Number.isFinite) || startTicks === undefined) {
    throw new Error('Invalid numeric fields in /proc stat record')
  }
  return { pid, parentPid, identity: `${pid}:${startTicks}`, cpuTicks: userTicks + systemTicks, rssPages }
}

export function integrateProcessTreePoints(
  points: ProcessTreePoint[],
  options: { clockTicksPerSecond: number; pageSizeBytes: number; sampleIntervalMs: number },
): IntegratedProcessTreeUsage {
  if (points.length === 0) throw new Error('At least one process-tree point is required')
  const ordered = [...points].sort((left, right) => left.monotonicSeconds - right.monotonicSeconds)
  const baseline = new Map(ordered[0]!.processes.map((process) => [process.identity, process.cpuTicks]))
  const lastTicks = new Map(baseline)
  let cpuTicks = 0
  let rssByteSeconds = 0
  let priorTime = ordered[0]!.monotonicSeconds
  let priorRssBytes = sumRssBytes(ordered[0]!.processes, options.pageSizeBytes)
  let peakRssBytes = priorRssBytes

  for (const point of ordered.slice(1)) {
    const currentRssBytes = sumRssBytes(point.processes, options.pageSizeBytes)
    const elapsed = Math.max(0, point.monotonicSeconds - priorTime)
    rssByteSeconds += (priorRssBytes + currentRssBytes) / 2 * elapsed
    peakRssBytes = Math.max(peakRssBytes, currentRssBytes)
    for (const process of point.processes) {
      const previous = lastTicks.get(process.identity)
      if (previous === undefined) {
        cpuTicks += process.cpuTicks
      } else {
        cpuTicks += Math.max(0, process.cpuTicks - previous)
      }
      lastTicks.set(process.identity, process.cpuTicks)
    }
    priorTime = point.monotonicSeconds
    priorRssBytes = currentRssBytes
  }

  return {
    durationSeconds: Math.max(0, ordered.at(-1)!.monotonicSeconds - ordered[0]!.monotonicSeconds),
    vcpuSeconds: cpuTicks / options.clockTicksPerSecond,
    rssByteSeconds,
    peakRssBytes,
    sampleCount: ordered.length,
    sampleIntervalMs: options.sampleIntervalMs,
    platform: 'linux-proc',
  }
}

export async function startLinuxProcessTreeSampler(rootPid: number, sampleIntervalMs = 20) {
  if (process.platform !== 'linux') throw new Error('Process-tree resource accounting requires Linux /proc')
  const [{ stdout: ticksOutput }, { stdout: pageOutput }] = await Promise.all([
    execFileAsync('getconf', ['CLK_TCK']),
    execFileAsync('getconf', ['PAGESIZE']),
  ])
  const clockTicksPerSecond = Number(ticksOutput.trim())
  const pageSizeBytes = Number(pageOutput.trim())
  if (!(clockTicksPerSecond > 0) || !(pageSizeBytes > 0)) throw new Error('Unable to resolve Linux clock tick or page size')

  const points: ProcessTreePoint[] = []
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let inFlight = Promise.resolve()
  const sample = async () => {
    points.push({ monotonicSeconds: performance.now() / 1_000, processes: await readProcessTree(rootPid) })
  }
  await sample()
  const schedule = () => {
    timer = setTimeout(() => {
      inFlight = sample().catch(() => undefined).then(() => {
        if (!stopped) schedule()
      })
    }, sampleIntervalMs)
    timer.unref()
  }
  schedule()
  return {
    async stop(): Promise<IntegratedProcessTreeUsage> {
      stopped = true
      if (timer) clearTimeout(timer)
      await inFlight
      await sample()
      return integrateProcessTreePoints(points, { clockTicksPerSecond, pageSizeBytes, sampleIntervalMs })
    },
  }
}

async function readProcessTree(rootPid: number): Promise<LinuxProcessStat[]> {
  const pending = [rootPid]
  const visited = new Set<number>()
  const processes: LinuxProcessStat[] = []
  while (pending.length > 0) {
    const pid = pending.pop()!
    if (visited.has(pid)) continue
    visited.add(pid)
    try {
      const [stat, children] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'),
      ])
      processes.push(parseLinuxProcessStat(stat))
      for (const child of children.trim().split(/\s+/)) {
        if (child) pending.push(Number(child))
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      if (code !== 'ENOENT' && code !== 'ESRCH') throw error
    }
  }
  return processes
}

function sumRssBytes(processes: LinuxProcessStat[], pageSizeBytes: number) {
  return processes.reduce((sum, process) => sum + Math.max(0, process.rssPages) * pageSizeBytes, 0)
}
