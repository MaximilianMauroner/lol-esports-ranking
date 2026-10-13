import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DataSourceInfo } from '../src/lib/snapshot.ts'
import { DataSourcesDisclosure } from '../src/views/TeamsView.tsx'

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

function renderPanel(sources: DataSourceInfo[], latestMatchDate = '2026-10-13') {
  const html = renderToStaticMarkup(createElement(DataSourcesDisclosure, {
    model,
    data: {
      sources, matchCount: 5461, coverageStart: '2025-01-12', coverageEnd: latestMatchDate, latestMatchDate,
      sourceBreakdown: [{ provider: 'oracles-elixir', matchCount: 2779 }, { provider: 'leaguepedia-cargo', matchCount: 2682 }],
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
  assert.match(text, /Oracle's Elixir Data through Oct 10, 2026 2,779/)
  assert.match(text, /Leaguepedia Data through Oct 13, 2026 2,682/)
  assert.match(text, /Oracle's Elixir could not be updated in the latest refresh\. Its data ends on Oct 10, 2026\. Later matches come from Leaguepedia\./)
})

test('a complete refresh shows source dates without a failure notice', () => {
  const { text } = renderPanel(productionSources({ oracle: 'downloaded' }))

  assert.match(text, /Oracle's Elixir Data through Oct 10, 2026/)
  assert.doesNotMatch(text, /latest refresh|Later matches/)
})

test('a failed newest provider does not claim that another provider covers later matches', () => {
  const { text } = renderPanel(productionSources({ oracle: 'downloaded', leaguepedia: 'partial' }))

  assert.match(text, /Leaguepedia was only partly updated in the latest refresh\. Its data ends on Oct 13, 2026\./)
  assert.doesNotMatch(text, /Later matches/)
  assert.doesNotMatch(text, /Oracle's Elixir (?:could not|was only)/)
})
