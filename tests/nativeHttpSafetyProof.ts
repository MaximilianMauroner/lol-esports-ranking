import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, open, readlink, readdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { httpRead, nativeServer } from './nativeHttpHelpers.ts'

async function socketTo(port: number) {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  return socket
}

function firstBytes(socket: Socket) {
  return new Promise<Buffer>((accept, reject) => {
    socket.once('data', accept)
    socket.once('error', reject)
    socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error('Socket response timed out')) })
  })
}

test('native refuses symlinks, directories and FIFOs and pins the root across replacement', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'native-safety-'))
  const root = join(fixture, 'root')
  const moved = join(fixture, 'moved')
  const external = join(fixture, 'external')
  await mkdir(root)
  await mkdir(external)
  await writeFile(join(root, 'ranking-summary.json'), 'original')
  await writeFile(join(external, 'secret.json'), 'external secret')
  await mkdir(join(root, 'directory'))
  await symlink(join(external, 'secret.json'), join(root, 'leaf.json'))
  await symlink(external, join(root, 'ancestor'))
  await symlink(join(root, 'ranking-summary.json'), join(root, 'internal.json'))
  await promisify(execFile)('mkfifo', [join(root, 'fifo.json')])
  const server = await nativeServer(root)
  try {
    for (const path of ['leaf.json', 'ancestor/secret.json', 'internal.json', 'directory', 'fifo.json']) {
      const response = await httpRead(server.port, `/data/${path}`)
      assert.equal(response.status, 404, path)
      assert.equal(response.headers['x-robots-tag'], 'noindex')
      assert.doesNotMatch(response.body.toString(), /external secret|native-safety/)
    }
    await rename(root, moved)
    await mkdir(root)
    await writeFile(join(root, 'ranking-summary.json'), 'replacement pathname')
    assert.equal((await httpRead(server.port, '/data/ranking-summary.json')).body.toString(), 'original')
    assert.equal((await httpRead(server.port, '/api/ready')).status, 200)
    await writeFile(join(moved, 'next.json'), 'new atomic bytes')
    await rename(join(moved, 'next.json'), join(moved, 'ranking-summary.json'))
    assert.equal((await httpRead(server.port, '/data/ranking-summary.json')).body.toString(), 'new atomic bytes')
    await rm(join(moved, 'ranking-summary.json'))
    await symlink(join(external, 'secret.json'), join(moved, 'ranking-summary.json'))
    assert.equal((await httpRead(server.port, '/api/ready')).status, 503)
    assert.equal((await httpRead(server.port, '/data/ranking-summary.json')).status, 404)
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const directory = join(moved, 'swap')
      await mkdir(directory)
      await writeFile(join(directory, 'file.json'), 'inside')
      const reading = httpRead(server.port, '/data/swap/file.json')
      await rename(directory, join(moved, 'held'))
      await symlink(external, directory)
      const response = await reading
      assert.ok(response.status === 404 || response.status === 200)
      if (response.status === 200) assert.equal(response.body.toString(), 'inside')
      await rm(directory)
      await rm(join(moved, 'held'), { recursive: true })
    }
  } finally {
    await server.close()
    await rm(fixture, { recursive: true, force: true })
  }
})

test('native sockets reject invalid framing and close unread request bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-framing-'))
  const server = await nativeServer(root)
  try {
    for (const wire of [
      'POST /data/file HTTP/1.1\r\nHost: local\r\nContent-Length: 1000000\r\n\r\n',
      'POST /data/file HTTP/1.1\r\nHost: local\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n',
      `GET /data/file HTTP/1.1\r\nHost: local\r\nX-Large: ${'x'.repeat(40_000)}\r\n\r\n`,
    ]) {
      const socket = await socketTo(server.port)
      try {
        const reading = firstBytes(socket)
        socket.write(wire)
        const response = (await reading).toString()
        assert.match(response, /HTTP\/1\.1 (400|405|431)/)
        assert.match(response.toLowerCase(), /connection: close/)
        if (!socket.destroyed) await once(socket, 'close')
      } finally { socket.destroy() }
    }
    assert.equal((await httpRead(server.port, '/api/live')).status, 200)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('native active connection admission stays bounded and shutdown drains idle sockets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-admission-'))
  const server = await nativeServer(root)
  const sockets: Socket[] = []
  let closed = false
  try {
    for (let index = 0; index < 64; index += 1) sockets.push(await socketTo(server.port))
    let completed = false
    const pending = httpRead(server.port, '/api/live').then((value) => { completed = true; return value })
    await new Promise((accept) => setTimeout(accept, 100))
    assert.equal(completed, false)
    sockets.pop()!.destroy()
    assert.equal((await pending).status, 200)
    for (const socket of sockets) socket.destroy()
    await server.close()
    closed = true
  } finally {
    for (const socket of sockets) socket.destroy()
    if (!closed) await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('native cancelled identity and gzip streams release their file and listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-cancel-'))
  const file = join(root, 'large.json')
  const handle = await open(file, 'w')
  await handle.truncate(128 * 1024 * 1024)
  await handle.close()
  const server = await nativeServer(root)
  try {
    for (const encoding of ['identity', 'gzip']) {
      const socket = await socketTo(server.port)
      const reading = firstBytes(socket)
      socket.write(`GET /data/large.json HTTP/1.1\r\nHost: local\r\nAccept-Encoding: ${encoding}\r\n\r\n`)
      assert.match((await reading).toString(), /HTTP\/1\.1 200/)
      socket.destroy()
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const descriptors = await readdir(`/proc/${server.child.pid}/fd`)
        const paths = await Promise.all(descriptors.map((fd) => readlink(`/proc/${server.child.pid}/fd/${fd}`).catch(() => '')))
        if (!paths.includes(file)) break
        assert.ok(attempt < 49, `${encoding} cancellation retained the file`)
        await new Promise((accept) => setTimeout(accept, 20))
      }
      assert.equal((await httpRead(server.port, '/api/live')).status, 200)
    }
    await new Promise<void>((accept, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: '/data/large.json', headers: { 'accept-encoding': 'identity' } }, (response) => {
        response.once('data', () => { void truncate(file, 0).catch(reject) })
        response.on('end', () => reject(new Error('Truncated file was reported as a complete response')))
        response.on('error', () => accept())
        response.resume()
      })
      req.on('error', reject)
      req.setTimeout(5_000, () => req.destroy(new Error('Truncated response timed out')))
      req.end()
    })
    assert.equal((await httpRead(server.port, '/api/live')).status, 200)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('native forced drain of a slow body exits with failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-drain-'))
  const file = await open(join(root, 'large.json'), 'w')
  await file.truncate(128 * 1024 * 1024)
  await file.close()
  const server = await nativeServer(root)
  const socket = await socketTo(server.port)
  let closed = false
  try {
    const reading = firstBytes(socket)
    socket.write('GET /data/large.json HTTP/1.1\r\nHost: local\r\n\r\n')
    assert.match((await reading).toString(), /HTTP\/1\.1 200/)
    socket.pause()
    await server.close('SIGTERM', 1)
    closed = true
    await assert.rejects(httpRead(server.port, '/api/live'))
  } finally {
    socket.destroy()
    if (!closed) await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
