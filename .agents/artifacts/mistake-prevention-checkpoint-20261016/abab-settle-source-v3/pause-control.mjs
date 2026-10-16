import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const [side, scenario] = process.argv.slice(2)
assert.ok(['old', 'new'].includes(side))
assert.ok(['early-0.507ms', 'full-interval', 'repeated-early'].includes(scenario))
const driverPath = side === 'old'
  ? '/home/codex/.local/state/pstack/mistake-prevention-20261015/max-update/r3-abab-attempts-fix-v2/abab-driver.mjs'
  : fileURLToPath(new URL('./abab-driver.mjs', import.meta.url))
const driver = readFileSync(driverPath, 'utf8')
const begin = driver.indexOf('const pause = ')
const end = driver.indexOf('\nasync function barrier()', begin)
assert.ok(begin >= 0 && end > begin && driver.indexOf('const pause = ', begin + 1) === -1)
const source = driver.slice(begin, end)
const hash = (body) => createHash('sha256').update(body).digest('hex')
const entry = 9_000_000_000_000_000n
let now = entry
let settled = false
const timers = []
const callbacks = []
const pause = vm.runInNewContext(`${source}\npause`, {
  process: { hrtime: { bigint: () => now } },
  setTimeout: (callback, ms) => {
    assert.ok(Number.isFinite(ms) && ms > 0 && ms <= 3000)
    timers.push({ callback, requestedNs: BigInt(Math.round(ms * 1_000_000)) })
  },
}, { timeout: 1000 })
const completion = pause(3000).then(() => { settled = true })
for (let index = 0; !settled && index < 16; index++) {
  assert.equal(timers.length, 1, 'one pending timer')
  const { callback, requestedNs } = timers.shift()
  const repeated = [2_999_493_000n, 100_000n, 100_000n, 100_000n, 100_000n, 106_999n, 1n]
  const advance = scenario === 'repeated-early' ? repeated[index]
    : scenario === 'early-0.507ms' && index === 0 ? requestedNs - 507_000n : requestedNs
  assert.ok(typeof advance === 'bigint' && advance > 0n && advance <= requestedNs, 'bounded fake clock advance')
  now += advance
  callback()
  for (let tick = 0; tick < 8; tick++) await Promise.resolve()
  callbacks.push({ requestedNs: String(requestedNs), advanceNs: String(advance), elapsedNs: String(now - entry), settled })
  if (side === 'new' && now - entry < 3_000_000_000n) assert.equal(settled, false, 'cannot finish before minimum')
}
assert.equal(settled, true, 'bounded timer sequence must complete')
await completion
assert.equal(timers.length, 0)
const elapsed = now - entry
const pass = elapsed >= 3_000_000_000n
console.log(JSON.stringify({ label: 'PURE FAKE CLOCK CONTROL. No runtime measurement.', side, scenario, driverPath, driverSha256: hash(driver), extractedPauseSource: source, extractedPauseSha256: hash(source), controlSha256: hash(readFileSync(fileURLToPath(import.meta.url))), entryNs: String(entry), elapsedNs: String(elapsed), elapsedMs: Number(elapsed) / 1_000_000, minimumNs: '3000000000', callbacks, verdict: pass ? 'PASS' : 'FAIL', evidenceLabel: pass ? `${side}-green` : `${side}-red` }))
process.exitCode = pass ? 0 : 1
