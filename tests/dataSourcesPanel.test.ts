import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importRankingSourceData } from '../scripts/rankings/source-input'
import { providerFreshness } from '../src/domains/rankings/internal/evidence/sourceFreshness'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DataSourceInfo } from '../src/domains/rankings/internal/projections/snapshot.ts'
import { DataSourcesDisclosure } from '../src/views/rankings/TeamsView.tsx'

type RefreshStatus = NonNullable<DataSourceInfo['refreshReceipt']>['status']

const receipt = (status: RefreshStatus) => ({
  attemptedAt: '2026-10-13T06:02:36.613Z', requestedStart: '2025-01-01', requestedEnd: '2026-10-13', status,
  downloadedCount: status === 'failed' ? 0 : 1, reusedCount: 0, failedCount: status === 'downloaded' ? 0 : 1,
})

const oracleQuotaWarnings: DataSourceInfo['warnings'] = [
  { kind: 'download', severity: 'warning', message: 'Oracle source 2026_LoL_esports_match_data_from_OraclesElixir.csv was not downloaded: download returned HTML (Google Drive - Quota exceeded)' },
  { kind: 'download', severity: 'warning', message: 'No Oracle CSVs were downloaded. Leaguepedia remains available as the backup/gap-fill source if its download succeeded.' },
]

/** The public production manifest of Oct 13, 2026, reduced to the source entries the panel reads. */
function productionSources({ oracle = 'failed', leaguepedia = 'downloaded' }: { oracle?: RefreshStatus; leaguepedia?: RefreshStatus } = {}): DataSourceInfo[] {
  return [
    { name: 'LoL Esports schedule API: schedule-2026-10-06_to_2026-10-13.json', kind: 'official-reference', status: 'active', description: 'Schedule references.',
      retrievedAt: '2026-10-13T06:02:36.600Z', coverageStart: '2026-09-05', coverageEnd: '2026-11-14', rowCount: 413, refreshReceipt: receipt('downloaded'),
      warnings: [{ kind: 'source-policy', severity: 'warning', message: 'LoL Esports persisted APIs are public site endpoints, not a supported official data API; cache responses and keep them reference-only.' }] },
    { name: "Oracle's Elixir CSV: 2026_LoL_esports_match_data_from_OraclesElixir.csv", kind: 'game-stats', status: 'active', description: 'Oracle 2026.',
      coverageStart: '2026-01-01', coverageEnd: '2026-10-10', rowCount: 2779, refreshReceipt: receipt(oracle), warnings: oracle === 'failed' ? oracleQuotaWarnings : undefined },
    { name: "Oracle's Elixir CSV: 2025_LoL_esports_match_data_from_OraclesElixir.csv", kind: 'game-stats', status: 'active', description: 'Oracle 2025.',
      coverageStart: '2025-01-12', coverageEnd: '2025-12-29', rowCount: 2349, refreshReceipt: receipt(oracle), warnings: oracle === 'failed' ? oracleQuotaWarnings : undefined },
    { name: 'Leaguepedia Cargo: scoreboard-games-2026-10-06_to_2026-10-13.json', kind: 'match-data', status: 'active', description: 'Leaguepedia window.',
      retrievedAt: '2026-10-13T06:02:25.277Z', coverageStart: '2026-10-10', coverageEnd: '2026-10-13', rowCount: 36, refreshReceipt: receipt(leaguepedia) },
    { name: 'Leaguepedia Cargo: scoreboard-games-2025-01-01_to_2026-06-26.json', kind: 'match-data', status: 'active', description: 'Leaguepedia history.',
      retrievedAt: '2026-06-26T15:55:41.183Z', coverageStart: '2025-01-18', coverageEnd: '2026-06-14', rowCount: 282, refreshReceipt: receipt(leaguepedia) },
    { name: 'Leaguepedia Cargo API', kind: 'match-data', status: 'active', description: 'Backup and gap-fill source.' },
    { name: "Oracle's Elixir CSVs", kind: 'game-stats', status: 'active', description: 'Primary rich stats source.' },
  ]
}

// The caller passes the full manifest model, including its config hash.
const model = { name: 'Transparent Power Index', version: 'transparent-power-index-v0.2.0', configHash: 'fnv1a-5eebb6ce' }

const season2026View = [{ provider: 'oracles-elixir', matchCount: 2779 }, { provider: 'leaguepedia-cargo', matchCount: 2682 }]

function renderPanel(sources: DataSourceInfo[], sourceBreakdown = season2026View) {
  const html = renderToStaticMarkup(createElement(DataSourcesDisclosure, {
    model,
    data: {
      sources, sourceBreakdown, matchCount: sourceBreakdown.reduce((total, entry) => total + entry.matchCount, 0),
      coverageStart: '2025-01-12', coverageEnd: '2026-10-13', latestMatchDate: '2026-10-13',
    },
  }))
  const text = html.replace(/<[^>]+>/g, ' ').replaceAll('&#x27;', "'").replace(/\s+/g, ' ')
  return { html, text }
}

