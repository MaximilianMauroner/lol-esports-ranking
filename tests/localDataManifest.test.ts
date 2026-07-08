import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { manifestWithResolvedFiles, resolveManifestFilePath } from '../scripts/local-data-manifest.js'

test('local data manifests resolve legacy and relative raw file paths under rawDir', () => {
  const rawDir = join('/workspace', 'data', 'raw')
  const manifest = manifestWithResolvedFiles({
    files: {
      oracleCsv: ['/app/data/raw/oracles/2026.csv'],
      leaguepediaJson: ['leaguepedia/scoreboard.json'],
    },
  }, rawDir)

  assert.deepEqual(manifest.files.oracleCsv, [join(rawDir, 'oracles', '2026.csv')])
  assert.deepEqual(manifest.files.leaguepediaJson, [join(rawDir, 'leaguepedia', 'scoreboard.json')])
  assert.equal(resolveManifestFilePath(join(rawDir, 'lolesports', 'schedule.json'), rawDir), join(rawDir, 'lolesports', 'schedule.json'))
})
