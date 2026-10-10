import type { ForecastBasis } from './tournamentForecast'
import type { WorldsJourneyInput } from './worldsArtifacts'
import type { SimulationOptions } from './worldsSimulation'
import type { WorldsWorkerMessage, WorldsWorkerRequest } from './worldsSimulationWorker'

type SimulationWorker = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((event: MessageEvent<WorldsWorkerMessage>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}
const baselines = new Map<string, WorldsWorkerMessage>()
/** Old handlers are invalidated before termination, so even queued messages cannot publish. */
export function startWorldsWorker(input: WorldsJourneyInput, basis: ForecastBasis | null, options: SimulationOptions,
  onMessage: (message: WorldsWorkerMessage) => void,
  createWorker: () => SimulationWorker = () => new Worker(new URL('./worldsSimulationWorker.ts', import.meta.url), { type: 'module' })) {
  let active = true
  const key = JSON.stringify([input, basis, options])
  const cached = baselines.get(key)
  if (cached) {
    queueMicrotask(() => { if (active) onMessage(cached) })
    return () => { active = false }
  }
  const worker = createWorker()
  worker.onmessage = (event) => {
    if (!active) return
    if (event.data.type === 'result' && event.data.result.status === 'supported') {
      if (baselines.size === 4) baselines.delete(baselines.keys().next().value!)
      baselines.set(key, event.data)
    }
    onMessage(event.data)
  }
  worker.onerror = (event) => { if (active) onMessage({ type: 'error', detail: event.message || 'Worlds computation failed.' }) }
  const request: WorldsWorkerRequest = { input, basis, options }
  worker.postMessage(request)
  return () => { active = false; worker.onmessage = null; worker.onerror = null; worker.terminate() }
}