test('the Oracle quota failure reaches visitors as plain freshness, without operator details', () => {
  const { html, text } = renderPanel(productionSources())

  for (const operatorDetail of [/Quota exceeded/, /Google Drive/, /No Oracle CSVs/, /persisted APIs/, /schedule API/, /\.csv\b/, /\.json\b/, /fnv1a-5eebb6ce/]) {
    assert.doesNotMatch(text, operatorDetail)
  }
  assert.doesNotMatch(html, /var\(--down\)/, 'a provider failure is not an error for visitors')

  assert.match(text, /Latest match Oct 13, 2026/)
  assert.match(text, /Oracle's Elixir 2,779 games in this view Published data through Oct 10, 2026/)
  assert.match(text, /Leaguepedia 2,682 games in this view Published data through Oct 13, 2026/)
  assert.match(text, /Oracle's Elixir could not be updated in the latest refresh\. Its published data ends on Oct 10, 2026\. Later published matches come from Leaguepedia\./)
})

test('a complete refresh shows source dates without a failure notice', () => {
  const { text } = renderPanel(productionSources({ oracle: 'downloaded' }))

  assert.match(text, /Oracle's Elixir 2,779 games in this view Published data through Oct 10, 2026/)
  assert.doesNotMatch(text, /latest refresh|Later published matches/)
})

test('a failed newest provider does not claim that another provider covers later matches', () => {
  const { text } = renderPanel(productionSources({ oracle: 'downloaded', leaguepedia: 'partial' }))

  assert.match(text, /Leaguepedia was only partly updated in the latest refresh\. Its published data ends on Oct 13, 2026\./)
  assert.doesNotMatch(text, /Later published matches/)
  assert.doesNotMatch(text, /Oracle's Elixir (?:could not|was only)/)
})

test('a past-season view labels its counts as the view and keeps the refresh notice about published data', () => {
  // A past view where only Oracle's Elixir has games, rendered with the production sources.
  const { text } = renderPanel(productionSources(), [{ provider: 'oracles-elixir', matchCount: 2282 }])

  assert.match(text, /Oracle's Elixir 2,282 games in this view Published data through Oct 10, 2026/)
  assert.doesNotMatch(text, /Leaguepedia \d/, 'a provider without games in the view has no row')
  assert.match(text, /Oracle's Elixir could not be updated in the latest refresh\. Its published data ends on Oct 10, 2026\. Later published matches come from Leaguepedia\./)
})

for (const missing of ['oracle', 'leaguepedia'] as const) {
  test(`a failed ${missing} refresh with no cached files reaches the rendered panel`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'no-cache-freshness-'))
    try {
      await writeFile(join(root, 'scored.json'), JSON.stringify({ matches: [{
        id: 'game', date: '2026-10-13', event: 'LCK 2026', teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha', bestOf: 1,
      }] }))
      await writeFile(join(root, 'scored.csv'), [
        'gameid,date,year,league,split,playoffs,position,side,teamname,result,kills,totalgold',
        'game,2026-10-13,2026,LCK,,0,team,blue,Alpha,1,18,62000',
        'game,2026-10-13,2026,LCK,,0,team,red,Beta,0,12,59000',
      ].join('\n'))
      const manifestPath = join(root, 'manifest.json')
      await writeFile(manifestPath, JSON.stringify({
        start: '2026-10-06', end: '2026-10-13', generatedAt: '2026-10-13T06:02:36.613Z',
        files: { oracleCsv: missing === 'oracle' ? [] : ['scored.csv'], leaguepediaJson: missing === 'leaguepedia' ? [] : ['scored.json'] },
        sources: { oracle: { status: missing === 'oracle' ? 'failed' : 'downloaded', failedCount: missing === 'oracle' ? 1 : 0 },
          leaguepedia: { status: missing === 'leaguepedia' ? 'failed' : 'downloaded', failedCount: missing === 'leaguepedia' ? 1 : 0 } },
        warnings: [`${missing} failed: private-file.csv Google Drive Quota exceeded`],
      }))
      const data = await importRankingSourceData({ manifestPath })
      const label = missing === 'oracle' ? "Oracle's Elixir" : 'Leaguepedia'
      const source = data.externalSources.find((entry) => entry.refreshReceipt?.status === 'failed')
      assert.ok(source, 'keep the failed refresh receipt even without cached files')
      assert.equal(source.status, 'reference-only')
      assert.equal(source.rowCount, 0)
      assert.equal(source.coverageStart, undefined)
      assert.equal(source.coverageEnd, undefined)
      assert.equal(source.retrievedAt, undefined)
      const breakdown = [{ provider: missing === 'oracle' ? 'leaguepedia-cargo' : 'oracles-elixir', matchCount: data.matches.length }]
      assert.equal(data.matches.length, 1)
      const freshness = providerFreshness(breakdown, data.externalSources).find((entry) => entry.label === label)
      assert.deepEqual(freshness, { label, matchCount: 0, publishedThrough: undefined, failedUpdate: 'failed' })
      const { text } = renderPanel(data.externalSources, breakdown)
      assert.ok(text.includes(`${label} could not be updated in the latest refresh.`))
      assert.doesNotMatch(text, /private-file|Quota exceeded|Google Drive|\.csv\b|\.json\b/)
      assert.doesNotMatch(text, /Its published data ends|Later published matches/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
