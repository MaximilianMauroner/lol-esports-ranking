export const REFRESH_WORKER_MAX_OLD_SPACE_MB: 384
export const RAW_SOURCE_WORKER_MAX_OLD_SPACE_MB: 512
export const REFRESH_WORKER_MAX_SEMI_SPACE_MB: 8
export function refreshWorkerExecArgv(inherited?: readonly string[]): string[]
export function rawSourceWorkerExecArgv(inherited?: readonly string[]): string[]
export function refreshWorkerArgs(script: string, args?: readonly string[], inherited?: readonly string[]): string[]
export function collectRefreshGarbage(): { heapUsedBytes: number; heapTotalBytes: number; rssBytes: number }
