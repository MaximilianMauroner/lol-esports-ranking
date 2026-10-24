import assert from 'node:assert/strict'
import test from 'node:test'
import { startSwissStats, type SwissStatsState } from '../src/browser/tournaments/swissStatsClient'
import type { SwissStatsMessage, SwissStatsRequest } from '../src/browser/tournaments/swissStatsWorker'
import { resolveScenario, runSwissStats, seedBaseline } from '../src/domains/tournaments/simulation'
import { rankingArtifacts } from './fixtures/swissPreviewFixtures'

const baseline = seedBaseline('LEC', 'Fnatic')
const scenario = resolveScenario(baseline, [])
const artifacts = rankingArtifacts()
const fetcher: typeof fetch = async (input) => new Response(artifacts.get(String(input).split('?')[0]), { status: artifacts.has(String(input).split('?')[0]) ? 200 : 404 })
function ownedWorker() {
  return {
    onmessage: null as ((event: MessageEvent<SwissStatsMessage>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    terminated: false, request: null as SwissStatsRequest | null,
    postMessage(request: SwissStatsRequest) { this.request = request }, terminate() { this.terminated = true },
  }
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(predicate())
}

test('the client reports real progress and terminates the one worker after its result', async () => {
  const states: SwissStatsState[] = []
  const worker = ownedWorker()
  const stop = startSwissStats(baseline.teams, scenario, (state) => states.push(state), fetcher, () => worker)
  await waitFor(() => worker.request !== null)
  assert.deepEqual(states.slice(0, 2), [{ status: 'loading' }, { status: 'running', completed: 0, total: 4000 }])
  worker.onmessage!({ data: { type: 'progress', completed: 50, total: 4000 } } as MessageEvent<SwissStatsMessage>)
  assert.deepEqual(states.at(-1), { status: 'running', completed: 50, total: 4000 })
  const result = runSwissStats(worker.request!.input, { trials: 1, seed: 1 })
  worker.onmessage!({ data: { type: 'result', result } } as MessageEvent<SwissStatsMessage>)
  assert.deepEqual(states.at(-1), { status: 'ready', result })
  assert.equal(worker.terminated, true)
  stop()
})

test('cancellation fences queued progress, errors, and results from the owned worker', async () => {
  const states: SwissStatsState[] = []
  const worker = ownedWorker()
  const stop = startSwissStats(baseline.teams, scenario, (state) => states.push(state), fetcher, () => worker)
  await waitFor(() => worker.request !== null)
  const queued = worker.onmessage!
  const queuedError = worker.onerror!
  stop()
  const before = [...states]
  queued({ data: { type: 'progress', completed: 4000, total: 4000 } } as MessageEvent<SwissStatsMessage>)
  queuedError({ message: 'old error' } as ErrorEvent)
  assert.deepEqual(states, before)
  assert.equal(worker.onmessage, null)
  assert.equal(worker.terminated, true)
})

test('cancel during delayed rating fetch aborts I/O and never creates a worker', async () => {
  let signal: AbortSignal | undefined
  let release!: () => void
  const delayed: typeof fetch = async (input, init) => {
    signal = init?.signal ?? undefined
    await new Promise<void>((resolve) => { release = resolve })
    return fetcher(input, init)
  }
  const states: SwissStatsState[] = []
  let created = 0
  const stop = startSwissStats(baseline.teams, scenario, (state) => states.push(state), delayed, () => { created++; return ownedWorker() })
  await waitFor(() => Boolean(signal))
  stop(); release()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(signal!.aborted, true)
  assert.equal(created, 0)
  assert.deepEqual(states, [{ status: 'loading' }])
})

test('unknown Play-In identity never fetches ratings, and failed reads can retry', async () => {
  let requests = 0
  const missing = seedBaseline(null)
  const states: SwissStatsState[] = []
  const never: typeof fetch = async () => { requests++; throw new Error('Unavailable') }
  startSwissStats(missing.teams, resolveScenario(missing, []), (state) => states.push(state), never)
  assert.equal(requests, 0)
  assert.equal(states.at(-1)!.status, 'error')
  const stop = startSwissStats(baseline.teams, scenario, (state) => states.push(state), never)
  await waitFor(() => states.at(-1)?.status === 'error' && requests > 0)
  stop()
  const worker = ownedWorker()
  const retry = startSwissStats(baseline.teams, scenario, (state) => states.push(state), fetcher, () => worker)
  await waitFor(() => worker.request !== null)
  assert.equal(states.at(-1)!.status, 'running')
  retry()
})

test('a snapshot scale mismatch cannot start the worker or produce estimates', async () => {
  const states: SwissStatsState[] = []
  let created = false
  const mismatched: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init)
    if (!String(input).includes('ranking-summary.json')) return response
    const manifest = await response.json()
    manifest.model.ratingScale.spreadMultiplier *= 2
    return Response.json(manifest)
  }
  const stop = startSwissStats(baseline.teams, scenario, (state) => states.push(state), mismatched, () => { created = true; return ownedWorker() })
  await waitFor(() => states.at(-1)?.status === 'error')
  assert.equal(created, false)
  assert.match((states.at(-1) as Extract<SwissStatsState, { status: 'error' }>).detail, /rating scales disagree/)
  stop()
})
