import assert from 'node:assert/strict'
import test from 'node:test'
import { retainedOriginCorpus } from './nativeRankingOriginCorpus.ts'

test('retained origin input matches its pinned aggregate and public provenance', async t => {
  const directory = process.env.RANKING_ORIGIN_TEST_RETAINED_DIR
  assert.ok(directory, 'RANKING_ORIGIN_TEST_RETAINED_DIR is required; this check never downloads data')
  t.diagnostic(JSON.stringify(await retainedOriginCorpus(directory)))
})
