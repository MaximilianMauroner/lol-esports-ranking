import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { promisify } from 'node:util'
import { providerDate, providerDatetimeUtc } from '../src/lib/importers/providerTime'
import { buildParityFixtures } from '../scripts/parity-fixtures'

const exec = promisify(execFile)

test('checked-in parity fixtures match the current byte contracts', async () => {
  const stored = JSON.parse(await readFile('tests/fixtures/parity/contracts.json', 'utf8'))
  // A difference means a contract changed. Regenerate with `pnpm run fixtures:parity`
  // only when the change is intended, because the Rust worker (#84) must follow it.
  assert.deepEqual(stored, JSON.parse(JSON.stringify(buildParityFixtures())))
})

test('lowercase zone-less provider timestamps preserve UTC clocks and low years', () => {
  assert.equal(providerDatetimeUtc('2025-01-11t17:13'), '2025-01-11T17:13:00.000Z')
  assert.equal(providerDatetimeUtc('2025-01-11t17:13:25'), '2025-01-11T17:13:25.000Z')
  assert.equal(providerDatetimeUtc('2025-01-11t17:13:25.123456789'), '2025-01-11T17:13:25.123Z')
  for (const year of ['0000', '0001', '0012', '0050', '0099']) {
    assert.equal(providerDatetimeUtc(`${year}-02-03t00:00:00`), `${year}-02-03T00:00:00.000Z`)
  }
  assert.equal(providerDatetimeUtc('2025-01-11t17:13:25z'), '2025-01-11T17:13:25.000Z')
  assert.equal(providerDatetimeUtc('2025-01-11t17:13:25+09:00'), '2025-01-11T08:13:25.000Z')
})

test('malformed provider dates use ten UTF-16 units and replace only lone surrogates', () => {
  assert.equal(providerDate('🙂🙂🙂🙂🙂🙂'), '🙂🙂🙂🙂🙂')
  assert.equal(providerDate('abcdefghi🙂'), 'abcdefghi\ufffd')
  assert.equal(providerDate('abcdefgh🙂tail'), 'abcdefgh🙂')
  assert.equal(providerDate('é🙂🙂🙂🙂🙂tail'), 'é🙂🙂🙂🙂\ufffd')
  // Lone input units stay outside JSON golden inputs because Rust strings require Unicode scalars.
  assert.equal(providerDate('abc\ud800def'), 'abc\ufffddef')
  assert.equal(providerDate('2025-01-11T17:13:25Z'), '2025-01-11')
})

test('provider timestamp fixtures agree in fresh UTC and non-UTC processes', async () => {
  const stored = JSON.parse(await readFile('tests/fixtures/parity/contracts.json', 'utf8'))
  const fixtureUrl = new URL('../scripts/parity-fixtures.ts', import.meta.url).href
  for (const timezone of ['UTC', 'Asia/Seoul', 'America/New_York']) {
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { buildParityFixtures } from ${JSON.stringify(fixtureUrl)}
      console.log(JSON.stringify(buildParityFixtures().providerTime))
    `], { env: { ...process.env, TZ: timezone } })
    assert.deepEqual(JSON.parse(stdout), stored.providerTime, timezone)
  }
})
