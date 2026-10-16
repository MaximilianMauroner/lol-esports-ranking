import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const [path, label] = process.argv.slice(2)
const d = readFileSync(path, 'utf8'); const b = d.indexOf('const pause = '); const e = d.indexOf('\nasync function barrier()', b)
const src = d.slice(b, e)
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const results = []; let fail = 0
async function run(ms, policy, name) {
  let now = 7_000_000_000_000n; const entry = now; const timers = []; let done = false; let earlyResolve = false
  const pause = vm.runInNewContext(`${src}\npause`, { process: { hrtime: { bigint: () => now } }, setTimeout: (cb, t) => timers.push({ cb, ns: BigInt(Math.round(Math.max(t, 0) * 1e6)) }) })
  pause(ms).then(() => { done = true })
  let n = 0
  while (!done && n < 64) {
    if (timers.length !== 1) { results.push({ name, ms, error: `timers=${timers.length}` }); fail++; return }
    const { cb, ns } = timers.shift(); const adv = policy(n, ns); now += adv; cb(); n++
    for (let k = 0; k < 8; k++) await Promise.resolve()
    if (done && now - entry < BigInt(ms) * 1_000_000n) earlyResolve = true
  }
  const elapsed = now - entry; const ok = done && !earlyResolve && elapsed >= BigInt(ms) * 1_000_000n
  if (!ok) fail++
  results.push({ name, ms, callbacks: n, elapsedNs: String(elapsed), done, ok })
}
for (const ms of [3000, 100, 50]) {
  await run(ms, (n, ns) => ns, 'exact-full')
  await run(ms, (n, ns) => ns - 1n > 0n ? ns - 1n : 1n, 'always-1ns-short')
  await run(ms, (n, ns) => (ns > 2_000_000n ? ns - 1_999_999n : (ns > 1n ? ns / 2n : 1n)), 'up-to-2ms-early-then-halving')
  await run(ms, (n, ns) => { const a = BigInt(Math.floor(Number(ns) * (0.5 + rnd() * 0.5))); return a > 0n ? a : 1n }, 'seeded-random-early')
  await run(ms, (n, ns) => ns + 5_000_000n, 'overshoot-5ms')
}
console.log(JSON.stringify({ label: `PURE FAKE CLOCK independent reviewer check (${label})`, path, extracted: src, results, fail }))
process.exitCode = fail ? 1 : 0
