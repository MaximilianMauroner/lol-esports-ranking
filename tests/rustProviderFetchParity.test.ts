import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

const binary = process.env.RANKING_RUST_TEST_BINARY

test('native fetch matches Node files and manifests on recorded paginated provider responses', { skip: !binary }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rust-fetch-parity-'))
  const requests: string[] = []
  const fields = 'OverviewPage,Team1,Team2,WinTeam,LossTeam,DateTime UTC,Patch,GameId,Team1Kills,Team2Kills,Team1Gold,Team2Gold'
  const csv = (count: number, offset: number) => [fields, ...Array.from({ length: count }, (_, index) => `LCK,A,B,A,B,2026-01-02 12:00:00,26.1,game-${offset + index},10,5,50000,45000`)].join('\n') + '\n'
  const event = (id: string, startTime: string) => ({ startTime, match: { id }, league: { slug: 'lck' }, blockName: 'Regular Season' })
  const schedule = (token: string | null) => ({ data: { schedule: {
    updated: '2026-01-03T00:00:00Z',
    pages: token ? { older: null, newer: null } : { older: 'older-page', newer: 'newer-page' },
    events: token === 'older-page' ? [event('old', '2026-01-01T12:00:00Z')]
      : token === 'newer-page' ? [event('new', '2026-01-03T12:00:00Z'), event('same', '2026-01-02T12:00:00Z')]
        : [event('same', '2026-01-02T12:00:00Z')],
  } } })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    requests.push(url.pathname + url.search)
    if (url.pathname === '/oracle.csv') {
      response.writeHead(200, { 'content-type': 'text/csv' })
      response.end('gameid,date,league,side\na,2026-01-01,LCK,Blue\na,2026-01-01,LCK,Red\n')
    } else if (url.pathname === '/cargo') {
      response.writeHead(200, { 'content-type': 'text/csv' })
      response.end(url.searchParams.get('offset') === '0' ? csv(500, 0) : csv(1, 500))
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(url.pathname === '/getSchedule'
        ? schedule(url.searchParams.get('pageToken'))
        : { data: { event: { id: url.searchParams.get('id'), games: [{ id: 'per-game' }] } } }))
    }
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const manifests: object[] = []
    const requestTraces: string[][] = []
    for (const worker of ['node', 'rust'] as const) {
      const directory = join(root, worker)
      const flags = [
        '--start', '2026-01-01', '--end', '2026-01-03', '--out-dir', directory,
        '--oracle-csv-url', `${base}/oracle.csv`, '--oracle-drive', 'false',
        '--leaguepedia-base-url', `${base}/cargo`, '--lolesports-base-url', base,
        '--lolesports-older-pages', '1', '--lolesports-newer-pages', '1', '--lolesports-detail-limit', '1',
      ]
      const previous = requests.length
      await invoke(worker, flags)
      requestTraces.push(requests.slice(previous))
      const manifestText = await readFile(join(directory, 'manifest.json'), 'utf8')
      const manifest: { files: Record<string, string[]> } = JSON.parse(manifestText)
      manifests.push(normalize(JSON.parse(manifestText.replaceAll(directory, '<output>'))))
      for (const paths of Object.values(manifest.files)) {
        for (const path of paths) {
          const text = await readFile(path, 'utf8')
          if (path.endsWith('.csv')) {
            assert.equal(text, 'gameid,date,league,side\na,2026-01-01,LCK,Blue\na,2026-01-01,LCK,Red\n')
          } else {
            const other = join(root, 'node', path.includes('/leaguepedia/') ? 'leaguepedia' : 'lolesports', basename(path))
            if (worker === 'rust') assert.deepEqual(normalize(JSON.parse(text)), normalize(JSON.parse(await readFile(other, 'utf8'))))
          }
        }
      }
    }
    assert.deepEqual(manifests[1], manifests[0])
    assert.deepEqual(requestTraces[1], requestTraces[0])
    assert.equal(requestTraces[0].length, 7)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!value || typeof value !== 'object') return value
  // Only wall-clock fields differ for the same recorded transport responses.
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['generatedAt', 'fetchedAt', 'startedAtMs', 'finishedAtMs', 'elapsedMs'].includes(key)).map(([key, item]) => [key, normalize(item)]))
}

async function invoke(worker: 'node' | 'rust', flags: string[]) {
  const child = spawn(worker === 'rust' ? binary! : process.execPath,
    worker === 'rust' ? ['fetch', ...flags] : ['scripts/download-local-data.mjs', ...flags], { stdio: ['ignore', 'ignore', 'pipe'] })
  const errors: Buffer[] = []
  child.stderr.on('data', (value: Buffer) => errors.push(value))
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  assert.equal(code, 0, Buffer.concat(errors).toString('utf8'))
}
