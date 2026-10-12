import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

test('Vite dev server prefers a local tournament feed and otherwise serves both paths live', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lol-vite-tournament-'))
  const localDir = join(root, 'public', 'tournament-data')
  await mkdir(localDir, { recursive: true })
  await writeFile(join(localDir, 'feed.json'), '{"source":"local"}\n')
  await writeFile(join(localDir, 'feed.json.health.json'), '{"warnings":["local"]}\n')
  const realFetch = globalThis.fetch
  const sourceRequests: string[] = []
  // The live feed service runs in this process; answer its Leaguepedia checks with an empty schedule.
  globalThis.fetch = async (input) => {
    sourceRequests.push(String(input))
    return Response.json([])
  }
  const server = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
  })
  t.after(async () => {
    globalThis.fetch = realFetch
    await server.close()
    await rm(root, { recursive: true, force: true })
  })
  await server.listen()
  const address = server.httpServer?.address()
  assert.ok(address && typeof address !== 'string')
  const read = async (path: string) => (await realFetch(`http://127.0.0.1:${address.port}/tournament-data/${path}`)).json()

  assert.deepEqual(await read('feed.json'), { source: 'local' })
  assert.deepEqual(await read('feed.json.health.json'), { warnings: ['local'] })
  assert.equal(sourceRequests.length, 0)

  await rm(join(localDir, 'feed.json'))
  assert.equal((await read('feed.json')).source, 'leaguepedia-cargo')
  assert.equal((await read('feed.json.health.json')).complete, true, 'Without a local feed.json, a leftover local health file is ignored')
  assert.equal(sourceRequests.length, 1)
})
