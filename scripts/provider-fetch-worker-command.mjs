import { resolve } from 'node:path'

export function providerFetchWorkerCommand(args, env = process.env) {
  const worker = env.RANKING_PROVIDER_FETCH_WORKER ?? 'node'
  if (worker === 'rust') {
    return {
      command: env.RANKING_REFRESH_BINARY ?? resolve('worker/target/release/ranking-refresh'),
      args: ['fetch', ...args],
    }
  }
  if (worker !== 'node') throw new Error(`Unsupported RANKING_PROVIDER_FETCH_WORKER: ${worker}`)
  return { command: process.execPath, args: ['scripts/download-local-data.mjs', ...args] }
}
