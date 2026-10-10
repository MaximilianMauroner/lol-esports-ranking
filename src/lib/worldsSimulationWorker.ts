import type { ForecastBasis } from './tournamentForecast'
import type { WorldsJourneyInput } from './worldsArtifacts'
import { replayWorlds2022Group, type GroupReplayResult } from './worlds2022ObservedGroups'
import { runWorldsSimulation, type SimulationOptions, type WorldsSimulationResult } from './worldsSimulation'

export type WorldsWorkerRequest = { input: WorldsJourneyInput; basis: ForecastBasis | null; options: SimulationOptions }
export type WorldsWorkerMessage =
  | { type: 'state' | 'result'; result: WorldsSimulationResult }
  | { type: 'historical'; result: GroupReplayResult }
  | { type: 'progress'; completed: number; total: number }
  | { type: 'error'; detail: string }

// One run per worker. Cancellation terminates only this owned worker, including synchronous setup.
self.onmessage = async (event: MessageEvent<WorldsWorkerRequest>) => {
  const { input, basis, options } = event.data
  const send = (message: WorldsWorkerMessage) => self.postMessage(message)
  try {
    if (input.format === 'worlds-2022-group') {
      send({ type: 'historical', result: replayWorlds2022Group(input.group) })
      return
    }
    send({ type: 'state', result: await runWorldsSimulation(input, null, options) })
    const result = await runWorldsSimulation(input, basis, options, { onProgress: (completed, total) => send({ type: 'progress', completed, total }) })
    send({ type: 'result', result })
  } catch (error) { send({ type: 'error', detail: error instanceof Error ? error.message : String(error) }) }
}
