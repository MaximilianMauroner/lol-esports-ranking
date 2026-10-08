import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { providerDatetimeUtc } from '../src/lib/importers/providerTime'
import { buildParityFixtures } from '../scripts/parity-fixtures'

test('checked-in parity fixtures match the current byte contracts', async () => {
  const stored = JSON.parse(await readFile('tests/fixtures/parity/contracts.json', 'utf8'))
  // A difference means a contract changed. Regenerate with `pnpm run fixtures:parity`
  // only when the change is intended, because the Rust worker (#84) must follow it.
  assert.deepEqual(stored, JSON.parse(JSON.stringify(buildParityFixtures())))
})

test('provider timestamps without a zone are UTC in any process time zone', () => {
  const previous = process.env.TZ
  try {
    process.env.TZ = 'Asia/Seoul'
    assert.equal(providerDatetimeUtc('2025-01-11 17:13:25'), '2025-01-11T17:13:25.000Z')
    process.env.TZ = 'America/New_York'
    assert.equal(providerDatetimeUtc('2026-07-01 08:10:16'), '2026-07-01T08:10:16.000Z')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
