import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import fixture from './fixtures/demaciaCup2026.json' with { type: 'json' }
import { importRankingSourceData } from '../scripts/ranking-source-import.ts'
import { createMatchHistoryArtifacts, createStaticRankingData } from '../src/lib/snapshot.ts'
const refreshScriptPath: string = '../scripts/refresh-data-if-changed.mjs'
const { refreshDataIfChanged }: {
  refreshDataIfChanged: (args: string[], options: { env: Record<string, string> }) => Promise<unknown>
} = await import(refreshScriptPath)

const event = '2026 Demacia Cup Global Invitational'

test('dedicated provider children run with an empty PATH and retain failure diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-empty-path-'))
  let fail = false
  const requests: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    requests.push(url.pathname)
    if (fail) response.writeHead(404, { connection: 'close' }).end('missing provider')
    else if (url.pathname === '/cargo') response.writeHead(200, { 'content-type': 'text/csv', connection: 'close' }).end('OverviewPage,Team1,Team2,WinTeam,LossTeam,DateTime UTC,Patch,GameId,Team1Kills,Team2Kills,Team1Gold,Team2Gold\n')
    else response.writeHead(200, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ data: { schedule: { pages: {}, events: [] } } }))
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    for (const provider of ['both', 'leaguepedia', 'lolesports'] as const) {
      for (const required of provider === 'both' ? [false] : [false, true]) {
        fail = provider !== 'both'
        const output = join(directory, `${provider}-${required}`)
        const flags = ['--start', '2026-01-01', '--end', '2026-01-01', '--out-dir', output,
          '--oracle', 'false', '--leaguepedia-base-url', `${base}/cargo`, '--lolesports-base-url', base,
          '--lolesports-older-pages', '0', '--lolesports-newer-pages', '0', '--lolesports-detail-limit', '0',
          ...(provider === 'leaguepedia' ? ['--lolesports', 'false'] : []),
          ...(provider === 'lolesports' ? ['--leaguepedia', 'false'] : []),
          ...(required ? [`--${provider}-required`, 'true'] : [])]
        const child = spawn(process.execPath, ['scripts/download-local-data.mjs', ...flags], {
          env: { ...process.env, PATH: '' }, stdio: ['ignore', 'ignore', 'pipe'],
        })
        const stderr: Buffer[] = []
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', resolve)
        })
        const diagnostics = Buffer.concat(stderr).toString('utf8')
        const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
        if (provider === 'both') {
          assert.equal(code, 0, diagnostics)
          assert.equal(manifest.sources.leaguepedia.status, 'downloaded', diagnostics)
          assert.equal(manifest.sources.lolesports.status, 'downloaded', diagnostics)
          assert.equal(manifest.files.leaguepediaJson.length, 1)
          assert.equal(manifest.files.lolEsportsJson.length, 1)
        } else {
          if (required) assert.ok(code !== null && code > 0, diagnostics)
          else assert.equal(code, 0, diagnostics)
          assert.equal(manifest.sources[provider].status, 'failed')
          const script = provider === 'leaguepedia' ? 'fetch-leaguepedia' : 'fetch-lolesports-schedule'
          assert.ok(manifest.sources[provider].failures[0].error.startsWith(`node scripts/${script}.mjs `))
          assert.match(manifest.sources[provider].failures[0].error, / exited with 1$/)
          assert.match(diagnostics, /HTTP 404/)
        }
      }
    }
    assert.deepEqual(requests, ['/cargo', '/getSchedule', '/cargo', '/cargo', '/getSchedule', '/getSchedule'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('scheduled date-window downloads retain a new tournament across refreshes without manual inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automatic-tournament-'))
  const rawDir = join(directory, 'raw')
  const manifestPath = join(rawDir, 'manifest.json')
  const requests: URL[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    requests.push(url)
    const range = [...(url.searchParams.get('where') ?? '').matchAll(/"(\d{4}-\d{2}-\d{2}) /g)].map((match) => match[1])
    const rows = [...fixture.domesticEvidence, ...fixture.matches].filter((game) => game.date >= range[0] && game.date <= range[1])
    const csv = rows.map((game) => [
      game.event, game.teamA, game.teamB, game.winner, game.winner === game.teamA ? game.teamB : game.teamA,
      'datetimeUtc' in game ? game.datetimeUtc : `${game.date} 12:00:00`, game.patch, game.id,
      'teamAKills' in game ? game.teamAKills : '', 'teamBKills' in game ? game.teamBKills : '',
      'teamAGold' in game ? game.teamAGold : '', 'teamBGold' in game ? game.teamBGold : '',
    ].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
    response.writeHead(200, { 'content-type': 'text/csv' })
    response.end(['OverviewPage,Team1,Team2,WinTeam,LossTeam,DateTime UTC,Patch,GameId,Team1Kills,Team2Kills,Team1Gold,Team2Gold', ...csv].join('\n'))
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const baseUrl = `http://127.0.0.1:${address.port}/wiki/Special:CargoExport`
    for (const [end, expectedGames] of [
      ['2026-10-03', 6],
      ['2026-10-06', 27],
    ] as const) {
      await refreshDataIfChanged(['--raw-dir', rawDir, '--manifest', manifestPath,
        '--staging-dir', join(directory, 'staging'), '--lookback-days', '3', '--end', end, '--skip-crunch',
        '--oracle', 'false', '--lolesports', 'false', '--leaguepedia-base-url', baseUrl,
      ], { env: { PATH: '', RANKING_BUCKET_RESTORE_RAW: 'false', RANKING_BUCKET_UPLOAD_ENABLED: 'false', RANKING_REFRESH_BOOTSTRAP_START: '2025-01-01' } })
      const source = await importRankingSourceData({ manifestPath })
      const cup = source.matches.filter((game) => game.event === event)
      assert.equal(cup.length, expectedGames)
      assert.equal(new Set(cup.map((game) => game.sourceGameId)).size, expectedGames)
      assert.equal(cup.every((game) => game.sourceUrl === baseUrl), true)
      const leaguepediaSources = source.externalSources.filter((entry) => entry.kind === 'match-data')
      assert.equal(leaguepediaSources.length, expectedGames === 6 ? 1 : 2)
      // Each retained game contributes to one source after overlapping downloads reconcile.
      assert.deepEqual(leaguepediaSources.map((entry) => entry.rowCount).sort((left, right) => (left ?? 0) - (right ?? 0)),
        expectedGames === 6 ? [fixture.domesticEvidence.length + 6] : [fixture.domesticEvidence.length, 27])
      assert.deepEqual(leaguepediaSources.map((entry) => entry.coverageEnd).sort(),
        expectedGames === 6 ? [end] : [fixture.domesticEvidence.map((game) => game.date).sort().at(-1), end])
      const data = createStaticRankingData({ ...source, rosters: {}, generatedAt: `${end}T18:00:00.000Z` })
      const history = createMatchHistoryArtifacts(data)
      const expectedSeries = expectedGames === 6 ? 6 : 15
      for (const key of ['All__All__All', '2026__All__All']) {
        const series = history.catalogs[key].series.filter((row) => row.event === event)
        assert.equal(series.length, expectedSeries)
        assert.equal(series.reduce((sum, row) => sum + row.gameCount, 0), expectedGames)
        const games = Object.values(history.pages[key]).flatMap((page) => page.matches).filter((game) => game.event === event)
        assert.equal(games.filter((game) => game.impact.unit === 'series-applied').length, expectedSeries)
      }
    }
    assert.equal(requests.every((url) => url.searchParams.get('tables') === 'ScoreboardGames'), true)
    assert.equal(requests.every((url) => !url.searchParams.get('where')?.includes('Demacia')), true)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('source coverage excludes discarded duplicate metadata and team identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tournament-source-coverage-'))
  try {
    const retainedPath = join(directory, 'retained.json')
    const duplicatesPath = join(directory, 'duplicates.json')
    const first = fixture.matches[0]
    await writeFile(retainedPath, JSON.stringify({ ...fixture, matches: [...fixture.domesticEvidence, ...fixture.matches] }))
    await writeFile(duplicatesPath, JSON.stringify({ ...fixture, matches: [
      // Discarded domestic metadata must not become evidence for the canonical cup games.
      { ...fixture.domesticEvidence[0], teamAHomeLeague: 'LCK CL', teamBHomeLeague: 'LCK CL' },
      { ...first, teamA: first.teamB, teamB: first.teamA },
      { ...fixture.matches[1], teamAHomeLeague: 'LCK CL' },
      { ...fixture.matches[2], teamA: 'Unrelated Coverage Team A', teamB: 'Unrelated Coverage Team B' },
    ] }))
    const source = await importRankingSourceData({ leaguepediaJsonPaths: [retainedPath, duplicatesPath] })
    assert.equal(source.matches.length, fixture.domesticEvidence.length + fixture.matches.length)
    assert.equal(source.matches.filter((game) => game.event === event).length, 27)
    const sources = source.externalSources.filter((entry) => entry.kind === 'match-data')
    assert.deepEqual(sources.map((entry) => entry.rowCount), [39, 0])
    assert.deepEqual(sources.map((entry) => entry.coverageEnd), ['2026-10-06', undefined])
    assert.equal(sources[1].status, 'reference-only')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
