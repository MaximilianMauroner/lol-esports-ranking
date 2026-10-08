import { resolve } from 'node:path'
import { rawSourceWorkerExecArgv } from './refresh-worker-memory.mjs'

export function rawSourceWorkerCommand(inputPath, outputPath, env = process.env) {
  const worker = env.RANKING_RAW_SOURCE_WORKER ?? 'node'
  if (worker === 'rust') {
    return {
      command: env.RANKING_REFRESH_BINARY ?? resolve('worker/target/release/ranking-refresh'),
      args: ['raw-source', inputPath, outputPath],
    }
  }
  if (worker !== 'node') throw new Error(`Unsupported RANKING_RAW_SOURCE_WORKER: ${worker}`)
  return {
    command: process.execPath,
    args: [...rawSourceWorkerExecArgv(process.execArgv), resolve('scripts/raw-source-worker.mjs'), inputPath, outputPath],
  }
}
