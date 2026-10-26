import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('research intake imports pinned bytes, resumes crashes and rejects invalid evidence', () => {
  const run = spawnSync('python3', ['-B', fileURLToPath(new URL('./fixtures/research-intake/check_intake.py', import.meta.url)),
    fileURLToPath(new URL('../tools/research/intake.py', import.meta.url))], { encoding: 'utf8' })
  process.stdout.write(run.stdout)
  process.stderr.write(run.stderr)
  assert.equal(run.status, 0, run.error?.message ?? run.stderr)
})
