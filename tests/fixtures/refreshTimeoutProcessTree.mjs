import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

if (process.argv[2] === 'grandchild') {
  process.on('SIGTERM', () => {})
  process.send(process.pid)
} else {
  if (process.argv[2] === 'ignore') process.on('SIGTERM', () => {})
  const grandchild = spawn(process.execPath, [import.meta.filename, 'grandchild'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  grandchild.on('message', (pid) => writeFileSync(process.argv[3], String(pid)))
}

setInterval(() => {}, 1_000)
