import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const callSites = [
  'scripts/download-local-data.mjs',
  'scripts/fetch-leaguepedia.mjs',
  'scripts/fetch-lolesports-schedule.mjs',
  'scripts/fetch-riot-gpr-snapshot.mjs',
  'scripts/lolesports-schedule-probe.mjs',
]

test('every scored-provider and schedule call site uses the shared request retry helper', async () => {
  for (const path of callSites) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.match(source, /from ['"].\/provider-fetch-retry\.mjs['"]/)
    assert.match(source, /\bfetchWithRetry\s*\(/)
  }
})
