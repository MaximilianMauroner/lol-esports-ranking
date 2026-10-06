import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
      ], { env: { RANKING_BUCKET_RESTORE_RAW: 'false', RANKING_BUCKET_UPLOAD_ENABLED: 'false', RANKING_REFRESH_BOOTSTRAP_START: '2025-01-01' } })
      const source = await importRankingSourceData({ manifestPath })
      const cup = source.matches.filter((game) => game.event === event)
      assert.equal(cup.length, expectedGames)
      assert.equal(new Set(cup.map((game) => game.sourceGameId)).size, expectedGames)
      assert.equal(cup.every((game) => game.sourceUrl === baseUrl), true)
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
