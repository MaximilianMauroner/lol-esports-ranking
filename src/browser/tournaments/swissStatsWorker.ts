import { runSwissStats, type SwissStatsInput, type SwissStatsOptions, type SwissStatsResult } from '../../domains/tournaments/simulation'

export type SwissStatsRequest = { input: SwissStatsInput; options: SwissStatsOptions }
export type SwissStatsMessage =
  | { type: 'progress'; completed: number; total: number }
  | { type: 'result'; result: SwissStatsResult }
  | { type: 'error'; detail: string }

self.onmessage = (event: MessageEvent<SwissStatsRequest>) => {
  const send = (message: SwissStatsMessage) => self.postMessage(message)
  try {
    const result = runSwissStats(event.data.input, event.data.options, (completed, total) => send({ type: 'progress', completed, total }))
    send({ type: 'result', result })
  } catch (error) {
    send({ type: 'error', detail: error instanceof Error ? error.message : String(error) })
  }
}
