import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { transparentGprModelMetadata } from '../src/lib/modelConfig'

const binary = process.argv[2] ?? 'worker/target/debug/ranking-refresh'
const result = spawnSync(binary, ['contracts'], { encoding: 'utf8' })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(result.stderr || `Rust contracts exited ${result.status}`)
const rust: unknown = JSON.parse(result.stdout)
assert.deepEqual(rust, {
  modelVersion: transparentGprModelMetadata.version,
  modelConfigHash: transparentGprModelMetadata.configHash,
  parameters: transparentGprModelMetadata.parameters,
})
console.log(`Rust and TypeScript model parameters and ${transparentGprModelMetadata.configHash} match`)
