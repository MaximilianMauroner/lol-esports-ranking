import { spawn } from 'node:child_process'
import { refreshWorkerArgs } from './refresh-worker-memory.mjs'

const child = spawn(process.execPath, refreshWorkerArgs('scripts/refresh-data-if-changed.mjs', process.argv.slice(2)), {
  env: process.env,
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
