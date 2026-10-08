import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { createProviderFetchTelemetry, fetchWithRetry } from '../scripts/provider-fetch-retry.mjs'

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

test('failure headers are classified without waiting for Oracle or LoL bodies', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'rust-fetch-failure-headers-parity-'))
  const oracleCsv = 'gameid,date,league,side\nheader-retry,2026-01-02,LCK,Blue\nheader-retry,2026-01-02,LCK,Red\n'
  try {
    for (const provider of ['oracle', 'lolesports'] as const) {
      for (const status of [404, 429, 503]) {
        await context.test(`${provider} HTTP ${status}`, async (scenario) => {
          let requestStatuses: number[] = []
          // Give each scenario a new origin so a destroyed pending response cannot
          // leave a stale connection in the shared Node fetch pool for the next one.
          const server = createServer((_request, response) => {
            if (requestStatuses.length === 0) {
              requestStatuses.push(status)
              response.writeHead(status, { 'content-length': '100', connection: 'close' })
              response.flushHeaders() // Leave the promised failure body pending.
              return
            }
            requestStatuses.push(200)
            response.writeHead(200, { 'content-type': provider === 'oracle' ? 'text/csv' : 'application/json', connection: 'close' })
            response.end(provider === 'oracle' ? oracleCsv : JSON.stringify({
              data: { schedule: { updated: '2026-01-03T00:00:00Z', pages: { older: null, newer: null }, events: [] } },
            }))
          })
          try {
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
            const address = server.address()
            assert.ok(address && typeof address === 'object')
            const base = `http://127.0.0.1:${address.port}`
            const telemetry = createProviderFetchTelemetry()
            const responses: Response[] = []
            let referenceBody = ''
            let referenceStatus = ''
            // The helper establishes header policy directly. Complete-body CLI
            // replays above cover artifact parity; unread Node bodies can keep a CLI alive.
            try {
              const response = await fetchWithRetry(`${base}/${provider === 'oracle' ? 'oracle.csv' : 'getSchedule'}`, {
                signal: AbortSignal.timeout(8000),
              }, {
                telemetry,
                fetcher: async (input, init) => {
                  const response = await fetch(input, init)
                  responses.push(response)
                  return response
                },
              })
              referenceStatus = response.ok ? 'downloaded' : 'failed'
              if (response.ok) referenceBody = await response.text()
              assert.deepEqual(requestStatuses, status === 404 ? [404] : [status, 200])
              assert.equal(telemetry.requests, status === 404 ? 1 : 2, JSON.stringify({ url: base, attempts: telemetry.attempts, retries: telemetry.retries }))
              assert.equal(telemetry.retries.length, status === 404 ? 0 : 1)
              assert.deepEqual(telemetry.attempts.map(({ status, retryable, reason }) =>
                ({ status, retryable, reason })), status === 404
                ? [{ status, retryable: false, reason: undefined }]
                : [{ status, retryable: true, reason: `http-${status}` }, { status: 200, retryable: false, reason: undefined }])
            } finally {
              const cancellations = responses.map((response) => response.body?.cancel().catch(() => {}))
              server.closeAllConnections()
              await Promise.all(cancellations)
            }
            if (status !== 404) {
              assert.equal(telemetry.retries[0].reason, `http-${status}`)
              assert.ok(telemetry.retries[0].delayMs >= 250 && telemetry.retries[0].delayMs <= 750)
              if (provider === 'oracle') assert.equal(referenceBody, oracleCsv)
              else {
                const schedule: { data: { schedule: { events: unknown[] } } } = JSON.parse(referenceBody)
                assert.deepEqual(schedule.data.schedule.events, [])
              }
            }
            await scenario.test('native CLI matches the header reference', {
              skip: !binary || process.platform === 'win32',
            }, async () => {
              requestStatuses = []
              const directory = join(root, `${provider}-${status}-rust`)
              const flags = ['--start', '2026-01-01', '--end', '2026-01-03', '--out-dir', directory,
                '--oracle', String(provider === 'oracle'), '--oracle-drive', 'false', '--leaguepedia', 'false',
                '--lolesports', String(provider === 'lolesports'), '--oracle-csv-url', `${base}/oracle.csv`,
                '--lolesports-base-url', base, '--lolesports-older-pages', '0', '--lolesports-newer-pages', '0',
                '--lolesports-detail-limit', '0']
              const result = await invoke('rust', flags, 8000)
              assert.equal(result.code, 0, result.stderr)
              assert.deepEqual(requestStatuses, telemetry.attempts.map(({ status }) => status))
              const manifest: {
                files: { oracleCsv: string[]; lolEsportsJson: string[] };
                sources: Record<string, { status: string }>;
                fetchTelemetry: { requests: number; retryCount: number };
              } = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
              assert.equal(manifest.sources[provider].status, referenceStatus)
              assert.deepEqual(manifest.fetchTelemetry, { requests: telemetry.requests, retryCount: telemetry.retries.length })
              if (status !== 404) {
                if (provider === 'oracle') assert.equal(await readFile(manifest.files.oracleCsv[0], 'utf8'), referenceBody)
                else {
                  const schedule: { data: { schedule: { events: unknown[] } } } = JSON.parse(referenceBody)
                  const payload: { events: unknown[]; fetchTelemetry: {
                    attempts: Array<{ status: number; retryable: boolean; reason?: string }>;
                    retries: Array<{ reason: string; delayMs: number }>;
                  } } = JSON.parse(await readFile(manifest.files.lolEsportsJson[0], 'utf8'))
                  assert.deepEqual(payload.events, schedule.data.schedule.events)
                  assert.deepEqual(payload.fetchTelemetry.attempts.map(({ status, retryable, reason }) =>
                    ({ status, retryable, reason })), telemetry.attempts.map(({ status, retryable, reason }) =>
                    ({ status, retryable, reason })))
                  assert.equal(payload.fetchTelemetry.retries[0].reason, telemetry.retries[0].reason)
                  assert.ok(payload.fetchTelemetry.retries[0].delayMs >= 250 && payload.fetchTelemetry.retries[0].delayMs <= 750)
                }
              }
              server.closeAllConnections()
            })
          } finally {
            server.closeAllConnections()
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
          }
        })
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!value || typeof value !== 'object') return value
  // Only wall-clock fields differ for the same recorded transport responses.
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['generatedAt', 'fetchedAt', 'startedAtMs', 'finishedAtMs', 'elapsedMs'].includes(key)).map(([key, item]) => [key, normalize(item)]))
}

async function invoke(worker: 'node' | 'rust', flags: string[], timeoutMs?: number) {
  const processGroup = timeoutMs !== undefined && process.platform !== 'win32'
  const child = spawn(worker === 'rust' ? binary! : process.execPath,
    worker === 'rust' ? ['fetch', ...flags] : ['scripts/download-local-data.mjs', ...flags], {
      stdio: ['ignore', 'ignore', 'pipe'], detached: processGroup,
    })
  const errors: Buffer[] = []
  child.stderr.on('data', (value: Buffer) => errors.push(value))
  let timedOut = false
  const deadline = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true
    try {
      if (processGroup && child.pid) process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }, timeoutMs)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    const stderr = Buffer.concat(errors).toString('utf8')
    assert.equal(timedOut, false, `${worker} provider command exceeded ${timeoutMs}ms: ${stderr}`)
    return { code, stderr }
  } finally {
    clearTimeout(deadline)
  }
}
