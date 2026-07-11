import type { ScheduleEvent } from './refresh-trigger-state.mjs'

export type ProbeFetcher = (url: URL, init: RequestInit) => Promise<{
  ok: boolean
  status?: number
  headers?: { get(name: string): string | null }
  json(): Promise<unknown>
}>

export type ScheduleProbe = {
  checkedAt: string
  targetWatermark: string
  coverageStart: string | null
  coverageEnd: string | null
  coverageComplete: boolean
  pageCount: number
  events: ScheduleEvent[]
}

export function fetchScheduleProbe(options?: {
  fetcher?: ProbeFetcher
  baseUrl?: string
  locale?: string
  watermark?: string | null
  now?: string | Date
  recoveryHours?: number
  maxOlderPages?: number
  requestTimeoutMs?: number
}): Promise<ScheduleProbe>
export function normalizeScheduleEvent(value: unknown): ScheduleEvent | undefined
