import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'

const binary = process.env.RANKING_RUST_TEST_BINARY

test('native fetch matches Node files and manifests on recorded paginated provider responses', { skip: !binary }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rust-fetch-parity-'))
  const requests: string[] = []
  const fields = 'OverviewPage,Team1,Team2,WinTeam,LossTeam,DateTime UTC,Patch,GameId,Team1Kills,Team2Kills,Team1Gold,Team2Gold'
  const beyondU64 = (1n << 128n) + (1n << 75n) + 1n
  const numbers = [
    ['', ' ', '0x10', '0b10'], ['0o10', '-2.5', '+3', '1e20'], ['1e-6', 'Infinity', 'NaN', 'invalid'],
    ['0x2000000000000101', `0b${0x2000000000000101n.toString(2)}`, `0o${0x2000000000000101n.toString(8)}`, '0x2000000000000100'],
    ['0x2000000000000300', `0x${beyondU64.toString(16)}`, `0b${beyondU64.toString(2)}`, '0x2_0'],
    [`0x${'f'.repeat(300)}`, '0x+20', '0b+10', '0o+20'],
  ]
  const expectedNumbers = [
    [null, 0, 16, 2], [8, -2.5, 3, 1e20], [1e-6, null, null, null],
    [2 ** 61 + 512, 2 ** 61 + 512, 2 ** 61 + 512, 2 ** 61],
    [2 ** 61 + 1024, 2 ** 128 + 2 ** 76, 2 ** 128 + 2 ** 76, null],
    [null, null, null, null],
  ]
  const csv = (count: number, offset: number) => [fields, ...Array.from({ length: count }, (_, index) => `LCK,A,B,A,B,2026-01-02 12:00:00,26.1,game-${offset + index},${numbers[(offset + index) % numbers.length].join(',')}`)].join('\n') + '\n'
  const oracleCsv = '\ufeffgameid,date,league,side\na,2026-01-01,LCK,Blue\na,2026-01-01,LCK,Red\n'
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
      response.writeHead(200, { 'content-type': 'text/csv', 'content-encoding': 'gzip' })
      response.end(gzipSync(Buffer.from(oracleCsv)))
    } else if (url.pathname === '/cargo') {
      if (JSON.stringify(url.searchParams.getAll('format')) !== '["csv"]'
        || JSON.stringify(url.searchParams.getAll('keep')) !== '["first","second"]'
        || url.searchParams.getAll('offset').length !== 1
        || !['0', '500'].includes(url.searchParams.get('offset') ?? '')) {
        response.writeHead(400).end('controlled Cargo query parameters differ')
        return
      }
      response.writeHead(200, { 'content-type': 'text/csv', 'content-encoding': 'deflate' })
      response.end(deflateSync(Buffer.from('\ufeff' + (url.searchParams.get('offset') === '0' ? csv(500, 0) : csv(1, 500)))))
    } else {
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' })
      response.end(brotliCompressSync(Buffer.from('\ufeff' + JSON.stringify(url.pathname === '/getSchedule'
        ? schedule(url.searchParams.get('pageToken'))
        : { data: { event: { id: url.searchParams.get('id'), games: [{ id: 'per-game' }] } } }))))
    }
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const manifests: unknown[] = []
    const requestTraces: string[][] = []
    for (const worker of ['node', 'rust'] as const) {
      const directory = join(root, worker)
      const flags = [
        '--start', '2026-01-01', '--end', '2026-01-03', '--out-dir', directory,
        '--oracle-csv-url', `${base}/oracle.csv`, '--oracle-drive', 'false',
        '--leaguepedia-base-url', `${base}/cargo?format=json&offset=999&keep=first&keep=second&format=xml`, '--lolesports-base-url', base,
        '--lolesports-older-pages', '1', '--lolesports-newer-pages', '1', '--lolesports-detail-limit', '1',
      ]
      const previous = requests.length
      const result = await invoke(worker, flags)
      assert.equal(result.code, 0, result.stderr)
      requestTraces.push(requests.slice(previous))
      const manifestText = await readFile(join(directory, 'manifest.json'), 'utf8')
      const manifest: { files: Record<string, string[]> } = JSON.parse(manifestText)
      manifests.push(normalize(JSON.parse(manifestText.replaceAll(directory, '<output>'))))
      for (const paths of Object.values(manifest.files)) {
        for (const path of paths) {
          const text = await readFile(path, 'utf8')
          if (path.endsWith('.csv')) {
            assert.equal(text, oracleCsv)
          } else {
            const other = join(root, 'node', path.includes('/leaguepedia/') ? 'leaguepedia' : 'lolesports', basename(path))
            if (worker === 'rust') assert.equal(JSON.stringify(normalize(JSON.parse(text)), null, 2), JSON.stringify(normalize(JSON.parse(await readFile(other, 'utf8'))), null, 2))
            if (path.includes('/leaguepedia/')) {
              const payload: { matches: Array<Record<string, unknown>> } = JSON.parse(text)
              assert.equal(payload.matches.length, 501)
              assert.deepEqual(payload.matches.slice(0, expectedNumbers.length).map(({ teamAKills, teamBKills, teamAGold, teamBGold }) =>
                [teamAKills, teamBKills, teamAGold, teamBGold]), expectedNumbers)
            }
          }
        }
      }
    }
    assert.equal(JSON.stringify(manifests[1], null, 2), JSON.stringify(manifests[0], null, 2))
    assert.deepEqual(requestTraces[1], requestTraces[0])
    assert.equal(requestTraces[0].length, 7)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('native fetch preserves optional and required failure receipts and network telemetry', { skip: !binary }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rust-fetch-failure-parity-'))
  let networkFailure = false
  const server = createServer((request, response) => {
    if (networkFailure) request.socket.destroy()
    else response.writeHead(404).end('recorded missing provider')
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    for (const scenario of [
      { provider: 'leaguepedia', required: false, network: false },
      { provider: 'leaguepedia', required: true, network: false },
      { provider: 'lolesports', required: false, network: false },
      { provider: 'lolesports', required: true, network: false },
      { provider: 'lolesports', required: false, network: true },
    ]) {
      networkFailure = scenario.network
      const manifests: unknown[] = []
      const artifacts: unknown[] = []
      for (const worker of ['node', 'rust'] as const) {
        const directory = join(root, `${scenario.provider}-${scenario.required}-${scenario.network}-${worker}`)
        const flags = ['--start', '2026-01-01', '--end', '2026-01-03', '--out-dir', directory, '--oracle', 'false',
          scenario.provider === 'leaguepedia' ? '--lolesports' : '--leaguepedia', 'false',
          scenario.provider === 'leaguepedia' ? '--leaguepedia-base-url' : '--lolesports-base-url',
          scenario.provider === 'leaguepedia' ? `${base}/cargo` : base,
          '--lolesports-older-pages', '0', '--lolesports-newer-pages', '0', '--lolesports-detail-limit', '0',
          ...(scenario.required ? [`--${scenario.provider}-required`, 'true'] : [])]
        const result = await invoke(worker, flags)
        if (scenario.required) assert.ok(result.code !== null && result.code > 0, result.stderr)
        else assert.equal(result.code, 0, result.stderr)
        const manifestText = await readFile(join(directory, 'manifest.json'), 'utf8')
        const manifest: { sources: Record<string, { status: string; failures: Array<{ error: string }> }> } = JSON.parse(manifestText)
        assert.equal(manifest.sources[scenario.provider].status, 'failed')
        assert.match(manifest.sources[scenario.provider].failures[0].error, /^node scripts\/fetch-.* exited with 1$/)
        manifests.push(normalize(JSON.parse(manifestText.replaceAll(directory, '<output>'))))
        const filename = scenario.provider === 'leaguepedia' ? 'scoreboard-games' : 'schedule'
        const artifact: { fetchTelemetry: {
          requests: number; retryCount: number;
          attempts: Array<{ attempt: number; status: number | null; retryable: boolean; reason?: string; error?: string }>;
          retries: Array<{ attempt: number; delayMs: number; reason: string }>;
        } } = JSON.parse(await readFile(join(directory, scenario.provider, `${filename}-2026-01-01_to_2026-01-03.json`), 'utf8'))
        assert.equal(artifact.fetchTelemetry.requests, scenario.network ? 5 : 1)
        assert.equal(artifact.fetchTelemetry.retryCount, scenario.network ? 4 : 0)
        assert.deepEqual(artifact.fetchTelemetry.attempts.map(({ attempt, status, retryable, reason, error }) =>
          ({ attempt, status, retryable, reason, error })), Array.from({ length: scenario.network ? 5 : 1 }, (_, index) => ({
            attempt: index + 1, status: scenario.network ? null : 404, retryable: scenario.network,
            reason: scenario.network ? 'network-error' : undefined, error: scenario.network ? 'fetch failed' : undefined,
          })))
        for (const retry of artifact.fetchTelemetry.retries) {
          const baseDelay = 500 * 2 ** (retry.attempt - 1)
          assert.ok(retry.delayMs >= baseDelay * 0.5 && retry.delayMs <= baseDelay * 1.5)
          assert.equal(retry.reason, 'network-error')
          retry.delayMs = 0 // Jitter differs; its policy bounds were checked above.
        }
        artifacts.push(normalize(artifact))
      }
      assert.deepEqual(manifests[1], manifests[0])
      assert.deepEqual(artifacts[1], artifacts[0])
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('native fetch preserves malformed compressed body failures without retries or child artifacts', { skip: !binary }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rust-fetch-body-failure-parity-'))
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/csv', 'content-encoding': 'gzip' }).end('invalid gzip body')
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    for (const provider of ['oracle', 'leaguepedia', 'lolesports'] as const) {
      for (const required of [false, true]) {
        const manifests: unknown[] = []
        for (const worker of ['node', 'rust'] as const) {
          const directory = join(root, `${provider}-${required}-${worker}`)
          const flags = ['--start', '2026-01-01', '--end', '2026-01-03', '--out-dir', directory,
            '--oracle', String(provider === 'oracle'), '--oracle-drive', 'false',
            '--leaguepedia', String(provider === 'leaguepedia'), '--lolesports', String(provider === 'lolesports'),
            '--oracle-csv-url', `${base}/oracle.csv`, '--leaguepedia-base-url', `${base}/cargo`, '--lolesports-base-url', base,
            '--lolesports-older-pages', '0', '--lolesports-newer-pages', '0', '--lolesports-detail-limit', '0',
            ...(required ? [`--${provider}-required`, 'true'] : [])]
          const previousRequests = requests
          const result = await invoke(worker, flags)
          if (required) assert.ok(result.code !== null && result.code > 0, result.stderr)
          else assert.equal(result.code, 0, result.stderr)
          assert.equal(requests - previousRequests, 1)
          const manifestText = await readFile(join(directory, 'manifest.json'), 'utf8')
          const manifest: {
            sources: Record<string, { status: string; failures: Array<{ error: string }> }>;
            fetchTelemetry: { requests: number; retryCount: number };
          } = JSON.parse(manifestText)
          assert.equal(manifest.sources[provider].status, 'failed')
          if (provider === 'oracle') assert.equal(manifest.sources[provider].failures[0].error, 'terminated')
          assert.deepEqual(manifest.fetchTelemetry, { requests: provider === 'oracle' ? 1 : 0, retryCount: 0 })
          const artifactPath = provider === 'oracle' ? join(directory, 'oracles-elixir', 'oracle.csv')
            : join(directory, provider, `${provider === 'leaguepedia' ? 'scoreboard-games' : 'schedule'}-2026-01-01_to_2026-01-03.json`)
          await assert.rejects(readFile(artifactPath), { code: 'ENOENT' })
          manifests.push(normalize(JSON.parse(manifestText.replaceAll(directory, '<output>'))))
        }
        assert.deepEqual(manifests[1], manifests[0])
      }
    }
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
  return { code, stderr: Buffer.concat(errors).toString('utf8') }
}
