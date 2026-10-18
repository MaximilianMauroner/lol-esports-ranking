import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
assert.ok(args.length === 2 && args[0] === '--suite' && ['fixture', 'baseline', 'corpus'].includes(args[1]),
  'Expected --suite fixture, baseline, or corpus')

const files = {
  fixture: ['tests/nativeRankingOriginHarness.test.ts', 'tests/nativeRankingOriginHarness.integration.ts'],
  baseline: ['tests/nativeRankingOriginBaseline.integration.ts'],
  corpus: ['tests/nativeRankingOriginCorpus.integration.ts'],
}
const selected = files[args[1] as keyof typeof files]
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...selected], {
  cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: ['ignore', 'pipe', 'inherit'],
})
let tail = ''
child.stdout.on('data', chunk => {
  tail = (tail + chunk.toString()).slice(-8192)
  process.stdout.write(chunk)
})
const interrupt = () => child.kill('SIGINT')
const terminate = () => child.kill('SIGTERM')
process.once('SIGINT', interrupt)
process.once('SIGTERM', terminate)
const code = await new Promise<number>((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1))
})
process.off('SIGINT', interrupt)
process.off('SIGTERM', terminate)
if (code === 0) {
  assert.ok(Number(tail.match(/^# tests (\d+)$/m)?.[1]) > 0, 'A proof must execute at least one test')
  for (const field of ['skipped', 'cancelled', 'todo']) assert.match(tail, new RegExp(`^# ${field} 0$`, 'm'))
}
process.exitCode = code
