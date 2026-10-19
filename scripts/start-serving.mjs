import { spawn } from 'node:child_process'

const children = new Set()
let stopping = false
let exitCode = 0
let killTimer

function stop(code) {
  if (stopping) return
  stopping = true
  exitCode = code
  for (const child of children) child.kill('SIGTERM')
  killTimer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL')
  }, 10_000)
  killTimer.unref()
}

function start(command, args, env = process.env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'inherit'] })
  child.stdout.pipe(process.stdout, { end: false })
  children.add(child)
  child.once('error', () => {
    console.error('Serving process failed to start')
    stop(1)
  })
  child.once('close', () => {
    children.delete(child)
    if (!stopping) stop(1)
    if (children.size === 0) {
      clearTimeout(killTimer)
      process.exitCode = exitCode
    }
  })
  return child
}

process.on('SIGTERM', () => stop(0))
process.on('SIGINT', () => stop(0))

const native = start(process.env.RANKING_NATIVE_HTTP_BINARY ?? '/usr/local/bin/platform-api', [
  '--data-root', process.env.RANKING_PUBLIC_DATA_DIR ?? 'public/data',
  '--listen', '127.0.0.1:0', '--ranking-origin',
])

const nativePort = await new Promise(resolve => {
  let output = ''
  const finish = port => {
    clearTimeout(timer)
    native.stdout.off('data', listening)
    native.off('close', closed)
    resolve(port)
  }
  const closed = () => finish(undefined)
  const listening = chunk => {
    output += String(chunk)
    if (output.length > 4096) return finish(undefined)
    if (!output.includes('\n')) return
    try {
      const event = JSON.parse(output.split('\n')[0])
      const address = new URL(`http://${event.address}`)
      finish(event.event === 'listening' && address.hostname === '127.0.0.1' && Number(address.port) > 0
        ? Number(address.port) : undefined)
    } catch {
      finish(undefined)
    }
  }
  const timer = setTimeout(closed, 15_000)
  native.stdout.on('data', listening)
  native.once('close', closed)
})
if (!stopping) {
  if (nativePort) {
    start(process.execPath, ['scripts/railway-server.mjs'], { ...process.env, RANKING_NATIVE_DATA_PORT: String(nativePort) })
  } else {
    console.error('Native data service did not become live')
    stop(1)
  }
}
