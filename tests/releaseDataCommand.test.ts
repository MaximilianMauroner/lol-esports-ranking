import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { PUBLIC_ARTIFACT_FIXTURE_DIR } from './fixtures/publicArtifactBundle.ts'

const run = promisify(execFile)

test('release-data gate fails clearly without materialized input and validates an explicit fixture profile', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'ranking-release-empty-'))
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  try {
    await assert.rejects(run('pnpm', ['run', 'test:release-data'], {
      cwd: process.cwd(),
      env: { ...childEnv, RANKING_RELEASE_DATA_DIR: empty, RANKING_RELEASE_DATA_ALLOW_FIXTURE: '' },
    }), (error) => commandErrorOutput(error).includes('Release data is unavailable'))
    await run('pnpm', ['run', 'test:release-data'], {
      cwd: process.cwd(),
      env: {
        ...childEnv,
        RANKING_RELEASE_DATA_DIR: PUBLIC_ARTIFACT_FIXTURE_DIR,
        RANKING_RELEASE_DATA_ALLOW_FIXTURE: 'true',
      },
    })
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

function commandErrorOutput(error: unknown) {
  if (!(error instanceof Error)) return ''
  const result = error as Error & { stdout?: string; stderr?: string }
  return `${result.message}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
}
