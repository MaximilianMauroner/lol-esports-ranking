import type { PreviewTeam, ResolvedScenario, SwissStatsResult } from '../../domains/tournaments/simulation'
import { loadCurrentRatingSnapshot } from './tournamentForecastArtifacts'
import type { SwissStatsMessage, SwissStatsRequest } from './swissStatsWorker'

export type SwissStatsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'running'; completed: number; total: number }
  | { status: 'ready'; result: SwissStatsResult }
  | { status: 'error'; detail: string }
  | { status: 'cancelled' }

type StatsWorker = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((event: MessageEvent<SwissStatsMessage>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

export function startSwissStats(teams: PreviewTeam[], scenario: ResolvedScenario, onState: (state: SwissStatsState) => void,
  fetcher: typeof fetch = fetch,
  createWorker: () => StatsWorker = () => new Worker(new URL('./swissStatsWorker.ts', import.meta.url), { type: 'module' })) {
  let active = true
  let worker: StatsWorker | undefined
  const controller = new AbortController()
  const send = (state: SwissStatsState) => { if (active) onState(state) }
  const stop = () => {
    active = false
    controller.abort()
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate() }
  }
  send({ status: 'loading' })
  const missing = teams.find((team) => team.label === 'Play-In winner')
  if (missing) {
    send({ status: 'error', detail: missing.region
      ? `The ${missing.region} Play-In team is not named in the schedule yet. Choose a named Play-In winner to preview stats.`
      : 'Choose a named Play-In winner from the schedule before you preview stats.' })
    return stop
  }
  const boundedFetch: typeof fetch = (input, init) => fetcher(input, { ...init,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]) })
  void loadCurrentRatingSnapshot(boundedFetch).then(({ manifest, key, snapshot }) => {
    if (!active) return
    if (JSON.stringify(snapshot.ratingScale) !== JSON.stringify(manifest.model.ratingScale)) throw new Error('The snapshot and model rating scales disagree.')
    worker = createWorker()
    const ownedWorker = worker
    worker.onmessage = ({ data }) => {
      if (!active) return
      if (data.type === 'progress') send({ status: 'running', completed: data.completed, total: data.total })
      else {
        send(data.type === 'result' ? { status: 'ready', result: data.result } : { status: 'error', detail: data.detail })
        ownedWorker.onmessage = null
        ownedWorker.onerror = null
        ownedWorker.terminate()
        active = false
      }
    }
    worker.onerror = (event) => {
      send({ status: 'error', detail: event.message || 'Swiss stats computation failed.' })
      stop()
    }
    const request: SwissStatsRequest = {
      input: { teams, scenario, standings: snapshot.standings, model: manifest.model, provenance: {
        snapshotId: `${manifest.artifactMeta?.runId ?? manifest.generatedAt}/${key}`,
        publishedAt: manifest.generatedAt, ratingDataAsOf: manifest.coverage.latestMatchDate ?? 'unknown',
        dataMode: manifest.dataMode, sources: manifest.coverage.sourceProviders, modelVersion: manifest.model.version, modelConfigHash: manifest.model.configHash,
      } }, options: { trials: 4000, seed: 20261024 },
    }
    send({ status: 'running', completed: 0, total: request.options.trials })
    worker.postMessage(request)
  }).catch((error: unknown) => { send({ status: 'error', detail: error instanceof Error ? error.message : String(error) }); stop() })
  return stop
}
