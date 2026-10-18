import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { promisify } from 'node:util'
import { fixtureEnvironment, requiredBinary } from './nativeRankingOriginProcesses.ts'

test('baseline binary reports the absent native ranking origin mode', async t => {
  const binary = await requiredBinary('RANKING_NATIVE_HTTP_BINARY')
  const argv = ['--ranking-origin', '--listen', '127.0.0.1:0']
  let result: { code: number; stdout: string; stderr: string } | undefined
  try {
    await promisify(execFile)(binary.path, argv, {
      env: fixtureEnvironment(), timeout: 5_000, maxBuffer: 32_768,
    })
  } catch (error) {
    assert.ok(error && typeof error === 'object' && 'code' in error && 'stdout' in error && 'stderr' in error)
    assert.equal(typeof error.code, 'number', 'A missing binary or timeout is not the expected baseline failure')
    result = { code: Number(error.code), stdout: String(error.stdout), stderr: String(error.stderr) }
  }
  assert.ok(result && result.code !== 0, 'The absent origin mode must fail on the real baseline binary')
  assert.match(result.stderr, /expected --data-root PATH and optional unique --listen LOOPBACK:PORT/)
  t.diagnostic(JSON.stringify({ case: 'expected-absent-ranking-origin', binarySha256: binary.sha256, argv, ...result }))
})
