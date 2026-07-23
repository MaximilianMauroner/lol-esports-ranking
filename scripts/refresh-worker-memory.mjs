export const REFRESH_WORKER_MAX_OLD_SPACE_MB = 2048
export const RAW_SOURCE_WORKER_MAX_OLD_SPACE_MB = 2048
export const REFRESH_WORKER_MAX_SEMI_SPACE_MB = 8

/** Full refreshes materialize ranking history; unchanged probes remain small despite this ceiling. */
export function refreshWorkerExecArgv(inherited = process.execArgv) {
  return workerExecArgv(inherited, REFRESH_WORKER_MAX_OLD_SPACE_MB)
}

/** Raw authority work briefly materializes the full Oracle corpus alongside compressed source objects. */
export function rawSourceWorkerExecArgv(inherited = process.execArgv) {
  return workerExecArgv(inherited, RAW_SOURCE_WORKER_MAX_OLD_SPACE_MB)
}

function workerExecArgv(inherited, maxOldSpaceMb) {
  const retained = []
  for (let index = 0; index < inherited.length; index += 1) {
    const value = inherited[index]
    if (value === '--expose-gc') continue
    if (value === '--max-old-space-size' || value === '--max_old_space_size') {
      index += 1
      continue
    }
    if (value.startsWith('--max-old-space-size=') || value.startsWith('--max_old_space_size=')) continue
    if (value === '--max-semi-space-size' || value === '--max_semi_space_size') {
      index += 1
      continue
    }
    if (value.startsWith('--max-semi-space-size=') || value.startsWith('--max_semi_space_size=')) continue
    if (value === '--import' && inherited[index + 1] === 'tsx') {
      index += 1
      continue
    }
    if (value === '--import=tsx') continue
    retained.push(value)
  }
  return [
    ...retained,
    `--max-old-space-size=${maxOldSpaceMb}`,
    `--max-semi-space-size=${REFRESH_WORKER_MAX_SEMI_SPACE_MB}`,
    '--expose-gc',
    '--import=tsx',
  ]
}

export function refreshWorkerArgs(script, args = [], inherited = process.execArgv) {
  return [...refreshWorkerExecArgv(inherited), script, ...args]
}

export function collectRefreshGarbage() {
  globalThis.gc?.()
  const memory = process.memoryUsage()
  return {
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    rssBytes: memory.rss,
  }
}
